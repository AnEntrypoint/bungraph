#!/usr/bin/env node
import { Graphiti } from './src/index.js';
import { resolve } from 'path';

const timestamp = Date.now();
const dbPath = resolve(`.epoch-research-${timestamp}.db`);

const g = new Graphiti({ dbPath, groupId: 'tiger-research' });
await g.init();

const epochs = [
  'Bengal tigers are the most common tiger subspecies found across India, Bangladesh, and Nepal.',
  'Tigers are solitary apex predators that hunt large ungulates like deer, wild boar, and sambar.',
  'A single tiger needs a territory of 50-100 km² depending on prey density and forest type.',
  'Tigers are excellent swimmers and can cross rivers up to 10 km wide.',
  'Tiger cubs stay with their mother for 2-3 years learning hunting and survival skills.',
  'White tigers are rare color variants caused by recessive genes found mainly in captivity.',
  'The Siberian tiger is the largest tiger subspecies weighing up to 300 kg.',
  'Tiger populations have declined by 93% in the past century due to habitat loss and poaching.',
  'A tiger\'s roar can be heard up to 3 km away and serves to mark territory.',
  'Tigers have unique stripe patterns like human fingerprints used for individual identification.'
];

console.log('=== 10-EPOCH TIGER RESEARCH ===\n');
const results = [];
let totalNodes = 0;
let totalEdges = 0;
const EPOCH_TIMEOUT_MS = 45000;

for (let i = 0; i < epochs.length; i++) {
  const start = Date.now();
  let status = 'pending';
  let ep = null;

  try {
    ep = await Promise.race([
      g.addEpisode({ content: epochs[i], source: 'text' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${EPOCH_TIMEOUT_MS}ms`)), EPOCH_TIMEOUT_MS)
      )
    ]);
    status = 'success';
  } catch (e) {
    status = 'error';
    console.error(`[epoch ${i+1}] ✗ ${e.message}`);
  }

  const elapsed = Date.now() - start;

  if (status === 'success' && ep) {
    totalNodes += ep.nodes.length;
    totalEdges += ep.edges.length;
    results.push({
      epoch: i + 1,
      nodes: ep.nodes.length,
      edges: ep.edges.length,
      elapsed,
      nodeNames: ep.nodes.map(n => n.name),
      status: 'success',
    });
    console.log(`[epoch ${i+1}] ✓ ${ep.nodes.length}n ${ep.edges.length}e (${elapsed}ms)`);
  } else {
    results.push({
      epoch: i + 1,
      nodes: 0,
      edges: 0,
      elapsed,
      nodeNames: [],
      status,
    });
  }
  process.stdout.flush && process.stdout.flush();
}

console.log('\n=== SUMMARY ===');
const succeeded = results.filter(r => r.status === 'success').length;
const timedout = results.filter(r => r.status === 'error').length;
console.log(`Total epochs: ${epochs.length} (${succeeded} succeeded, ${timedout} timeout/error)`);
console.log(`Total nodes: ${totalNodes} (avg: ${(succeeded > 0 ? (totalNodes/succeeded).toFixed(1) : 0)} per succeeded epoch)`);
console.log(`Total edges: ${totalEdges}`);

console.log('\nPer-epoch breakdown:');
results.forEach(r => {
  if (r.status === 'success') {
    console.log(`  Epoch ${r.epoch}: ${r.nodes}n ${r.edges}e (${r.elapsed}ms) - ${r.nodeNames.join(', ')}`);
  } else {
    console.log(`  Epoch ${r.epoch}: ✗ ${r.status} (${r.elapsed}ms)`);
  }
});

if (succeeded === 0) {
  console.log('\n✗ All epochs failed or timed out');
  process.exit(1);
}

if (totalNodes < succeeded * 2) {
  console.log(`\n⚠ WARNING: Low extraction (got ${totalNodes}, expected >=2 per succeeded epoch)`);
}

console.log(`\n✓ Completed ${succeeded}/${epochs.length} epochs`);
process.exit(0);
