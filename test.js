import { Graphiti } from './src/index.js';
import { getLLM } from './src/llm.js';
import {
  NODE_HYBRID_SEARCH_RRF, NODE_HYBRID_SEARCH_MMR, EDGE_HYBRID_SEARCH_RRF,
  COMBINED_HYBRID_SEARCH_RRF,
} from './src/search-recipes.js';
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import assert from 'node:assert';
import { snapshot } from './src/debug-registry.js';
import { logger, redactFields, redactString } from './src/logger.js';
import { validate, HttpSearchInput, AddEpisodeInput, GroupId } from './src/validation.js';
import { withTx, txStats } from './src/store-tx.js';
import { getDb, upsertEntityEdge, upsertEntityNode, checkpoint } from './src/store.js';
import { embedOne } from './src/embeddings.js';

const dbPath = resolve('.bundag-test.db');
if (existsSync(dbPath)) rmSync(dbPath);
if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');

console.log('[test] validation schemas');
assert.equal(validate(HttpSearchInput, { query: 'x' }).ok, true);
assert.equal(validate(HttpSearchInput, { query: 'x', as_of: '2024-01-01T00:00:00Z' }).ok, true);
assert.equal(validate(HttpSearchInput, { query: 'x', unknown: 1 }).ok, false);
assert.equal(validate(HttpSearchInput, { query: 'x', as_of: 'bogus' }).ok, false);
assert.equal(validate(AddEpisodeInput, { content: '' }).ok, false);
assert.equal(validate(AddEpisodeInput, { content: 'a', group_id: 'bad id!' }).ok, false);
assert.equal(GroupId.safeParse('ok_group-1.v2').success, true);
assert.equal(GroupId.safeParse('bad/slash').success, false);

console.log('[test] logger redaction');
process.env.ANTHROPIC_API_KEY = 'sk-ant-abcdef123456xyz';
const r1 = redactString('prefix sk-ant-abcdef123456xyz suffix');
assert.ok(!r1.includes('sk-ant-abcdef123456xyz'));
assert.ok(r1.includes('[REDACTED]'));
const r2 = redactFields({ apiKey: 'secret', visible: 'ok', nested: { authorization: 'Bearer x', other: 'y' } });
assert.equal(r2.apiKey, '[REDACTED]');
assert.equal(r2.visible, 'ok');
assert.equal(r2.nested.authorization, '[REDACTED]');
assert.equal(r2.nested.other, 'y');

console.log('[test] init graph');
const g = new Graphiti({ dbPath, groupId: 'test' });
await g.init();

console.log('[test] embed sanity');
const { EMBED_DIM } = await import('./src/embeddings.js');
const v = await embedOne('hello world');
assert.equal(v.length, EMBED_DIM);

console.log('[test] store + FTS round-trip');
const { upsertEntityNode: upsertNode, vectorSearchNodes, ftsSearchNodes } = await import('./src/store.js');
await upsertNode({
  uuid: 'n1', group_id: 'test', name: 'Alice', summary: '', labels: [], attributes: {},
  name_embedding: v, created_at: new Date().toISOString(),
});
assert.ok((await vectorSearchNodes(v, ['test'], 5)).length >= 1);
assert.ok((await ftsSearchNodes('Alice', ['test'], 5)).length >= 1);

