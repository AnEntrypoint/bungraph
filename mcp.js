#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { Graphiti } from './src/graph.js';
import {
  AddEpisodeInput, AddEpisodeBulkInput, AddTripletInput, SearchInput, SimpleQuery,
  GetEpisodesInput, UuidOnlyInput, GroupOnlyInput, CreateSagaInput, validate,
} from './src/validation.js';
import { logger } from './src/logger.js';
import { snapshot } from './src/debug-registry.js';

const log = logger.child('mcp');
let g = null;
async function ensure(dbPath) { if (g) return g; g = new Graphiti({ dbPath }); await g.init(); return g; }

const GROUP = { type: 'string', description: 'Tenant/group identifier.' };
const AS_OF = { type: 'string', description: 'ISO-8601 timestamp; return state valid at this time.' };
const LIMIT = { type: 'number', description: 'Maximum results to return.' };
const UUID = { type: 'string', description: 'UUID of the target record.' };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const idemp = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destroy = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const tools = [
  { name: 'add_episode', description: 'Ingest an episode into the temporal knowledge graph. Extracts entities and facts via LLM, dedupes, and invalidates contradicted facts.',
    annotations: { title: 'Add Episode', ...write },
    inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, name: { type: 'string' }, source: { type: 'string', enum: ['message', 'text', 'json'] }, source_description: { type: 'string' }, valid_at: { type: 'string' }, saga_uuid: UUID, update_communities: { type: 'boolean' }, group_id: GROUP } } },
  { name: 'add_episode_bulk', description: 'Ingest multiple episodes in one pass with cross-episode dedup.',
    annotations: { title: 'Add Episodes (bulk)', ...write },
    inputSchema: { type: 'object', required: ['episodes'], properties: { episodes: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' }, valid_at: { type: 'string' } } } }, group_id: GROUP } } },
  { name: 'add_triplet', description: 'Insert a (source, relation, target) triplet without LLM extraction.',
    annotations: { title: 'Add Triplet', ...idemp },
    inputSchema: { type: 'object', required: ['sourceName', 'relation', 'targetName'], properties: { sourceName: { type: 'string' }, relation: { type: 'string' }, targetName: { type: 'string' }, fact: { type: 'string' }, valid_at: { type: 'string' }, group_id: GROUP } } },
  { name: 'search', description: 'Hybrid search across nodes, edges, communities, and episodes (RRF fusion). Supports as_of bitemporal filtering on edges.',
    annotations: { title: 'Search All', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string', enum: ['rrf', 'mmr', 'node_distance', 'episode_mentions', 'cross_encoder'] }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_nodes', description: 'Hybrid search restricted to entity nodes.',
    annotations: { title: 'Search Nodes', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_facts', description: 'Hybrid search over entity edges. Excludes edges expired before as_of (or currently if omitted).',
    annotations: { title: 'Search Facts', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_communities', description: 'Search community summary clusters.',
    annotations: { title: 'Search Communities', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_episodes', description: 'BM25 search over raw episode content.',
    annotations: { title: 'Search Episodes', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, as_of: AS_OF, group_id: GROUP } } },
  { name: 'get_episodes', description: 'List recent episodes, optionally scoped by reference_time.',
    annotations: { title: 'List Episodes', ...read },
    inputSchema: { type: 'object', properties: { limit: LIMIT, reference_time: { type: 'string' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'get_node', description: 'Fetch a single entity node by UUID.',
    annotations: { title: 'Get Node', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'get_edge', description: 'Fetch a single entity edge by UUID.',
    annotations: { title: 'Get Edge', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'get_episode', description: 'Fetch an episode with its extracted nodes/edges.',
    annotations: { title: 'Get Episode', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'build_communities', description: 'Run label-propagation community detection.',
    annotations: { title: 'Build Communities', ...idemp },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
  { name: 'remove_communities', description: 'Delete all communities in a group.',
    annotations: { title: 'Remove Communities', ...destroy },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
  { name: 'create_saga', description: 'Create a saga for grouping related episodes.',
    annotations: { title: 'Create Saga', ...write },
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, summary: { type: 'string' }, group_id: GROUP } } },
  { name: 'summarize_saga', description: 'Generate a saga summary via LLM.',
    annotations: { title: 'Summarize Saga', ...idemp },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_episode', description: 'Delete an episode by UUID.',
    annotations: { title: 'Delete Episode', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_entity_edge', description: 'Delete an entity edge by UUID. Prefer contradicting add_episode for temporal invalidation.',
    annotations: { title: 'Delete Edge', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_entity_node', description: 'Delete an entity node and its incident edges.',
    annotations: { title: 'Delete Node', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'clear_graph', description: 'Delete data in a group (or entire database). Destructive, irreversible.',
    annotations: { title: 'Clear Graph', ...destroy },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
  { name: 'debug_state', description: 'Return in-process runtime snapshot: subsystem metrics, tx stats, LLM inflight, memory. Read-only diagnostics.',
    annotations: { title: 'Debug State', ...read },
    inputSchema: { type: 'object', properties: {} } },
];

function payload(obj) { const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2); return { content: [{ type: 'text', text: data }], structuredContent: typeof obj === 'string' ? { text: obj } : obj }; }
function isErr(msg, details) { return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true, structuredContent: { error: { message: msg, ...(details ? { details } : {}) } } }; }
function validationErr(issues) { return { content: [{ type: 'text', text: `validation failed: ${JSON.stringify(issues)}` }], isError: true, structuredContent: { error: { type: 'https://bungraph/errors/validation', title: 'Invalid input', issues } } }; }

const schemas = {
  add_episode: AddEpisodeInput, add_episode_bulk: AddEpisodeBulkInput, add_triplet: AddTripletInput,
  search: SearchInput, search_nodes: SearchInput, search_facts: SearchInput,
  search_communities: SimpleQuery, search_episodes: SimpleQuery,
  get_episodes: GetEpisodesInput, get_node: UuidOnlyInput, get_edge: UuidOnlyInput, get_episode: UuidOnlyInput,
  build_communities: GroupOnlyInput, remove_communities: GroupOnlyInput, clear_graph: GroupOnlyInput,
  create_saga: CreateSagaInput, summarize_saga: UuidOnlyInput,
  delete_episode: UuidOnlyInput, delete_entity_edge: UuidOnlyInput, delete_entity_node: UuidOnlyInput,
  debug_state: GroupOnlyInput,
};

const handlers = {
  add_episode: async (graph, a) => {
    const r = await graph.addEpisode({ content: a.content, name: a.name, source: a.source || 'message', sourceDescription: a.source_description || '', validAt: a.valid_at, groupId: a.group_id, sagaUuid: a.saga_uuid, updateCommunities: a.update_communities || false });
    return { episode_uuid: r.episode.uuid, nodes: r.nodes, edges: r.edges };
  },
  add_episode_bulk: async (graph, a) => {
    const r = await graph.addEpisodeBulk({ episodes: a.episodes, groupId: a.group_id });
    return { episodes: r.episodes.length, nodes: r.nodes.length, edges: r.edges.length };
  },
  add_triplet: async (graph, a) => graph.addTriplet({ sourceName: a.sourceName, relation: a.relation, targetName: a.targetName, fact: a.fact, groupId: a.group_id, validAt: a.valid_at }),
  search: async (graph, a) => graph.search(a.query, { groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 10, centerNodeUuids: a.center_node_uuids, asOf: a.as_of }),
  search_nodes: async (graph, a) => graph.searchNodes(a.query, { groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 10, centerNodeUuids: a.center_node_uuids, asOf: a.as_of }),
  search_facts: async (graph, a) => graph.searchEdges(a.query, { groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 10, centerNodeUuids: a.center_node_uuids, asOf: a.as_of }),
  search_communities: async (graph, a) => graph.searchCommunities(a.query, { groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 3 }),
  search_episodes: async (graph, a) => graph.searchEpisodes(a.query, { groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 10, asOf: a.as_of }),
  get_episodes: async (graph, a) => graph.retrieveEpisodes({ groupIds: a.group_id ? [a.group_id] : undefined, limit: a.limit || 3, referenceTime: a.reference_time || a.as_of }),
  get_node: async (graph, a) => graph.getNodeByUuid(a.uuid),
  get_edge: async (graph, a) => graph.getEdgeByUuid(a.uuid),
  get_episode: async (graph, a) => graph.getNodesAndEdgesByEpisode(a.uuid),
  build_communities: async (graph, a) => graph.buildCommunities({ groupIds: a.group_id ? [a.group_id] : undefined }),
  remove_communities: async (graph, a) => { await graph.removeCommunities({ groupIds: a.group_id ? [a.group_id] : undefined }); return { ok: true }; },
  create_saga: async (graph, a) => graph.createSaga({ name: a.name, groupId: a.group_id, summary: a.summary }),
  summarize_saga: async (graph, a) => graph.summarizeSaga(a.uuid),
  delete_episode: async (graph, a) => { await graph.deleteEpisode(a.uuid); return { deleted: a.uuid }; },
  delete_entity_edge: async (graph, a) => { await graph.deleteEntityEdge(a.uuid); return { deleted: a.uuid }; },
  delete_entity_node: async (graph, a) => { await graph.deleteEntityNode(a.uuid); return { deleted: a.uuid }; },
  clear_graph: async (graph, a) => { await graph.clearGraph({ groupIds: a.group_id ? [a.group_id] : null }); return { cleared: a.group_id || 'all' }; },
  debug_state: async () => snapshot(),
};

export async function startMcpServer(dbPath = resolve('bundag.db')) {
  const server = new Server({ name: 'bundag', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const schema = schemas[name];
    if (!schema) return isErr(`Unknown tool: ${name}`);
    const v = validate(schema, args);
    if (!v.ok) { log.warn('validation failed', { tool: name, issues: v.issues }); return validationErr(v.issues); }
    try {
      const graph = await ensure(dbPath);
      const result = await handlers[name](graph, v.value);
      return payload(result === undefined ? { ok: true } : result);
    } catch (e) {
      log.error('tool failed', { tool: name, err: e.message });
      return isErr(e.message, { name: e.name });
    }
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP server ready');
}

const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('mcp.js') || process.argv[1].endsWith('bundag-mcp'));
if (isMain) {
  const dbPath = process.env.BUNDAG_DB || resolve('bundag.db');
  startMcpServer(dbPath).catch((e) => { console.error(e); process.exit(1); });
}
