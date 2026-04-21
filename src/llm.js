import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { logger } from './logger.js';
import { register } from './debug-registry.js';
import { LLMError, LLMTransientError, LLMTimeoutError, LLMProcessError, LLMValidationError, LLMAbortError, isTransient } from './llm-errors.js';
import { ACPClient } from './llm-acp.js';
export { LLMError, LLMTransientError, LLMTimeoutError, LLMProcessError, LLMValidationError, LLMAbortError, isTransient };

const log = logger.child('llm');

let clientSingleton = null;
let resolvedBin = null;

const state = { inflight: 0, completed: 0, failed: 0, retries: 0, timeouts: 0 };
register('llm', () => ({ ...state, bin: resolvedBin }));

function scrubEnv() {
  const out = {};
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
  for (const k of keep) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}

function resolveClaudeBin() {
  if (resolvedBin) return resolvedBin;
  const override = process.env.BUNGRAPH_CLAUDE_BIN;
  if (override) {
    if (!existsSync(override)) throw new LLMProcessError(`BUNGRAPH_CLAUDE_BIN set to ${override} but file does not exist`);
    resolvedBin = override;
    return resolvedBin;
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['claude'], { encoding: 'utf8', shell: false });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && existsSync(first)) { resolvedBin = first; return resolvedBin; }
  }
  resolvedBin = 'claude';
  return resolvedBin;
}

function envInt(name, dflt) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : dflt; }

function jitteredBackoff(attempt) {
  const base = 500 * Math.pow(2, attempt);
  const cap = envInt('BUNGRAPH_LLM_BACKOFF_CAP_MS', 20_000);
  const d = Math.min(base, cap);
  return d * (0.5 + Math.random() * 0.5);
}

function classifyTransient(code, stderr) {
  if (code === 1 && /rate|overload|timeout|network|ECONNRESET|ETIMEDOUT|529|503|408|UND_ERR_SOCKET/i.test(stderr)) return true;
  return false;
}

export class LLMClient {
  constructor() { this.bin = resolveClaudeBin(); }

  async generate(system, user, opts = {}) {
    const maxAttempts = opts.maxAttempts || envInt('BUNGRAPH_LLM_MAX_ATTEMPTS', 5);
    const timeoutMs = opts.timeoutMs || envInt('BUNGRAPH_LLM_TIMEOUT_MS', 60_000);
    const signal = opts.signal || null;
    const fullPrompt = system
      ? `${system}\n\n---\n\n${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`
      : `${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`;

    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) throw new LLMAbortError('aborted before attempt');
      state.inflight++;
      try {
        const text = await this.callClaude(fullPrompt, timeoutMs, signal);
        if (process.env.BUNGRAPH_DEBUG_LLM) log.debug('raw', { len: text.length, preview: text.slice(0, 200) });
        const parsed = this.parseJson(text);
        if (parsed) { state.completed++; return parsed; }
        lastErr = new LLMValidationError(`LLM returned non-JSON (len=${text.length})`);
        log.warn('non-json', { attempt: attempt + 1, max: maxAttempts });
      } catch (e) {
        lastErr = e;
        if (e instanceof LLMAbortError) throw e;
        if (!isTransient(e)) { state.failed++; throw e; }
        if (e instanceof LLMTimeoutError) state.timeouts++;
        log.warn('transient', { err: e.name, msg: e.message.slice(0, 180), attempt: attempt + 1, max: maxAttempts });
      } finally {
        state.inflight--;
      }
      if (attempt < maxAttempts - 1) {
        state.retries++;
        await new Promise(r => setTimeout(r, jitteredBackoff(attempt)));
      }
    }
    state.failed++;
    throw lastErr || new LLMValidationError('LLM failed to return JSON after retries');
  }

  callClaude(prompt, timeoutMs, extSignal) {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--disable-slash-commands', '--permission-mode', 'bypassPermissions'];
      const ctrl = new AbortController();
      const proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: scrubEnv(), shell: false, signal: ctrl.signal });

      let stdout = '', stderr = '', finished = false;
      const cleanup = () => { clearTimeout(timer); if (extOnAbort) extSignal?.removeEventListener?.('abort', extOnAbort); };
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { ctrl.abort(); } catch {}
        try { proc.kill('SIGKILL'); } catch {}
        reject(new LLMTimeoutError(`claude -p timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`));
      }, timeoutMs);
      const extOnAbort = () => {
        if (finished) return;
        finished = true;
        try { ctrl.abort(); } catch {}
        try { proc.kill('SIGKILL'); } catch {}
        cleanup();
        reject(new LLMAbortError('claude -p aborted by caller'));
      };
      if (extSignal) {
        if (extSignal.aborted) { extOnAbort(); return; }
        extSignal.addEventListener('abort', extOnAbort, { once: true });
      }

      proc.on('error', (e) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (e.code === 'ENOENT') reject(new LLMProcessError(`Claude CLI not found. Install: https://claude.com/claude-code. Set BUNGRAPH_CLAUDE_BIN to override.`, e));
        else if (e.name === 'AbortError') reject(new LLMTimeoutError(`claude -p aborted`, e));
        else reject(new LLMProcessError(e.message, e));
      });

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); if (process.env.BUNGRAPH_DEBUG_CLAUDE) log.debug('claude stderr', { chunk: d.toString().slice(0, 200) }); });

      proc.on('close', (code) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (code !== 0) {
          const msg = `claude -p exited ${code}. stderr: ${stderr.slice(0, 500)}`;
          reject(classifyTransient(code, stderr) ? new LLMTransientError(msg) : new LLMProcessError(msg));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.is_error) {
            const err = String(parsed.result || parsed.api_error_status || 'unknown');
            reject(/rate|overload|529|503|408|timeout/i.test(err) ? new LLMTransientError(`Claude error: ${err}`) : new LLMProcessError(`Claude error: ${err}`));
            return;
          }
          resolve(parsed.result || '');
        } catch { resolve(stdout); }
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }

  parseJson(text) {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    const first = t.indexOf('{');
    const firstArr = t.indexOf('[');
    if (first === -1 && firstArr === -1) return null;
    const start = first === -1 ? firstArr : firstArr === -1 ? first : Math.min(first, firstArr);
    const openCh = t[start];
    const closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === openCh) depth++;
      else if (c === closeCh) { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
  }

  async close() {}
}

export function getLLM() {
  if (clientSingleton) return clientSingleton;
  const provider = (process.env.BUNGRAPH_LLM_PROVIDER || 'claude-code').toLowerCase();
  if (provider === 'acp') {
    clientSingleton = new ACPClient();
  } else {
    clientSingleton = new LLMClient();
  }
  return clientSingleton;
}

export function llmStats() { return { ...state }; }
