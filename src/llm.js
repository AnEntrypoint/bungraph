import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';

export class LLMError extends Error { constructor(msg, cause) { super(msg); this.name = this.constructor.name; this.cause = cause; } }
export class LLMTransientError extends LLMError {}
export class LLMTimeoutError extends LLMTransientError {}
export class LLMProcessError extends LLMError {}
export class LLMValidationError extends LLMError {}

export function isTransient(e) { return e instanceof LLMTransientError; }

let clientSingleton = null;
let resolvedBin = null;

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

export class LLMClient {
  constructor() { this.bin = resolveClaudeBin(); }

  async generate(system, user, { maxAttempts = 3, timeoutMs = 60000 } = {}) {
    const fullPrompt = system
      ? `${system}\n\n---\n\n${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`
      : `${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`;

    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const text = await this.callClaude(fullPrompt, timeoutMs);
        if (process.env.BUNGRAPH_DEBUG_LLM) process.stderr.write('[bungraph] LLM raw: ' + text.slice(0, 500) + '\n');
        const parsed = this.parseJson(text);
        if (parsed) return parsed;
        lastErr = new LLMValidationError(`LLM returned non-JSON (len=${text.length})`);
        process.stderr.write(`[bungraph] ${lastErr.message}, retrying ${attempt + 1}/${maxAttempts}...\n`);
      } catch (e) {
        lastErr = e;
        if (!isTransient(e)) throw e;
        process.stderr.write(`[bungraph] LLM transient error (${e.name}): ${e.message}, retrying ${attempt + 1}/${maxAttempts}...\n`);
      }
    }
    throw lastErr || new LLMValidationError('LLM failed to return JSON after retries');
  }

  callClaude(prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--disable-slash-commands', '--permission-mode', 'bypassPermissions'];
      const ctrl = new AbortController();
      const proc = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: scrubEnv(), shell: false, signal: ctrl.signal });

      let stdout = '', stderr = '', finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { ctrl.abort(); } catch {}
        try { proc.kill('SIGKILL'); } catch {}
        reject(new LLMTimeoutError(`claude -p timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`));
      }, timeoutMs);

      proc.on('error', (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (e.code === 'ENOENT') reject(new LLMProcessError(`Claude CLI not found. Install: https://claude.com/claude-code. Set BUNGRAPH_CLAUDE_BIN to override.`, e));
        else if (e.name === 'AbortError') reject(new LLMTimeoutError(`claude -p aborted`, e));
        else reject(new LLMProcessError(e.message, e));
      });

      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => {
        stderr += d.toString();
        if (process.env.BUNGRAPH_DEBUG_CLAUDE) process.stderr.write('[claude] ' + d.toString());
      });

      proc.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (code !== 0) {
          const msg = `claude -p exited ${code}. stderr: ${stderr.slice(0, 500)}`;
          const transient = code === 1 && /rate|overload|timeout|network|ECONNRESET|ETIMEDOUT/i.test(stderr);
          reject(transient ? new LLMTransientError(msg) : new LLMProcessError(msg));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          if (parsed.is_error) {
            const err = String(parsed.result || parsed.api_error_status || 'unknown');
            const transient = /rate|overload|529|503|timeout/i.test(err);
            reject(transient ? new LLMTransientError(`Claude error: ${err}`) : new LLMProcessError(`Claude error: ${err}`));
            return;
          }
          resolve(parsed.result || '');
        } catch {
          resolve(stdout);
        }
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
  if (!clientSingleton) clientSingleton = new LLMClient();
  return clientSingleton;
}
