import { embed, embedOne } from './embeddings.js';
import {
  getDb, vectorSearchNodes, vectorSearchEdges, ftsSearchNodes, ftsSearchEdges,
  vecLit, graphWalk,
} from './store.js';

export const RELEVANT_SCHEMA_LIMIT = 10;
export const DEFAULT_MIN_SCORE = 0.0;
export const DEFAULT_MMR_LAMBDA = 0.5;
export const RRF_K = 60;

export function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function rrf(lists, k = RRF_K) {
  const scores = new Map();
  const rows = new Map();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const uuid = row.uuid;
      rows.set(uuid, row);
      scores.set(uuid, (scores.get(uuid) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uuid, score]) => ({ ...rows.get(uuid), _score: score }));
}

export function mmr(candidates, queryVec, lambda = DEFAULT_MMR_LAMBDA, limit = 10, embField = 'name_embedding') {
  if (!candidates.length) return [];
  const selected = [];
  const remaining = candidates.slice();
  while (selected.length < limit && remaining.length) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const cVec = c[embField] ? Array.from(c[embField]) : null;
      const relevance = cVec ? cos(queryVec, cVec) : (c._score || 0);
      let maxSim = 0;
      for (const s of selected) {
        const sVec = s[embField] ? Array.from(s[embField]) : null;
        if (cVec && sVec) maxSim = Math.max(maxSim, cos(cVec, sVec));
      }
      const score = lambda * relevance - (1 - lambda) * maxSim;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
  }
  return selected;
}

export async function nodeDistanceRerank(rows, centerNodeUuids, boost = 1.5) {
  if (!centerNodeUuids?.length) return rows;
  const direct = new Set(centerNodeUuids);
  // 1-hop neighbors via entity_edge
  const neighbors = new Set(centerNodeUuids);
  try {
    const walked = await graphWalk(centerNodeUuids, 1);
    for (const n of walked) neighbors.add(n.uuid);
  } catch {}
  return rows.map(r => {
    const uuid = r.uuid || r.source_node_uuid || r.target_node_uuid;
    const inDirect = direct.has(r.uuid) || direct.has(r.source_node_uuid) || direct.has(r.target_node_uuid);
    const inNeighbor = neighbors.has(r.uuid) || neighbors.has(r.source_node_uuid) || neighbors.has(r.target_node_uuid);
    const factor = inDirect ? boost : inNeighbor ? boost * 0.7 : 1;
    return { ...r, _score: (r._score || 0) * factor };
  }).sort((a, b) => (b._score || 0) - (a._score || 0));
}

export async function nodeSimilaritySearch(queryVec, groupIds, limit = 15, minScore = 0.0) {
  const rows = await vectorSearchNodes(queryVec, groupIds, limit);
  return rows.filter(r => (1 - (r.dist || 0)) >= minScore);
}

export async function edgeSimilaritySearch(queryVec, groupIds, limit = 15, minScore = 0.0) {
  const rows = await vectorSearchEdges(queryVec, groupIds, limit);
  return rows.filter(r => (1 - (r.dist || 0)) >= minScore);
}

export async function episodeMentionsRerank(items, centerNodeUuids) {
  if (!items.length) return items;
  const db = getDb();
  const isEdge = 'fact' in (items[0] || {});
  if (isEdge) {
    // edges: boost by how many episodes in centerNodeUuids (treated as episode UUIDs) reference the edge
    const counts = new Map();
    for (const u of (centerNodeUuids || [])) counts.set(u, (counts.get(u) || 0) + 1);
    return items.map(e => {
      const eps = JSON.parse(e.episodes || '[]');
      const boost = eps.reduce((acc, u) => acc + (counts.get(u) || 0), 0);
      return { ...e, _score: (e._score || 0) + boost * 0.01 };
    }).sort((a, b) => (b._score || 0) - (a._score || 0));
  }
  // nodes: count episodic_edge mentions per node, boost proportionally
  const mentionCounts = new Map();
  for (const n of items) {
    try {
      const r = await db.execute({
        sql: `SELECT COUNT(*) as cnt FROM episodic_edge WHERE target_node_uuid=?`,
        args: [n.uuid],
      });
      mentionCounts.set(n.uuid, Number(r.rows[0]?.cnt || 0));
    } catch { mentionCounts.set(n.uuid, 0); }
  }
  const maxMentions = Math.max(1, ...mentionCounts.values());
  return items.map(n => ({
    ...n,
    _score: (n._score || 0) + (mentionCounts.get(n.uuid) || 0) / maxMentions * 0.1,
  })).sort((a, b) => (b._score || 0) - (a._score || 0));
}

export async function getMentionedNodes(episodeUuids) {
  if (!episodeUuids?.length) return [];
  const db = getDb();
  const placeholders = episodeUuids.map(() => '?').join(',');
  const r = await db.execute({
    sql: `SELECT DISTINCT n.* FROM entity_node n
          JOIN episodic_edge ee ON ee.target_node_uuid = n.uuid
          WHERE ee.source_node_uuid IN (${placeholders})`,
    args: episodeUuids,
  });
  return r.rows;
}

export async function getCommunitiesForNodes(nodeUuids) {
  if (!nodeUuids?.length) return [];
  const db = getDb();
  const placeholders = nodeUuids.map(() => '?').join(',');
  const r = await db.execute({
    sql: `SELECT DISTINCT c.* FROM community_node c
          JOIN community_edge ce ON ce.source_node_uuid = c.uuid
          WHERE ce.target_node_uuid IN (${placeholders})`,
    args: nodeUuids,
  });
  return r.rows;
}