console.log('[test] bitemporal asOf edge visibility');
const now = new Date().toISOString();
const aEmb = await embedOne('A');
const bEmb = await embedOne('B');
await upsertNode({ uuid: 'a1', group_id: 'test', name: 'A', summary: '', labels: [], attributes: {}, name_embedding: aEmb, created_at: now });
await upsertNode({ uuid: 'b1', group_id: 'test', name: 'B', summary: '', labels: [], attributes: {}, name_embedding: bEmb, created_at: now });
const factEmb = await embedOne('A likes B');
await upsertEntityEdge({
  uuid: 'e-old', group_id: 'test', source_node_uuid: 'a1', target_node_uuid: 'b1',
  name: 'LIKES', fact: 'A likes B', fact_embedding: factEmb, episodes: [], attributes: {},
  valid_at: '2024-01-01T00:00:00Z', invalid_at: null, expired_at: '2025-01-01T00:00:00Z',
  reference_time: '2024-01-01T00:00:00Z', created_at: now,
});
await upsertEntityEdge({
  uuid: 'e-new', group_id: 'test', source_node_uuid: 'a1', target_node_uuid: 'b1',
  name: 'LIKES', fact: 'A still likes B', fact_embedding: factEmb, episodes: [], attributes: {},
  valid_at: '2025-01-01T00:00:00Z', invalid_at: null, expired_at: null,
  reference_time: '2025-01-01T00:00:00Z', created_at: now,
});
const hist = await g.search('likes', { config: EDGE_HYBRID_SEARCH_RRF, limit: 10, asOf: '2024-06-01T00:00:00Z' });
const histUuids = hist.edges.map(e => e.uuid);
assert.ok(histUuids.includes('e-old'), 'historic asOf should show e-old');
assert.ok(!histUuids.includes('e-new'), 'historic asOf should hide e-new');
const fut = await g.search('likes', { config: EDGE_HYBRID_SEARCH_RRF, limit: 10, asOf: '2025-06-01T00:00:00Z' });
const futUuids = fut.edges.map(e => e.uuid);
assert.ok(futUuids.includes('e-new'), 'future asOf should show e-new');
assert.ok(!futUuids.includes('e-old'), 'future asOf should hide e-old');

console.log('[test] store-tx stats + withTx');
const before = txStats();
await withTx(getDb(), async (tx) => {
  await tx.execute({ sql: `INSERT INTO saga_node (uuid, group_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['s-tx', 'test', 'TxSaga', '', now] });
});
const after = txStats();
assert.ok(after.txCommitted >= before.txCommitted + 1, 'tx should commit');
const row = (await getDb().execute({ sql: `SELECT name FROM saga_node WHERE uuid=?`, args: ['s-tx'] })).rows[0];
assert.equal(row.name, 'TxSaga');

console.log('[test] withTx rolls back on throw');
const beforeRb = txStats();
await assert.rejects(async () => withTx(getDb(), async (tx) => {
  await tx.execute({ sql: `INSERT INTO saga_node (uuid, group_id, name, summary, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: ['s-rb', 'test', 'RB', '', now] });
  throw new Error('force rollback');
}));
const afterRb = txStats();
assert.ok(afterRb.txRolledBack >= beforeRb.txRolledBack + 1);
const rbCheck = (await getDb().execute({ sql: `SELECT COUNT(*) AS c FROM saga_node WHERE uuid=?`, args: ['s-rb'] })).rows[0];
assert.equal(Number(rbCheck.c), 0);

console.log('[test] debug snapshot exposes subsystems');
const snap = snapshot();
assert.ok(snap.subsystems['store.tx']);
assert.ok(snap.subsystems['store']);
assert.ok(snap.subsystems['embeddings']);
assert.ok(typeof snap.memory_mb === 'number');

console.log('[test] addTriplet round-trip');
const t = await g.addTriplet({ sourceName: 'Cat', relation: 'CHASES', targetName: 'Mouse', fact: 'Cat chases mouse' });
assert.equal(t.edges.length, 1);
const lookup = await g.search('chases', { config: EDGE_HYBRID_SEARCH_RRF, limit: 5 });
assert.ok(lookup.edges.some(e => e.name === 'CHASES'));

await checkpoint('TRUNCATE');

if (process.env.BUNDAG_SKIP_LLM) {
  console.log('[test] OK (offline)');
  try { await getLLM().close(); } catch {}
  process.exit(0);
}

console.log('[test] addEpisode via LLM...');
const ep1 = await g.addEpisode({
  content: 'Alice Johnson joined Acme Corp as a software engineer in March 2024. She works from their Denver office.',
  source: 'text',
});
assert.ok(ep1.nodes.length >= 2 && ep1.edges.length >= 1);

const combined = await g.search('What is Alice role?', { config: COMBINED_HYBRID_SEARCH_RRF, limit: 5 });
assert.ok(combined.nodes.length + combined.edges.length > 0);

const mmrNodes = await g.search('Alice', { config: NODE_HYBRID_SEARCH_MMR, limit: 5 });
assert.ok(mmrNodes.nodes.length >= 1);

try { await getLLM().close(); } catch {}
console.log('[test] OK (full)');
process.exit(0);
