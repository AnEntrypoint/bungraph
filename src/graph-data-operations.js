import { getDb } from './store.js';

export const EPISODE_WINDOW_LEN = 3;

export async function retrieveEpisodes({ groupIds, referenceTime = null, limit = EPISODE_WINDOW_LEN, source = null }) {
  const db = getDb();
  const parts = [];
  const args = [];
  if (groupIds?.length) {
    parts.push(`group_id IN (${groupIds.map(() => '?').join(',')})`);
    args.push(...groupIds);
  }
  if (referenceTime) { parts.push('valid_at < ?'); args.push(referenceTime); }
  if (source) { parts.push('source = ?'); args.push(source); }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : '';
  args.push(limit);
  const r = await db.execute({
    sql: `SELECT * FROM episodic_node ${where} ORDER BY valid_at DESC LIMIT ?`,
    args,
  });
  return r.rows.reverse();
}

export async function buildIndicesAndConstraints() {
  // idempotent — schema already creates indices via CREATE IF NOT EXISTS in store.initStore
  return true;
}

export async function clearData(groupIds = null) {
  const db = getDb();
  const groupTables = ['entity_edge', 'episodic_edge', 'community_edge', 'has_episode_edge', 'next_episode_edge', 'entity_node', 'episodic_node', 'community_node', 'saga_node'];
  const ftsTables = ['entity_node_fts', 'entity_edge_fts', 'episodic_node_fts', 'community_node_fts'];
  if (groupIds?.length) {
    for (const t of groupTables) {
      await db.execute({ sql: `DELETE FROM ${t} WHERE group_id IN (${groupIds.map(() => '?').join(',')})`, args: groupIds });
    }
    // Rebuild FTS from remaining rows
    for (const t of ftsTables) await db.execute({ sql: `DELETE FROM ${t}`, args: [] });
    const nodes = await db.execute({ sql: `SELECT uuid, name, summary FROM entity_node`, args: [] });
    for (const n of nodes.rows) await db.execute({ sql: `INSERT INTO entity_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [n.uuid, n.name, n.summary || ''] });
    const edges = await db.execute({ sql: `SELECT uuid, fact FROM entity_edge`, args: [] });
    for (const e of edges.rows) await db.execute({ sql: `INSERT INTO entity_edge_fts(uuid,fact) VALUES(?,?)`, args: [e.uuid, e.fact] });
    const epis = await db.execute({ sql: `SELECT uuid, name, content FROM episodic_node`, args: [] });
    for (const ep of epis.rows) await db.execute({ sql: `INSERT INTO episodic_node_fts(uuid,name,content) VALUES(?,?,?)`, args: [ep.uuid, ep.name, ep.content] });
    const comms = await db.execute({ sql: `SELECT uuid, name, summary FROM community_node`, args: [] });
    for (const c of comms.rows) await db.execute({ sql: `INSERT INTO community_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [c.uuid, c.name, c.summary || ''] });
  } else {
    for (const t of [...groupTables, ...ftsTables]) {
      await db.execute({ sql: `DELETE FROM ${t}`, args: [] });
    }
  }
}
