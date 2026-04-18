import { v4 as uuidv4 } from 'uuid';
import { embedOne } from './embeddings.js';
import { getLLM } from './llm.js';
import { promptLibrary } from './prompts/index.js';
import { getDb, vecLit, upsertCommunityNode } from './store.js';
import { MAX_SUMMARY_CHARS, truncateAtSentence } from './text-utils.js';

function nowIso() { return new Date().toISOString(); }

async function getAllEntityNodes(groupIds) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT uuid, name, summary, group_id FROM entity_node WHERE group_id IN (${groupIds.map(() => '?').join(',')})`,
    args: groupIds,
  });
  return r.rows;
}

async function getAllActiveEdges(groupIds) {
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT uuid, source_node_uuid, target_node_uuid, group_id FROM entity_edge
          WHERE group_id IN (${groupIds.map(() => '?').join(',')}) AND expired_at IS NULL`,
    args: groupIds,
  });
  return r.rows;
}

export function labelPropagation(nodes, edges, { maxIter = 10 } = {}) {
  const label = new Map();
  for (const n of nodes) label.set(n.uuid, n.uuid);
  const adj = new Map();
  for (const n of nodes) adj.set(n.uuid, []);
  for (const e of edges) {
    if (adj.has(e.source_node_uuid)) adj.get(e.source_node_uuid).push(e.target_node_uuid);
    if (adj.has(e.target_node_uuid)) adj.get(e.target_node_uuid).push(e.source_node_uuid);
  }
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);
    for (const n of shuffled) {
      const neigh = adj.get(n.uuid) || [];
      if (!neigh.length) continue;
      const counts = new Map();
      for (const nb of neigh) {
        const lb = label.get(nb);
        counts.set(lb, (counts.get(lb) || 0) + 1);
      }
      let bestLb = label.get(n.uuid), bestCount = -1;
      for (const [lb, c] of counts) {
        if (c > bestCount || (c === bestCount && String(lb) < String(bestLb))) {
          bestLb = lb; bestCount = c;
        }
      }
      if (bestLb !== label.get(n.uuid)) {
        label.set(n.uuid, bestLb); changed = true;
      }
    }
    if (!changed) break;
  }
  const communities = new Map();
  for (const [uuid, lb] of label) {
    if (!communities.has(lb)) communities.set(lb, []);
    communities.get(lb).push(uuid);
  }
  return [...communities.values()].filter(c => c.length >= 2);
}

export async function buildCommunities({ groupIds }) {
  const nodes = await getAllEntityNodes(groupIds);
  const edges = await getAllActiveEdges(groupIds);
  const clusters = labelPropagation(nodes, edges);
  const db = getDb();
  const llm = getLLM();

  // clear existing communities in group
  const existingComms = await db.execute({ sql: `SELECT uuid FROM community_node WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
  for (const c of existingComms.rows) await db.execute({ sql: `DELETE FROM community_node_fts WHERE uuid=?`, args: [c.uuid] });
  await db.execute({ sql: `DELETE FROM community_edge WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
  await db.execute({ sql: `DELETE FROM community_node WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });

  const byUuid = new Map(nodes.map(n => [n.uuid, n]));
  const results = [];
  for (const cluster of clusters) {
    const members = cluster.map(u => byUuid.get(u)).filter(Boolean);
    if (!members.length) continue;
    const prompt = promptLibrary.summarize_nodes.summarize_pair({
      node_summaries: members.map(m => ({ name: m.name, summary: m.summary || '' })),
    });
    let res;
    try { res = await llm.generate(prompt.system, prompt.user); }
    catch { res = { summary: members.map(m => m.name).join(', ') }; }
    const summary = truncateAtSentence(res?.summary || members.map(m => m.name).join(', '), MAX_SUMMARY_CHARS);
    const name = members.slice(0, 3).map(m => m.name).join(' / ');
    const commUuid = uuidv4();
    const nameEmb = await embedOne(name);
    await upsertCommunityNode({
      uuid: commUuid, group_id: members[0].group_id, name, summary,
      name_embedding: nameEmb, created_at: nowIso(),
    });
    for (const m of members) {
      await db.execute({
        sql: `INSERT INTO community_edge(uuid,group_id,source_node_uuid,target_node_uuid,created_at) VALUES(?,?,?,?,?)`,
        args: [uuidv4(), m.group_id, commUuid, m.uuid, nowIso()],
      });
    }
    results.push({ uuid: commUuid, name, summary, members: members.map(m => m.uuid) });
  }
  return results;
}

export async function updateCommunity({ nodeUuid, groupId }) {
  // find community for this node; if none, no-op
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT c.* FROM community_node c JOIN community_edge e ON e.source_node_uuid = c.uuid WHERE e.target_node_uuid = ? LIMIT 1`,
    args: [nodeUuid],
  });
  if (!r.rows.length) return null;
  const community = r.rows[0];
  const members = await db.execute({
    sql: `SELECT n.name, n.summary FROM entity_node n JOIN community_edge e ON e.target_node_uuid = n.uuid WHERE e.source_node_uuid = ?`,
    args: [community.uuid],
  });
  const llm = getLLM();
  const prompt = promptLibrary.summarize_nodes.summarize_pair({
    node_summaries: members.rows.map(m => ({ name: m.name, summary: m.summary || '' })),
  });
  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch { return community; }
  const summary = truncateAtSentence(res?.summary || community.summary, MAX_SUMMARY_CHARS);
  await db.execute({ sql: `UPDATE community_node SET summary = ? WHERE uuid = ?`, args: [summary, community.uuid] });
  return { ...community, summary };
}

export async function removeCommunities({ groupIds }) {
  const db = getDb();
  const existing = await db.execute({ sql: `SELECT uuid FROM community_node WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
  for (const c of existing.rows) await db.execute({ sql: `DELETE FROM community_node_fts WHERE uuid=?`, args: [c.uuid] });
  await db.execute({ sql: `DELETE FROM community_edge WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
  await db.execute({ sql: `DELETE FROM community_node WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
}
