import { createServer } from 'http';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { Graphiti } from './graph.js';
import { logger } from './logger.js';
import { snapshot } from './debug-registry.js';
import {
  validate, MessagesInput, HttpSearchInput, HttpEntityNodeInput,
  HttpGetMemoryInput, UuidOnlyInput, GroupOnlyInput, AddTripletInput,
} from './validation.js';

const log = logger.child('http');
let graph = null;
const queue = [];
let working = false;
const workerState = { size: 0, processed: 0, failed: 0, busy: false };

async function drain() {
  if (working) return;
  working = true;
  workerState.busy = true;
  while (queue.length) {
    workerState.size = queue.length;
    const job = queue.shift();
    try { await job(); workerState.processed++; }
    catch (e) { workerState.failed++; log.error('job failed', { err: e?.message }); }
  }
  workerState.size = 0;
  workerState.busy = false;
  working = false;
}

function enqueue(job) { queue.push(job); workerState.size = queue.length; drain(); }

function getFactResultFromEdge(edge) {
  if (!edge) return null;
  return {
    uuid: edge.uuid, name: edge.name, fact: edge.fact,
    source_node_uuid: edge.source_node_uuid, target_node_uuid: edge.target_node_uuid,
    valid_at: edge.valid_at, invalid_at: edge.invalid_at, expired_at: edge.expired_at,
    episodes: typeof edge.episodes === 'string' ? JSON.parse(edge.episodes) : edge.episodes,
    created_at: edge.created_at,
  };
}

function composeQueryFromMessages(messages) {
  return messages.map(m => `${m.role_type || ''}(${m.role || ''}): ${m.content}`).join('\n');
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  const cap = 4 * 1024 * 1024;
  for await (const c of req) { total += c.length; if (total > cap) throw new HttpError(413, 'payload-too-large', 'Request body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid-json', 'Request body is not valid JSON'); }
}

class HttpError extends Error {
  constructor(status, type, detail, issues = null) { super(detail); this.status = status; this.type = type; this.issues = issues; }
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendProblem(res, status, type, title, detail, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/problem+json' });
  res.end(JSON.stringify({ type: `urn:bungraph:${type}`, title, status, detail, ...extra }));
}

function parseBody(schema, body) {
  const r = validate(schema, body);
  if (!r.ok) throw new HttpError(400, 'validation', 'Request body failed validation', r.issues);
  return r.value;
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/healthcheck$/, async (req, res) => sendJson(res, 200, { status: 'healthy' }));
route('GET', /^\/debug\/state$/, async (req, res) => sendJson(res, 200, snapshot()));

route('POST', /^\/messages$/, async (req, res) => {
  const body = parseBody(MessagesInput, await readBody(req));
  const gid = body.group_id || 'default';
  for (const m of body.messages) {
    enqueue(() => graph.addEpisode({
      name: m.name, content: `${m.role || ''}(${m.role_type || ''}): ${m.content}`,
      source: 'message', sourceDescription: m.source_description || '',
      validAt: m.timestamp, groupId: gid,
    }));
  }
  sendJson(res, 202, { message: 'Messages added to processing queue', success: true, queued: body.messages.length });
});

route('POST', /^\/entity-node$/, async (req, res) => {
  const body = parseBody(HttpEntityNodeInput, await readBody(req));
  const { embedOne } = await import('./embeddings.js');
  const { upsertEntityNode } = await import('./store.js');
  const node = {
    uuid: body.uuid || randomUUID(),
    group_id: body.group_id || 'default',
    name: body.name, summary: body.summary || '',
    labels: ['Entity'], attributes: {},
    name_embedding: await embedOne(body.name),
    created_at: new Date().toISOString(),
  };
  await upsertEntityNode(node);
  sendJson(res, 201, node);
});

route('DELETE', /^\/entity-edge\/([^/]+)$/, async (req, res, [, uuid]) => {
  const v = validate(UuidOnlyInput, { uuid });
  if (!v.ok) throw new HttpError(400, 'validation', 'Invalid uuid', v.issues);
  await graph.deleteEntityEdge(v.value.uuid);
  sendJson(res, 200, { message: 'Entity Edge deleted', success: true });
});

route('DELETE', /^\/group\/([^/]+)$/, async (req, res, [, gid]) => {
  await graph.clearGraph({ groupIds: [gid] });
  sendJson(res, 200, { message: 'Group deleted', success: true });
});

route('DELETE', /^\/episode\/([^/]+)$/, async (req, res, [, uuid]) => {
  await graph.deleteEpisode(uuid);
  sendJson(res, 200, { message: 'Episode deleted', success: true });
});

route('POST', /^\/clear$/, async (req, res) => {
  parseBody(GroupOnlyInput, await readBody(req));
  await graph.clearGraph();
  sendJson(res, 200, { message: 'Graph cleared', success: true });
});

route('POST', /^\/search$/, async (req, res) => {
  const body = parseBody(HttpSearchInput, await readBody(req));
  const results = await graph.search(body.query, {
    groupIds: body.group_ids, limit: body.max_facts || body.limit || 10, asOf: body.as_of || null,
  });
  sendJson(res, 200, { facts: results.edges.map(getFactResultFromEdge), nodes: results.nodes, as_of: body.as_of || null });
});

route('GET', /^\/entity-edge\/([^/]+)$/, async (req, res, [, uuid]) => {
  const edge = await graph.getEdgeByUuid(uuid);
  sendJson(res, 200, getFactResultFromEdge(edge));
});

route('GET', /^\/episodes\/([^/]+)$/, async (req, res, [, gid], url) => {
  const lastN = Math.min(Math.max(Number(url.searchParams.get('last_n') || 10), 1), 1000);
  sendJson(res, 200, await graph.retrieveEpisodes({ groupIds: [gid], limit: lastN }));
});

route('POST', /^\/get-memory$/, async (req, res) => {
  const body = parseBody(HttpGetMemoryInput, await readBody(req));
  const q = composeQueryFromMessages(body.messages);
  const results = await graph.search(q, { groupIds: [body.group_id || 'default'], limit: body.max_facts || 10 });
  sendJson(res, 200, { facts: results.edges.map(getFactResultFromEdge) });
});

route('POST', /^\/build-communities$/, async (req, res) => {
  const body = await readBody(req);
  sendJson(res, 200, await graph.buildCommunities({ groupIds: body.group_ids || undefined }));
});

route('POST', /^\/triplet$/, async (req, res) => {
  const body = parseBody(AddTripletInput, await readBody(req));
  sendJson(res, 200, await graph.addTriplet(body));
});

export async function startHttpServer({ port = 8000, dbPath = 'bundag.db' } = {}) {
  graph = new Graphiti({ dbPath });
  await graph.init();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = routes.find(r => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return sendProblem(res, 404, 'not-found', 'Not Found', `No route for ${req.method} ${url.pathname}`);
    const m = url.pathname.match(match.pattern);
    try { await match.handler(req, res, m, url); }
    catch (e) {
      if (e instanceof HttpError) {
        sendProblem(res, e.status, e.type, e.status >= 500 ? 'Server Error' : 'Bad Request', e.message, e.issues ? { issues: e.issues } : {});
      } else {
        log.error('handler error', { err: e?.message, path: url.pathname });
        sendProblem(res, 500, 'internal', 'Internal Server Error', e?.message || 'unknown');
      }
    }
  });
  server.listen(port, () => log.info('listening', { port }));
  return server;
}

export { workerState as httpWorkerState };
