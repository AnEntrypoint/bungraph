import { getDb, vecLit } from './store.js';
import { withTx } from './store-tx.js';

export async function upsertEntityNode(n) {
  const db = getDb();
  await withTx(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO entity_node(uuid,group_id,name,summary,labels,attributes,name_embedding,created_at)
            VALUES(?,?,?,?,?,?,${vecLit(n.name_embedding)},?)
            ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, summary=excluded.summary,
              labels=excluded.labels, attributes=excluded.attributes, name_embedding=excluded.name_embedding`,
      args: [n.uuid, n.group_id, n.name, n.summary || '', JSON.stringify(n.labels || []),
        JSON.stringify(n.attributes || {}), n.created_at],
    });
    await tx.execute({ sql: `DELETE FROM entity_node_fts WHERE uuid=?`, args: [n.uuid] });
    await tx.execute({
      sql: `INSERT INTO entity_node_fts(uuid,name,summary) VALUES(?,?,?)`,
      args: [n.uuid, n.name, n.summary || ''],
    });
  });
}

export async function upsertEpisodicNode(e) {
  const db = getDb();
  await withTx(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO episodic_node(uuid,group_id,name,source,source_description,content,valid_at,created_at,entity_edges)
            VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(uuid) DO UPDATE SET entity_edges=excluded.entity_edges`,
      args: [e.uuid, e.group_id, e.name, e.source, e.source_description || '', e.content,
        e.valid_at, e.created_at, JSON.stringify(e.entity_edges || [])],
    });
    await tx.execute({ sql: `DELETE FROM episodic_node_fts WHERE uuid=?`, args: [e.uuid] });
    await tx.execute({
      sql: `INSERT INTO episodic_node_fts(uuid,name,content) VALUES(?,?,?)`,
      args: [e.uuid, e.name, e.content],
    });
  });
}

export async function upsertEntityEdge(e) {
  const db = getDb();
  await withTx(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO entity_edge(uuid,group_id,source_node_uuid,target_node_uuid,name,fact,fact_embedding,episodes,attributes,valid_at,invalid_at,expired_at,reference_time,created_at)
            VALUES(?,?,?,?,?,?,${vecLit(e.fact_embedding)},?,?,?,?,?,?,?)
            ON CONFLICT(uuid) DO UPDATE SET fact=excluded.fact, fact_embedding=excluded.fact_embedding,
              episodes=excluded.episodes, attributes=excluded.attributes, valid_at=excluded.valid_at,
              invalid_at=excluded.invalid_at, expired_at=excluded.expired_at`,
      args: [e.uuid, e.group_id, e.source_node_uuid, e.target_node_uuid, e.name, e.fact,
        JSON.stringify(e.episodes || []), JSON.stringify(e.attributes || {}),
        e.valid_at || null, e.invalid_at || null, e.expired_at || null,
        e.reference_time || null, e.created_at],
    });
    await tx.execute({ sql: `DELETE FROM entity_edge_fts WHERE uuid=?`, args: [e.uuid] });
    await tx.execute({
      sql: `INSERT INTO entity_edge_fts(uuid,fact) VALUES(?,?)`,
      args: [e.uuid, e.fact],
    });
  });
}

export async function upsertEpisodicEdge(e) {
  const db = getDb();
  await db.execute({
    sql: `INSERT OR REPLACE INTO episodic_edge(uuid,group_id,source_node_uuid,target_node_uuid,created_at)
          VALUES(?,?,?,?,?)`,
    args: [e.uuid, e.group_id, e.source_node_uuid, e.target_node_uuid, e.created_at],
  });
}

export async function expireEdge(uuid, expiredAt, invalidAt) {
  const db = getDb();
  await db.execute({
    sql: `UPDATE entity_edge SET expired_at=?, invalid_at=COALESCE(?,invalid_at) WHERE uuid=?`,
    args: [expiredAt, invalidAt || null, uuid],
  });
}

export async function upsertCommunityNode(c) {
  const db = getDb();
  await withTx(db, async (tx) => {
    await tx.execute({
      sql: `INSERT INTO community_node(uuid,group_id,name,summary,name_embedding,created_at)
            VALUES(?,?,?,?,${vecLit(c.name_embedding)},?)
            ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, summary=excluded.summary, name_embedding=excluded.name_embedding`,
      args: [c.uuid, c.group_id, c.name, c.summary || '', c.created_at],
    });
    await tx.execute({ sql: `DELETE FROM community_node_fts WHERE uuid=?`, args: [c.uuid] });
    await tx.execute({
      sql: `INSERT INTO community_node_fts(uuid,name,summary) VALUES(?,?,?)`,
      args: [c.uuid, c.name, c.summary || ''],
    });
  });
}

export async function deleteEpisode(uuid) {
  const db = getDb();
  await withTx(db, async (tx) => {
    await tx.execute({ sql: `DELETE FROM episodic_edge WHERE source_node_uuid=?`, args: [uuid] });
    await tx.execute({ sql: `DELETE FROM episodic_node_fts WHERE uuid=?`, args: [uuid] });
    await tx.execute({ sql: `DELETE FROM episodic_node WHERE uuid=?`, args: [uuid] });
  });
}

export async function clearGroup(groupId) {
  const db = getDb();
  const groupTables = ['entity_edge', 'episodic_edge', 'community_edge', 'has_episode_edge', 'next_episode_edge', 'entity_node', 'episodic_node', 'community_node', 'saga_node'];
  await withTx(db, async (tx) => {
    for (const t of groupTables) {
      await tx.execute({ sql: `DELETE FROM ${t} WHERE group_id=?`, args: [groupId] });
    }
    await tx.execute({ sql: `DELETE FROM entity_node_fts`, args: [] });
    await tx.execute({ sql: `DELETE FROM entity_edge_fts`, args: [] });
    await tx.execute({ sql: `DELETE FROM episodic_node_fts`, args: [] });
    await tx.execute({ sql: `DELETE FROM community_node_fts`, args: [] });
  });
  await rebuildFts();
}

async function rebuildFts() {
  const db = getDb();
  const nodes = await db.execute({ sql: `SELECT uuid, name, summary FROM entity_node`, args: [] });
  const edges = await db.execute({ sql: `SELECT uuid, fact FROM entity_edge`, args: [] });
  const epis = await db.execute({ sql: `SELECT uuid, name, content FROM episodic_node`, args: [] });
  const comms = await db.execute({ sql: `SELECT uuid, name, summary FROM community_node`, args: [] });
  await withTx(db, async (tx) => {
    for (const n of nodes.rows) await tx.execute({ sql: `INSERT INTO entity_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [n.uuid, n.name, n.summary || ''] });
    for (const e of edges.rows) await tx.execute({ sql: `INSERT INTO entity_edge_fts(uuid,fact) VALUES(?,?)`, args: [e.uuid, e.fact] });
    for (const ep of epis.rows) await tx.execute({ sql: `INSERT INTO episodic_node_fts(uuid,name,content) VALUES(?,?,?)`, args: [ep.uuid, ep.name, ep.content] });
    for (const c of comms.rows) await tx.execute({ sql: `INSERT INTO community_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [c.uuid, c.name, c.summary || ''] });
  });
}

export { rebuildFts };
