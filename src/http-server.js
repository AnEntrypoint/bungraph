import { createServer } from 'http';
import { URL } from 'url';
import { Graphiti } from './graph.js';

let graph = null;
const queue = [];
let working = false;

async function worker() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try { await job(); } catch (e) { console.error('[bundag-http] job failed', e); }
  }
  working = false;
}

function enqueue(job) { queue.push(job); worker(); }

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
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', /^\/healthcheck$/, async (req, res) => send(res, 200, { status: 'healthy' }));

route('POST', /^\/messages$/, async (req, res) => {
  const body = await readBody(req) || {};
  const { group_id = 'default', messages = [] } = body;
  for (const m of messages) {
    enqueue(() => graph.addEpisode({
      name: m.name, content: `${m.role || ''}(${m.role_type || ''}): ${m.content}`,
      source: 'message', sourceDescription: m.source_description || '',
      validAt: m.timestamp, groupId: group_id,
    }));
  }
  send(res, 202, { message: 'Messages added to processing queue', success: true });
});

route('POST', /^\/entity-node$/, async (req, res) => {
  const body = await readBody(req) || {};
  const { embedOne } = await import('./embeddings.js');
  const { upsertEntityNode } = await import('./store.js');
  const node = {
    uuid: body.uuid || crypto.randomUUID(),
    group_id: body.group_id || 'default',
    name: body.name, summary: body.summary || '',
    labels: ['Entity'], attributes: {},
    name_embedding: await embedOne(body.name),
    created_at: new Date().toISOString(),
  };
  await upsertEntityNode(node);
  send(res, 201, node);
});

route('DELETE', /^\/entity-edge\/([^/]+)$/, async (req, res, [, uuid]) => {
  await graph.deleteEntityEdge(uuid);
  send(res, 200, { message: 'Entity Edge deleted', success: true });
});

route('DELETE', /^\/group\/([^/]+)$/, async (req, res, [, gid]) => {
  await graph.clearGraph({ groupIds: [gid] });
  send(res, 200, { message: 'Group deleted', success: true });
});

route('DELETE', /^\/episode\/([^/]+)$/, async (req, res, [, uuid]) => {
  await graph.deleteEpisode(uuid);
  send(res, 200, { message: 'Episode deleted', success: true });
});

route('POST', /^\/clear$/, async (req, res) => {
  await graph.clearGraph();
  send(res, 200, { message: 'Graph cleared', success: true });
});

route('POST', /^\/search$/, async (req, res) => {
  const body = await readBody(req) || {};
  const results = await graph.search(body.query, {
    groupIds: body.group_ids, limit: body.max_facts || body.limit || 10,
  });
  send(res, 200, { facts: results.edges.map(getFactResultFromEdge), nodes: results.nodes });
});

route('GET', /^\/entity-edge\/([^/]+)$/, async (req, res, [, uuid]) => {
  const edge = await graph.getEdgeByUuid(uuid);
  send(res, 200, getFactResultFromEdge(edge));
});

route('GET', /^\/episodes\/([^/]+)$/, async (req, res, [, gid], url) => {
  const lastN = Number(url.searchParams.get('last_n') || 10);
  send(res, 200, await graph.retrieveEpisodes({ groupIds: [gid], limit: lastN }));
});

route('POST', /^\/get-memory$/, async (req, res) => {
  const body = await readBody(req) || {};
  const q = composeQueryFromMessages(body.messages || []);
  const results = await graph.search(q, {
    groupIds: [body.group_id || 'default'], limit: body.max_facts || 10,
  });
  send(res, 200, { facts: results.edges.map(getFactResultFromEdge) });
});

route('POST', /^\/build-communities$/, async (req, res) => {
  const body = await readBody(req) || {};
  send(res, 200, await graph.buildCommunities({ groupIds: body.group_ids || undefined }));
});

route('POST', /^\/triplet$/, async (req, res) => {
  const body = await readBody(req) || {};
  send(res, 200, await graph.addTriplet(body));
});

export async function startHttpServer({ port = 8000, dbPath = 'bundag.db' } = {}) {
  graph = new Graphiti({ dbPath });
  await graph.init();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const match = routes.find(r => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return send(res, 404, { error: 'not found' });
    const m = url.pathname.match(match.pattern);
    try { await match.handler(req, res, m, url); }
    catch (e) { console.error('[bundag-http]', e); send(res, 500, { error: e.message }); }
  });
  server.listen(port, () => console.error(`[bundag-http] listening on :${port}`));
  return server;
}
