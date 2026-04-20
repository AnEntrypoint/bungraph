export const EMBED_DIM_DEFAULT = 384;

export const SCHEMA = [
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
  `CREATE INDEX IF NOT EXISTS entity_edge_valid ON entity_edge(group_id, valid_at, invalid_at, expired_at) WHERE expired_at IS NULL`,

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

export const PRAGMAS = [
  `PRAGMA journal_mode = WAL`,
  `PRAGMA synchronous = NORMAL`,
  `PRAGMA temp_store = MEMORY`,
  `PRAGMA mmap_size = 268435456`,
  `PRAGMA cache_size = -65536`,
  `PRAGMA busy_timeout = 5000`,
  `PRAGMA foreign_keys = ON`,
  `PRAGMA wal_autocheckpoint = 1000`,
];

export const MIGRATIONS = [];

export function activeAtClause(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `(${p}expired_at IS NULL OR ${p}expired_at > ?) AND (${p}invalid_at IS NULL OR ${p}invalid_at > ?) AND (${p}valid_at IS NULL OR ${p}valid_at <= ?)`;
}

export function activeAtArgs(asOf) { return [asOf, asOf, asOf]; }
