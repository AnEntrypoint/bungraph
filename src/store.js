import { createClient } from '@libsql/client';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let db = null;
let dim = 384;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entity_node (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT DEFAULT '',
    labels TEXT DEFAULT '[]',
    attributes TEXT DEFAULT '{}',
    name_embedding F32_BLOB(384),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS entity_node_group ON entity_node(group_id)`,
  `CREATE INDEX IF NOT EXISTS entity_node_vec ON entity_node(libsql_vector_idx(name_embedding))`,

  `CREATE TABLE IF NOT EXISTS episodic_node (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    source_description TEXT DEFAULT '',
    content TEXT NOT NULL,
    valid_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    entity_edges TEXT DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS episodic_node_group ON episodic_node(group_id)`,
  `CREATE INDEX IF NOT EXISTS episodic_node_valid ON episodic_node(valid_at)`,

  `CREATE TABLE IF NOT EXISTS community_node (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT DEFAULT '',
    name_embedding F32_BLOB(384),
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS community_node_group ON community_node(group_id)`,
  `CREATE INDEX IF NOT EXISTS community_node_vec ON community_node(libsql_vector_idx(name_embedding))`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS community_node_fts USING fts5(uuid UNINDEXED, name, summary, tokenize='porter unicode61')`,

  `CREATE TABLE IF NOT EXISTS saga_node (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS saga_node_group ON saga_node(group_id)`,

  `CREATE TABLE IF NOT EXISTS has_episode_edge (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_node_uuid TEXT NOT NULL,
    target_node_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS has_episode_edge_src ON has_episode_edge(source_node_uuid)`,

  `CREATE TABLE IF NOT EXISTS next_episode_edge (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_node_uuid TEXT NOT NULL,
    target_node_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS next_episode_edge_src ON next_episode_edge(source_node_uuid)`,

  `CREATE TABLE IF NOT EXISTS entity_edge (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_node_uuid TEXT NOT NULL,
    target_node_uuid TEXT NOT NULL,
    name TEXT NOT NULL,
    fact TEXT NOT NULL,
    fact_embedding F32_BLOB(384),
    episodes TEXT DEFAULT '[]',
    attributes TEXT DEFAULT '{}',
    valid_at TEXT,
    invalid_at TEXT,
    expired_at TEXT,
    reference_time TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS entity_edge_group ON entity_edge(group_id)`,
  `CREATE INDEX IF NOT EXISTS entity_edge_source ON entity_edge(source_node_uuid)`,
  `CREATE INDEX IF NOT EXISTS entity_edge_target ON entity_edge(target_node_uuid)`,
  `CREATE INDEX IF NOT EXISTS entity_edge_vec ON entity_edge(libsql_vector_idx(fact_embedding))`,
  `CREATE INDEX IF NOT EXISTS entity_edge_active ON entity_edge(group_id, source_node_uuid, name) WHERE expired_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS entity_edge_active_target ON entity_edge(group_id, target_node_uuid, name) WHERE expired_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS entity_edge_temporal ON entity_edge(group_id, source_node_uuid, name, valid_at, expired_at)`,

  `CREATE TABLE IF NOT EXISTS episodic_edge (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_node_uuid TEXT NOT NULL,
    target_node_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS episodic_edge_source ON episodic_edge(source_node_uuid)`,
  `CREATE INDEX IF NOT EXISTS episodic_edge_target ON episodic_edge(target_node_uuid)`,

  `CREATE TABLE IF NOT EXISTS community_edge (
    uuid TEXT PRIMARY KEY,
    group_id TEXT NOT NULL,
    source_node_uuid TEXT NOT NULL,
    target_node_uuid TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS entity_node_fts USING fts5(uuid UNINDEXED, name, summary, tokenize='porter unicode61')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS entity_edge_fts USING fts5(uuid UNINDEXED, fact, tokenize='porter unicode61')`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS episodic_node_fts USING fts5(uuid UNINDEXED, name, content, tokenize='porter unicode61')`,
];

const PRAGMAS = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL`,
  `PRAGMA temp_store = MEMORY`,
  `PRAGMA mmap_size = 268435456`,
  `PRAGMA cache_size = -65536`,
  `PRAGMA busy_timeout = 5000`,
  `PRAGMA foreign_keys = ON`,
];

export async function initStore(dbPath) {
  if (dbPath && !existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  db = createClient({ url: `file:${dbPath}` });
  for (const p of PRAGMAS) { try { await db.execute(p); } catch {} }
  for (const q of SCHEMA) await db.execute(q);
  try { await db.execute(`PRAGMA optimize`); } catch {}
  return db;
}

export function getDb() {
  if (!db) throw new Error('Store not initialized');
  return db;
}

export function vecLit(arr) {
  if (!arr) return null;
  return `vector32('[${Array.from(arr).map(Number).join(',')}]')`;
}

export async function upsertEntityNode(n) {
  await db.execute({
    sql: `INSERT INTO entity_node(uuid,group_id,name,summary,labels,attributes,name_embedding,created_at)
          VALUES(?,?,?,?,?,?,${vecLit(n.name_embedding)},?)
          ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, summary=excluded.summary,
            labels=excluded.labels, attributes=excluded.attributes, name_embedding=excluded.name_embedding`,
    args: [n.uuid, n.group_id, n.name, n.summary || '', JSON.stringify(n.labels || []),
      JSON.stringify(n.attributes || {}), n.created_at],
  });
  await db.execute({ sql: `DELETE FROM entity_node_fts WHERE uuid=?`, args: [n.uuid] });
  await db.execute({
    sql: `INSERT INTO entity_node_fts(uuid,name,summary) VALUES(?,?,?)`,
    args: [n.uuid, n.name, n.summary || ''],
  });
}

export async function upsertEpisodicNode(e) {
  await db.execute({
    sql: `INSERT INTO episodic_node(uuid,group_id,name,source,source_description,content,valid_at,created_at,entity_edges)
          VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(uuid) DO UPDATE SET entity_edges=excluded.entity_edges`,
    args: [e.uuid, e.group_id, e.name, e.source, e.source_description || '', e.content,
      e.valid_at, e.created_at, JSON.stringify(e.entity_edges || [])],
  });
  await db.execute({ sql: `DELETE FROM episodic_node_fts WHERE uuid=?`, args: [e.uuid] });
  await db.execute({
    sql: `INSERT INTO episodic_node_fts(uuid,name,content) VALUES(?,?,?)`,
    args: [e.uuid, e.name, e.content],
  });
}

export async function upsertEntityEdge(e) {
  await db.execute({
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
  await db.execute({ sql: `DELETE FROM entity_edge_fts WHERE uuid=?`, args: [e.uuid] });
  await db.execute({
    sql: `INSERT INTO entity_edge_fts(uuid,fact) VALUES(?,?)`,
    args: [e.uuid, e.fact],
  });
}

export async function upsertEpisodicEdge(e) {
  await db.execute({
    sql: `INSERT OR REPLACE INTO episodic_edge(uuid,group_id,source_node_uuid,target_node_uuid,created_at)
          VALUES(?,?,?,?,?)`,
    args: [e.uuid, e.group_id, e.source_node_uuid, e.target_node_uuid, e.created_at],
  });
}

export async function expireEdge(uuid, expiredAt, invalidAt) {
  await db.execute({
    sql: `UPDATE entity_edge SET expired_at=?, invalid_at=COALESCE(?,invalid_at) WHERE uuid=?`,
    args: [expiredAt, invalidAt || null, uuid],
  });
}

export async function vectorSearchNodes(queryVec, groupIds, limit = 10) {
  const r = await db.execute({
    sql: `SELECT n.uuid, n.name, n.summary, n.labels, n.attributes, n.group_id, n.created_at,
            vector_distance_cos(n.name_embedding, ${vecLit(queryVec)}) AS dist
          FROM vector_top_k('entity_node_vec', ${vecLit(queryVec)}, ?) AS t
          JOIN entity_node n ON n.rowid = t.id
          ${groupIds?.length ? `WHERE n.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY dist ASC LIMIT ?`,
    args: [limit * 4, ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function vectorSearchEdges(queryVec, groupIds, limit = 10) {
  const r = await db.execute({
    sql: `SELECT e.*, vector_distance_cos(e.fact_embedding, ${vecLit(queryVec)}) AS dist
          FROM vector_top_k('entity_edge_vec', ${vecLit(queryVec)}, ?) AS t
          JOIN entity_edge e ON e.rowid = t.id
          ${groupIds?.length ? `WHERE e.group_id IN (${groupIds.map(() => '?').join(',')}) AND (e.expired_at IS NULL)` : `WHERE e.expired_at IS NULL`}
          ORDER BY dist ASC LIMIT ?`,
    args: [limit * 4, ...(groupIds || []), limit],
  });
  return r.rows;
}

function ftsQuery(q) {
  return q.replace(/"/g, '""').split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' OR ');
}

export async function ftsSearchNodes(query, groupIds, limit = 10) {
  const r = await db.execute({
    sql: `SELECT n.*, bm25(entity_node_fts) AS score
          FROM entity_node_fts f JOIN entity_node n ON n.uuid = f.uuid
          WHERE entity_node_fts MATCH ?
          ${groupIds?.length ? `AND n.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY score LIMIT ?`,
    args: [ftsQuery(query), ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function ftsSearchEdges(query, groupIds, limit = 10) {
  const r = await db.execute({
    sql: `SELECT e.*, bm25(entity_edge_fts) AS score
          FROM entity_edge_fts f JOIN entity_edge e ON e.uuid = f.uuid
          WHERE entity_edge_fts MATCH ? AND e.expired_at IS NULL
          ${groupIds?.length ? `AND e.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY score LIMIT ?`,
    args: [ftsQuery(query), ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function getEntityNodesByUuids(uuids) {
  if (!uuids.length) return [];
  const r = await db.execute({
    sql: `SELECT * FROM entity_node WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
    args: uuids,
  });
  return r.rows;
}

export async function getEntityEdgesByUuids(uuids) {
  if (!uuids.length) return [];
  const r = await db.execute({
    sql: `SELECT * FROM entity_edge WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
    args: uuids,
  });
  return r.rows;
}

export async function getEdgesBetween(srcUuids, tgtUuids, groupIds) {
  const r = await db.execute({
    sql: `SELECT * FROM entity_edge
          WHERE source_node_uuid IN (${srcUuids.map(() => '?').join(',')})
          AND target_node_uuid IN (${tgtUuids.map(() => '?').join(',')})
          AND expired_at IS NULL
          ${groupIds?.length ? `AND group_id IN (${groupIds.map(() => '?').join(',')})` : ''}`,
    args: [...srcUuids, ...tgtUuids, ...(groupIds || [])],
  });
  return r.rows;
}

export async function getRecentEpisodes(groupIds, limit = 3, before = null) {
  const r = await db.execute({
    sql: `SELECT * FROM episodic_node
          ${groupIds?.length ? `WHERE group_id IN (${groupIds.map(() => '?').join(',')})` : 'WHERE 1=1'}
          ${before ? 'AND valid_at < ?' : ''}
          ORDER BY valid_at DESC LIMIT ?`,
    args: [...(groupIds || []), ...(before ? [before] : []), limit],
  });
  return r.rows;
}

export async function graphWalk(startUuids, depth = 1, groupIds) {
  if (!startUuids.length) return [];
  const placeholders = startUuids.map(() => '?').join(',');
  const r = await db.execute({
    sql: `WITH RECURSIVE walk(uuid, d) AS (
      SELECT uuid, 0 FROM entity_node WHERE uuid IN (${placeholders})
      UNION
      SELECT CASE WHEN e.source_node_uuid = w.uuid THEN e.target_node_uuid ELSE e.source_node_uuid END, w.d + 1
      FROM walk w JOIN entity_edge e ON (e.source_node_uuid = w.uuid OR e.target_node_uuid = w.uuid)
      WHERE w.d < ? AND e.expired_at IS NULL
    )
    SELECT DISTINCT n.* FROM walk w JOIN entity_node n ON n.uuid = w.uuid WHERE w.d > 0
    ${groupIds?.length ? `AND n.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}`,
    args: [...startUuids, depth, ...(groupIds || [])],
  });
  return r.rows;
}

export async function upsertCommunityNode(c) {
  await db.execute({
    sql: `INSERT INTO community_node(uuid,group_id,name,summary,name_embedding,created_at)
          VALUES(?,?,?,?,${vecLit(c.name_embedding)},?)
          ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, summary=excluded.summary, name_embedding=excluded.name_embedding`,
    args: [c.uuid, c.group_id, c.name, c.summary || '', c.created_at],
  });
  await db.execute({ sql: `DELETE FROM community_node_fts WHERE uuid=?`, args: [c.uuid] });
  await db.execute({
    sql: `INSERT INTO community_node_fts(uuid,name,summary) VALUES(?,?,?)`,
    args: [c.uuid, c.name, c.summary || ''],
  });
}

export async function vectorSearchCommunities(queryVec, groupIds, limit = 10) {
  const r = await db.execute({
    sql: `SELECT c.*, vector_distance_cos(c.name_embedding, ${vecLit(queryVec)}) AS dist
          FROM vector_top_k('community_node_vec', ${vecLit(queryVec)}, ?) AS t
          JOIN community_node c ON c.rowid = t.id
          ${groupIds?.length ? `WHERE c.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY dist ASC LIMIT ?`,
    args: [limit * 4, ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function ftsSearchCommunities(query, groupIds, limit = 10) {
  const ftsQ = query.replace(/"/g, '""').split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' OR ') || query;
  const r = await db.execute({
    sql: `SELECT c.*, bm25(community_node_fts) AS score
          FROM community_node_fts f JOIN community_node c ON c.uuid = f.uuid
          WHERE community_node_fts MATCH ?
          ${groupIds?.length ? `AND c.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY score LIMIT ?`,
    args: [ftsQ, ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function deleteEpisode(uuid) {
  await db.execute({ sql: `DELETE FROM episodic_edge WHERE source_node_uuid=?`, args: [uuid] });
  await db.execute({ sql: `DELETE FROM episodic_node_fts WHERE uuid=?`, args: [uuid] });
  await db.execute({ sql: `DELETE FROM episodic_node WHERE uuid=?`, args: [uuid] });
}

export async function clearGroup(groupId) {
  const groupTables = ['entity_edge', 'episodic_edge', 'community_edge', 'has_episode_edge', 'next_episode_edge', 'entity_node', 'episodic_node', 'community_node', 'saga_node'];
  for (const t of groupTables) {
    await db.execute({ sql: `DELETE FROM ${t} WHERE group_id=?`, args: [groupId] });
  }
  // FTS tables have no group_id — rebuild from remaining rows
  await db.execute({ sql: `DELETE FROM entity_node_fts`, args: [] });
  await db.execute({ sql: `DELETE FROM entity_edge_fts`, args: [] });
  await db.execute({ sql: `DELETE FROM episodic_node_fts`, args: [] });
  await db.execute({ sql: `DELETE FROM community_node_fts`, args: [] });
  const nodes = await db.execute({ sql: `SELECT uuid, name, summary FROM entity_node`, args: [] });
  for (const n of nodes.rows) await db.execute({ sql: `INSERT INTO entity_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [n.uuid, n.name, n.summary || ''] });
  const edges = await db.execute({ sql: `SELECT uuid, fact FROM entity_edge`, args: [] });
  for (const e of edges.rows) await db.execute({ sql: `INSERT INTO entity_edge_fts(uuid,fact) VALUES(?,?)`, args: [e.uuid, e.fact] });
  const epis = await db.execute({ sql: `SELECT uuid, name, content FROM episodic_node`, args: [] });
  for (const ep of epis.rows) await db.execute({ sql: `INSERT INTO episodic_node_fts(uuid,name,content) VALUES(?,?,?)`, args: [ep.uuid, ep.name, ep.content] });
  const comms = await db.execute({ sql: `SELECT uuid, name, summary FROM community_node`, args: [] });
  for (const c of comms.rows) await db.execute({ sql: `INSERT INTO community_node_fts(uuid,name,summary) VALUES(?,?,?)`, args: [c.uuid, c.name, c.summary || ''] });
}

export async function closeStore() {
  if (db) { db.close(); db = null; }
}
