import { Graphiti } from './src/index.js';
import { search } from './src/search.js';
import { getLLM } from './src/llm.js';
import { rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import assert from 'node:assert';

const dbPath = resolve('.bundag-test.db');
if (existsSync(dbPath)) rmSync(dbPath);

console.log('[test] init');
const g = new Graphiti({ dbPath, groupId: 'test' });
await g.init();

console.log('[test] store-only sanity: embed + schema');
const { embedOne, EMBED_DIM } = await import('./src/embeddings.js');
const v = await embedOne('hello world');
assert.equal(v.length, EMBED_DIM, 'embedding dim');
console.log('  embedding ok', v.length);

console.log('[test] store round-trip (no LLM)');
const { upsertEntityNode, vectorSearchNodes, ftsSearchNodes } = await import('./src/store.js');
await upsertEntityNode({
  uuid: 'n1', group_id: 'test', name: 'Alice', summary: 'A software engineer',
  labels: [], attributes: {}, name_embedding: v, created_at: new Date().toISOString(),
});
const vRows = await vectorSearchNodes(v, ['test'], 5);
assert.ok(vRows.length >= 1, 'vector search finds node');
const fRows = await ftsSearchNodes('Alice', ['test'], 5);
assert.ok(fRows.length >= 1, 'fts search finds node');
console.log('  store ok');

if (process.env.BUNDAG_SKIP_LLM) {
  console.log('[test] skipping LLM tests (BUNDAG_SKIP_LLM set)');
  try { await getLLM().close(); } catch {}
  process.exit(0);
}

console.log('[test] addEpisode (LLM via ACP)...');
const r1 = await g.addEpisode({
  content: 'Alice Johnson joined Acme Corp as a software engineer in March 2024. She works from their Denver office.',
  source: 'text',
});
console.log('  ep1:', r1.episode.uuid, 'nodes', r1.nodes.length, 'edges', r1.edges.length);
assert.ok(r1.nodes.length >= 1, 'ep1 should extract nodes');

const r2 = await g.addEpisode({
  content: 'Alice Johnson was promoted to senior engineer at Acme Corp in January 2025.',
  source: 'text',
});
console.log('  ep2:', r2.episode.uuid, 'nodes', r2.nodes.length, 'edges', r2.edges.length);

console.log('[test] search...');
const res = await search({ query: 'What is Alice role?', groupIds: ['test'], limit: 5 });
console.log('  nodes:', res.nodes.map(n => n.name));
console.log('  edges:', res.edges.map(e => e.fact));
assert.ok(res.nodes.length + res.edges.length > 0, 'search should return results');

try { await getLLM().close(); } catch {}
console.log('[test] OK');
process.exit(0);
