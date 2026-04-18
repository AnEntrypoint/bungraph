import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function nodeReadableToWeb(readable) {
  return new ReadableStream({
    start(controller) {
      readable.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      readable.on('end', () => { try { controller.close(); } catch {} });
      readable.on('error', (e) => { try { controller.error(e); } catch {} });
    },
    cancel() { try { readable.destroy(); } catch {} },
  });
}

function nodeWritableToWeb(writable) {
  return new WritableStream({
    write(chunk) {
      return new Promise((res, rej) => {
        writable.write(Buffer.from(chunk), (err) => err ? rej(err) : res());
      });
    },
    close() { return new Promise((res) => writable.end(res)); },
    abort() { try { writable.destroy(); } catch {} },
  });
}

function resolveAcpBin() {
  const candidates = [
    resolve(__dirname, '..', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'),
    resolve(process.cwd(), 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

class NullClient {
  async requestPermission() { return { outcome: { outcome: 'selected', optionId: 'allow' } }; }
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
  async createTerminal() { throw new Error('terminal not supported'); }
  async sessionUpdate() {}
  async extMethod() { return {}; }
  async extNotification() {}
}

let clientSingleton = null;

export class LLMClient {
  constructor() {
    this.conn = null;
    this.proc = null;
    this.sessionId = null;
    this.updates = new Map();
  }

  async ensure() {
    if (this.conn && this.sessionId) return;
    const bin = resolveAcpBin();
    if (!bin) throw new Error('claude-agent-acp not found. Install bundag with its deps.');

    this.proc = spawn(process.execPath, [bin], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    });
    this.proc.on('error', (e) => console.error('[bundag] acp spawn error', e));
    this.proc.on('exit', (c) => { this.conn = null; this.sessionId = null; });

    const stream = ndJsonStream(nodeWritableToWeb(this.proc.stdin), nodeReadableToWeb(this.proc.stdout));

    const self = this;
    this.conn = new ClientSideConnection((_agent) => ({
      async requestPermission() { return { outcome: { outcome: 'selected', optionId: 'allow' } }; },
      async writeTextFile() { return {}; },
      async readTextFile() { return { content: '' }; },
      async createTerminal() { throw new Error('no terminal'); },
      async sessionUpdate(params) {
        const sid = params.sessionId;
        const buf = self.updates.get(sid) || [];
        buf.push(params.update);
        self.updates.set(sid, buf);
      },
    }), stream);

    await this.conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });

    const sess = await this.conn.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    this.sessionId = sess.sessionId;
  }

  async generate(system, user, { maxAttempts = 3 } = {}) {
    await this.ensure();
    const fullUser = system
      ? `${system}\n\n---\n\n${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`
      : `${user}\n\nRespond with ONLY a JSON object. No preamble. No code fence.`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.updates.set(this.sessionId, []);
      await this.conn.prompt({
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: fullUser }],
      });
      const text = this.collectText();
      if (process.env.BUNDAG_DEBUG_LLM) console.error('[bundag] LLM raw:', text.slice(0, 500));
      const parsed = this.parseJson(text);
      if (parsed) return parsed;
      console.error('[bundag] llm returned non-JSON (len=' + text.length + '), retrying...');
    }
    throw new Error('LLM failed to return JSON after retries');
  }

  collectText() {
    const buf = this.updates.get(this.sessionId) || [];
    let text = '';
    for (const u of buf) {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        text += u.content.text;
      }
    }
    return text;
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
    try { if (this.proc) this.proc.kill(); } catch {}
    this.conn = null; this.sessionId = null; this.proc = null;
  }
}

export function getLLM() {
  if (!clientSingleton) clientSingleton = new LLMClient();
  return clientSingleton;
}
