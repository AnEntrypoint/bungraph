import { getDb, vecLit } from './store.js';
import { activeAtClause, activeAtArgs } from './store-schema.js';

function ftsQuery(q) {
  return q.replace(/"/g, '""').split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' OR ');
}

export async function vectorSearchNodes(queryVec, groupIds, limit = 10) {
  const db = getDb();
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

export async function vectorSearchEdges(queryVec, groupIds, limit = 10, asOf = null) {
  const db = getDb();
  const where = [];
  const args = [limit * 4];
  if (groupIds?.length) {
    where.push(`e.group_id IN (${groupIds.map(() => '?').join(',')})`);
    args.push(...groupIds);
  }
  if (asOf) {
    where.push(activeAtClause('e'));
    args.push(...activeAtArgs(asOf));
  } else {
    where.push('e.expired_at IS NULL');
  }
  args.push(limit);
  const r = await db.execute({
    sql: `SELECT e.*, vector_distance_cos(e.fact_embedding, ${vecLit(queryVec)}) AS dist
          FROM vector_top_k('entity_edge_vec', ${vecLit(queryVec)}, ?) AS t
          JOIN entity_edge e ON e.rowid = t.id
          WHERE ${where.join(' AND ')}
          ORDER BY dist ASC LIMIT ?`,
    args,
  });
  return r.rows;
}

export async function ftsSearchNodes(query, groupIds, limit = 10) {
  const db = getDb();
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

export async function ftsSearchEdges(query, groupIds, limit = 10, asOf = null) {
  const db = getDb();
  const where = [`entity_edge_fts MATCH ?`];
  const args = [ftsQuery(query)];
  if (asOf) { where.push(activeAtClause('e')); args.push(...activeAtArgs(asOf)); }
  else where.push('e.expired_at IS NULL');
  if (groupIds?.length) { where.push(`e.group_id IN (${groupIds.map(() => '?').join(',')})`); args.push(...groupIds); }
  args.push(limit);
  const r = await db.execute({
    sql: `SELECT e.*, bm25(entity_edge_fts) AS score
          FROM entity_edge_fts f JOIN entity_edge e ON e.uuid = f.uuid
          WHERE ${where.join(' AND ')}
          ORDER BY score LIMIT ?`,
    args,
  });
  return r.rows;
}

export async function vectorSearchCommunities(queryVec, groupIds, limit = 10) {
  const db = getDb();
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
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT c.*, bm25(community_node_fts) AS score
          FROM community_node_fts f JOIN community_node c ON c.uuid = f.uuid
          WHERE community_node_fts MATCH ?
          ${groupIds?.length ? `AND c.group_id IN (${groupIds.map(() => '?').join(',')})` : ''}
          ORDER BY score LIMIT ?`,
    args: [ftsQuery(query), ...(groupIds || []), limit],
  });
  return r.rows;
}

export async function getEntityNodesByUuids(uuids) {
  if (!uuids.length) return [];
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT * FROM entity_node WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
    args: uuids,
  });
  return r.rows;
}

export async function getEntityEdgesByUuids(uuids) {
  if (!uuids.length) return [];
  const db = getDb();
  const r = await db.execute({
    sql: `SELECT * FROM entity_edge WHERE uuid IN (${uuids.map(() => '?').join(',')})`,
    args: uuids,
  });
  return r.rows;
}

export async function getEdgesBetween(srcUuids, tgtUuids, groupIds, asOf = null) {
  const db = getDb();
  const where = [
    `source_node_uuid IN (${srcUuids.map(() => '?').join(',')})`,
    `target_node_uuid IN (${tgtUuids.map(() => '?').join(',')})`,
  ];
  const args = [...srcUuids, ...tgtUuids];
  if (asOf) { where.push(activeAtClause()); args.push(...activeAtArgs(asOf)); }
  else where.push('expired_at IS NULL');
  if (groupIds?.length) { where.push(`group_id IN (${groupIds.map(() => '?').join(',')})`); args.push(...groupIds); }
  const r = await db.execute({
    sql: `SELECT * FROM entity_edge WHERE ${where.join(' AND ')}`,
    args,
  });
  return r.rows;
}

export async function getRecentEpisodes(groupIds, limit = 3, before = null) {
  const db = getDb();
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
  const db = getDb();
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
