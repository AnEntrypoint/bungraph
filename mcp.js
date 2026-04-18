#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { Graphiti } from './src/graph.js';

let g = null;
async function ensure(dbPath) {
  if (g) return g;
  g = new Graphiti({ dbPath });
  await g.init();
  return g;
}

const GROUP = { type: 'string', description: 'Tenant/group identifier; scopes the operation to a single group. Omit for default group.' };
const AS_OF = { type: 'string', description: 'ISO-8601 timestamp; return state valid at this time (bi-temporal as_of). Omit for current.' };
const LIMIT = { type: 'number', description: 'Maximum results to return.' };
const UUID = { type: 'string', description: 'UUID of the target record.' };

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const idemp = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destroy = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const tools = [
  { name: 'add_episode', description: 'Ingest an episode into the temporal knowledge graph. Extracts entities and facts via LLM, dedupes against existing graph, and invalidates contradicted facts with expired_at. Use for new observations or conversation turns.',
    annotations: { title: 'Add Episode', ...write },
    inputSchema: { type: 'object', required: ['content'], properties: { content: { type: 'string' }, name: { type: 'string' }, source: { type: 'string', enum: ['message', 'text', 'json'] }, source_description: { type: 'string' }, valid_at: { type: 'string', description: 'ISO-8601 when the episode content was true' }, saga_uuid: UUID, update_communities: { type: 'boolean' }, group_id: GROUP } } },
  { name: 'add_episode_bulk', description: 'Ingest multiple episodes in one pass with cross-episode entity dedup. Faster than repeated add_episode when loading historical data.',
    annotations: { title: 'Add Episodes (bulk)', ...write },
    inputSchema: { type: 'object', required: ['episodes'], properties: { episodes: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' }, valid_at: { type: 'string' } } } }, group_id: GROUP } } },
  { name: 'add_triplet', description: 'Directly insert a (source, relation, target) triplet without LLM extraction. Use when you already know the fact structure.',
    annotations: { title: 'Add Triplet', ...idemp },
    inputSchema: { type: 'object', required: ['sourceName', 'relation', 'targetName'], properties: { sourceName: { type: 'string' }, relation: { type: 'string' }, targetName: { type: 'string' }, fact: { type: 'string' }, valid_at: { type: 'string' }, group_id: GROUP } } },
  { name: 'search', description: 'Hybrid search across nodes, edges, communities, and episodes. Combines vector similarity and BM25 with RRF fusion. Use for general "what do we know about X" queries.',
    annotations: { title: 'Search All', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string', enum: ['rrf', 'mmr', 'node_distance', 'episode_mentions', 'cross_encoder'] }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_nodes', description: 'Hybrid search restricted to entity nodes. Use when looking for specific entities (people, organizations, concepts).',
    annotations: { title: 'Search Nodes', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_facts', description: 'Hybrid search restricted to entity edges (facts). Excludes edges with expired_at set. Use for "what facts do we know" queries.',
    annotations: { title: 'Search Facts', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, center_node_uuids: { type: 'array', items: UUID }, reranker: { type: 'string' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_communities', description: 'Search community summary clusters. Use for high-level thematic overview queries.',
    annotations: { title: 'Search Communities', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, as_of: AS_OF, group_id: GROUP } } },
  { name: 'search_episodes', description: 'BM25 keyword search over raw episode content. Use for finding original source material.',
    annotations: { title: 'Search Episodes', ...read },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: LIMIT, as_of: AS_OF, group_id: GROUP } } },
  { name: 'get_episodes', description: 'List most recent episodes in reverse chronological order, optionally scoped to a reference time window.',
    annotations: { title: 'List Episodes', ...read },
    inputSchema: { type: 'object', properties: { limit: LIMIT, reference_time: { type: 'string', description: 'ISO-8601; return episodes with valid_at <= this time' }, as_of: AS_OF, group_id: GROUP } } },
  { name: 'get_node', description: 'Fetch a single entity node by UUID.',
    annotations: { title: 'Get Node', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'get_edge', description: 'Fetch a single entity edge by UUID.',
    annotations: { title: 'Get Edge', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'get_episode', description: 'Fetch an episode by UUID including all entity nodes and edges extracted from it.',
    annotations: { title: 'Get Episode', ...read },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'build_communities', description: 'Run label propagation community detection across the graph. Idempotent — replaces existing communities in the group.',
    annotations: { title: 'Build Communities', ...idemp },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
  { name: 'remove_communities', description: 'Delete all communities in a group. Does not affect entity nodes or edges.',
    annotations: { title: 'Remove Communities', ...destroy },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
  { name: 'create_saga', description: 'Create a saga (named conversation thread) for grouping related episodes.',
    annotations: { title: 'Create Saga', ...write },
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, summary: { type: 'string' }, group_id: GROUP } } },
  { name: 'summarize_saga', description: 'Generate a summary of a saga from all its linked episodes via LLM.',
    annotations: { title: 'Summarize Saga', ...idemp },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_episode', description: 'Delete an episode by UUID. Also removes its episodic edges.',
    annotations: { title: 'Delete Episode', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_entity_edge', description: 'Delete an entity edge (fact) by UUID. For temporal invalidation use add_episode with contradicting content instead.',
    annotations: { title: 'Delete Edge', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'delete_entity_node', description: 'Delete an entity node and all its incident edges.',
    annotations: { title: 'Delete Node', ...destroy },
    inputSchema: { type: 'object', required: ['uuid'], properties: { uuid: UUID } } },
  { name: 'clear_graph', description: 'Delete all data in a group (or entire database if no group specified). Destructive and irreversible.',
    annotations: { title: 'Clear Graph', ...destroy },
    inputSchema: { type: 'object', properties: { group_id: GROUP } } },
];

function text(payload) { return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] }; }
function err(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

export async function startMcpServer(dbPath = resolve('bundag.db')) {
  const server = new Server({ name: 'bundag', version: '0.2.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const graph = await ensure(dbPath);
      const gid = args.group_id;
      const asOf = args.as_of;

      if (name === 'add_episode') {
        const r = await graph.addEpisode({
          content: args.content, name: args.name,
          source: args.source || 'message',
          sourceDescription: args.source_description || '',
          validAt: args.valid_at, groupId: gid,
          sagaUuid: args.saga_uuid, updateCommunities: args.update_communities || false,
        });
        return text({ episode_uuid: r.episode.uuid, nodes: r.nodes, edges: r.edges });
      }
      if (name === 'add_episode_bulk') {
        const r = await graph.addEpisodeBulk({ episodes: args.episodes, groupId: gid });
        return text({ episodes: r.episodes.length, nodes: r.nodes.length, edges: r.edges.length });
      }
      if (name === 'add_triplet') {
        const r = await graph.addTriplet({
          sourceName: args.sourceName, relation: args.relation, targetName: args.targetName,
          fact: args.fact, groupId: gid, validAt: args.valid_at,
        });
        return text(r);
      }
      if (name === 'search') {
        const r = await graph.search(args.query, {
          groupIds: gid ? [gid] : undefined, limit: args.limit || 10,
          centerNodeUuids: args.center_node_uuids, asOf,
        });
        return text(r);
      }
      if (name === 'search_nodes') return text(await graph.searchNodes(args.query, { groupIds: gid ? [gid] : undefined, limit: args.limit || 10, centerNodeUuids: args.center_node_uuids, asOf }));
      if (name === 'search_facts') return text(await graph.searchEdges(args.query, { groupIds: gid ? [gid] : undefined, limit: args.limit || 10, centerNodeUuids: args.center_node_uuids, asOf }));
      if (name === 'search_communities') return text(await graph.searchCommunities(args.query, { groupIds: gid ? [gid] : undefined, limit: args.limit || 3, asOf }));
      if (name === 'search_episodes') return text(await graph.searchEpisodes(args.query, { groupIds: gid ? [gid] : undefined, limit: args.limit || 10, asOf }));
      if (name === 'get_episodes') return text(await graph.retrieveEpisodes({ groupIds: gid ? [gid] : undefined, limit: args.limit || 3, referenceTime: args.reference_time || asOf }));
      if (name === 'get_node') return text(await graph.getNodeByUuid(args.uuid));
      if (name === 'get_edge') return text(await graph.getEdgeByUuid(args.uuid));
      if (name === 'get_episode') return text(await graph.getNodesAndEdgesByEpisode(args.uuid));
      if (name === 'build_communities') return text(await graph.buildCommunities({ groupIds: gid ? [gid] : undefined }));
      if (name === 'remove_communities') { await graph.removeCommunities({ groupIds: gid ? [gid] : undefined }); return text({ ok: true }); }
      if (name === 'create_saga') return text(await graph.createSaga({ name: args.name, groupId: gid, summary: args.summary }));
      if (name === 'summarize_saga') return text(await graph.summarizeSaga(args.uuid));
      if (name === 'delete_episode') { await graph.deleteEpisode(args.uuid); return text({ deleted: args.uuid }); }
      if (name === 'delete_entity_edge') { await graph.deleteEntityEdge(args.uuid); return text({ deleted: args.uuid }); }
      if (name === 'delete_entity_node') { await graph.deleteEntityNode(args.uuid); return text({ deleted: args.uuid }); }
      if (name === 'clear_graph') { await graph.clearGraph({ groupIds: gid ? [gid] : null }); return text({ cleared: gid || 'all' }); }

      return err(`Unknown tool: ${name}`);
    } catch (e) {
      return err(`Error: ${e.message}\n${e.stack}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[bundag] MCP server ready');
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('mcp.js') ||
  process.argv[1].endsWith('bundag-mcp')
);

if (isMain) {
  const dbPath = process.env.BUNDAG_DB || resolve('bundag.db');
  startMcpServer(dbPath).catch((e) => { console.error(e); process.exit(1); });
}
