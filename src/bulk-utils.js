import { v4 as uuidv4 } from 'uuid';
import { extractNodes, resolveExtractedNodes, extractAttributesFromNodes, MAX_NODES } from './node-operations.js';
import { extractEdges, resolveExtractedEdges, buildEpisodicEdges, extractEdgeAttributes } from './edge-operations.js';
import { retrieveEpisodes } from './graph-data-operations.js';
import {
  upsertEntityNode, upsertEntityEdge, upsertEpisodicNode, upsertEpisodicEdge, expireEdge,
} from './store.js';

function nowIso() { return new Date().toISOString(); }

export async function retrievePreviousEpisodesBulk({ episodes, windowLen = 3 }) {
  const out = new Map();
  for (const ep of episodes) {
    const prev = await retrieveEpisodes({ groupIds: [ep.group_id], referenceTime: ep.valid_at, limit: windowLen });
    out.set(ep.uuid, prev.filter(p => p.uuid !== ep.uuid));
  }
  return out;
}

export async function extractNodesAndEdgesBulk({ episodes, entityTypes = null, edgeTypes = null, customInstructions = '' }) {
  const prevMap = await retrievePreviousEpisodesBulk({ episodes });
  const nodeResults = [];
  for (const ep of episodes) {
    const prev = prevMap.get(ep.uuid) || [];
    const nodes = await extractNodes({ episode: ep, previousEpisodes: prev, entityTypes, customExtractionInstructions: customInstructions });
    nodeResults.push({ episode: ep, extractedNodes: nodes, previousEpisodes: prev });
  }

  const edgeResults = [];
  for (const { episode, extractedNodes, previousEpisodes } of nodeResults) {
    const { resolved, uuidMap } = await resolveExtractedNodes({
      extractedNodes, episode, previousEpisodes, entityTypes,
    });
    const edges = await extractEdges({ episode, nodes: resolved, previousEpisodes, edgeTypes });
    if (edgeTypes) {
      for (const e of edges) await extractEdgeAttributes({ edge: e, edgeTypes });
    }
    await extractAttributesFromNodes({ nodes: resolved, episode, previousEpisodes, entityTypes, edges });
    edgeResults.push({ episode, nodes: resolved, edges, uuidMap, previousEpisodes });
  }
  return edgeResults;
}

export async function dedupeNodesBulk(nodesLists) {
  // flatten and collapse by normalized name per group
  const byGroup = new Map();
  for (const list of nodesLists) {
    for (const n of list) {
      const g = n.group_id;
      if (!byGroup.has(g)) byGroup.set(g, new Map());
      const key = n.name.toLowerCase().trim();
      const bucket = byGroup.get(g);
      if (!bucket.has(key)) bucket.set(key, n);
    }
  }
  const merged = [];
  for (const bucket of byGroup.values()) for (const n of bucket.values()) merged.push(n);
  return merged;
}

export async function dedupeEdgesBulk(edgesLists) {
  const seen = new Map();
  const out = [];
  for (const list of edgesLists) {
    for (const e of list) {
      const key = `${e.source_node_uuid}|${e.target_node_uuid}|${(e.fact || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.set(key, true);
      out.push(e);
    }
  }
  return out;
}

export async function resolveEdgePointers(edges, uuidMap) {
  for (const e of edges) {
    if (uuidMap[e.source_node_uuid]) e.source_node_uuid = uuidMap[e.source_node_uuid];
    if (uuidMap[e.target_node_uuid]) e.target_node_uuid = uuidMap[e.target_node_uuid];
  }
  return edges;
}

export async function addNodesAndEdgesBulk({ episodes, nodes, edges }) {
  for (const n of nodes) await upsertEntityNode(n);
  for (const ep of episodes) await upsertEpisodicNode(ep);
  for (const e of edges) await upsertEntityEdge(e);
  for (const ep of episodes) {
    const epEdges = buildEpisodicEdges({ episode: ep, nodes: nodes.filter(n => n.group_id === ep.group_id) });
    for (const ee of epEdges) await upsertEpisodicEdge(ee);
  }
}
