import { spawn } from 'child_process';
import { Writable, Readable } from 'stream';
import * as acp from '@agentclientprotocol/sdk';
import { logger } from './logger.js';
import { register } from './debug-registry.js';
import { LLMError, LLMTransientError, LLMTimeoutError, LLMProcessError, LLMValidationError, LLMAbortError } from './llm-errors.js';

const log = logger.child('llm-acp');

class AutoClient {
  constructor() { this.chunks = null; }
  async requestPermission(params) {
    return { outcome: { outcome: 'selected', optionId: (params.options.find(o => /allow/i.test(o.kind))?.optionId) || params.options[0].optionId } };
  }
  async sessionUpdate(p) {
    if (!this.chunks) return;
    const u = p.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.chunks.push(u.content.text);
  }
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
}

function envInt(name, d) { const v = parseInt(process.env[name] || '', 10); return Number.isFinite(v) && v > 0 ? v : d; }

export class ACPClient {
  constructor() {
    const cmdRaw = process.env.BUNGRAPH_ACP_COMMAND;
    if (!cmdRaw) throw new LLMProcessError('BUNGRAPH_ACP_COMMAND not set');
    const parts = cmdRaw.trim().split(/\s+/);
    this.cmd = parts[0];
    this.args = parts.slice(1);
    const extra = process.env.BUNGRAPH_ACP_ARGS;
    if (extra) { try { const a = JSON.parse(extra); if (Array.isArray(a)) this.args.push(...a); } catch { this.args.push(...extra.split(/\s+/)); } }
    this.proc = null;
    this.conn = null;
    this.sessionId = null;
    this.mutex = Promise.resolve();
    this.state = { inflight: 0, completed: 0, failed: 0, restarts: 0, sessionsCreated: 0 };
    register('llm-acp', () => ({ ...this.state, cmd: this.cmd, args: this.args, alive: !!this.proc, sessionId: this.sessionId }));
  }

  async ensureSession() {
    if (this.conn && this.proc && !this.proc.killed && this.sessionId) return;
    await this.startProcess();
  }

  async startProcess() {
    try { this.proc?.kill('SIGKILL'); } catch {}
    const isWin = process.platform === 'win32';
    const spawnCmd = isWin && !/\.(exe|cmd|bat)$/i.test(this.cmd) ? this.cmd + '.cmd' : this.cmd;
    log.info('spawn', { cmd: spawnCmd, args: this.args });
    this.proc = spawn(spawnCmd, this.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: isWin });
    this.proc.stderr.on('data', d => { if (process.env.BUNGRAPH_DEBUG_ACP) log.debug('stderr', { chunk: d.toString().slice(0, 200) }); });
    this.proc.on('exit', (code, sig) => { log.warn('acp exited', { code, sig }); this.proc = null; this.conn = null; this.sessionId = null; });

    const input = Writable.toWeb(this.proc.stdin);
    const output = Readable.toWeb(this.proc.stdout);
    const stream = acp.ndJsonStream(input, output);
    this.client = new AutoClient();
    this.conn = new acp.ClientSideConnection(() => this.client, stream);

    await this.conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const s = await this.conn.newSession({ cwd: process.cwd(), mcpServers: [] });
    this.sessionId = s.sessionId;
    this.state.sessionsCreated++;
    log.info('session ready', { sessionId: this.sessionId });
  }

  async generate(system, user, opts = {}) {
    const timeoutMs = opts.timeoutMs || envInt('BUNGRAPH_LLM_TIMEOUT_MS', 120_000);
    const prompt = system
      ? `${system}\n\n---\n\n${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`
      : `${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`;
    return new Promise((resolve, reject) => {
      this.mutex = this.mutex.then(async () => {
        this.state.inflight++;
        try {
          const text = await this.runTurn(prompt, timeoutMs, opts.signal);
          const parsed = this.parseJson(text);
          if (!parsed) { this.state.failed++; throw new LLMValidationError(`ACP returned non-JSON (len=${text.length})`); }
          this.state.completed++;
          resolve(parsed);
        } catch (e) {
          this.state.failed++;
          reject(e);
        } finally {
          this.state.inflight--;
        }
      }).catch(() => {});
    });
  }

  async runTurn(promptText, timeoutMs, extSignal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.ensureSession();
        const chunks = [];
        this.client.chunks = chunks;
        let timerHandle;
        const timer = new Promise((_, rej) => { timerHandle = setTimeout(() => rej(new LLMTimeoutError(`ACP prompt timed out after ${timeoutMs}ms`)), timeoutMs); });
        const abortP = extSignal ? new Promise((_, rej) => {
          if (extSignal.aborted) rej(new LLMAbortError('aborted'));
          extSignal.addEventListener('abort', () => rej(new LLMAbortError('aborted')), { once: true });
        }) : null;
        const promises = [this.conn.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text: promptText }] }), timer];
        if (abortP) promises.push(abortP);
        try {
          const res = await Promise.race(promises);
          if (res?.stopReason && res.stopReason !== 'end_turn' && res.stopReason !== 'max_tokens') {
            log.warn('unexpected stopReason', { stopReason: res.stopReason });
          }
        } finally { clearTimeout(timerHandle); this.client.chunks = null; }
        return chunks.join('');
      } catch (e) {
        if (e instanceof LLMAbortError) throw e;
        log.warn('turn failed', { err: e.name, msg: String(e.message).slice(0, 200), attempt });
        try { this.proc?.kill('SIGKILL'); } catch {}
        this.proc = null; this.conn = null; this.sessionId = null;
        this.state.restarts++;
        if (attempt === 1) throw new LLMTransientError(`ACP turn failed: ${e.message}`);
      }
    }
    throw new LLMError('unreachable');
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

  async close() {
    try { this.proc?.kill('SIGKILL'); } catch {}
    this.proc = null; this.conn = null; this.sessionId = null;
  }
}
