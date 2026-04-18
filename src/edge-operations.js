import { v4 as uuidv4 } from 'uuid';
import { embedOne } from './embeddings.js';
import { getLLM } from './llm.js';
import { promptLibrary } from './prompts/index.js';
import { vectorSearchEdges, getEdgesBetween } from './store.js';

export const EDGE_DEDUP_CANDIDATE_LIMIT = 10;

function nowIso() { return new Date().toISOString(); }

export async function extractEdges({ episode, nodes, previousEpisodes = [], edgeTypes = null, customExtractionInstructions = '' }) {
  if (nodes.length < 2) return [];
  const llm = getLLM();
  const prompt = promptLibrary.extract_edges.edge({
    episode_content: episode.content,
    previous_episodes: previousEpisodes.map(e => e.content),
    nodes: nodes.map(n => ({ name: n.name })),
    reference_time: episode.valid_at,
    edge_types: edgeTypes,
    custom_extraction_instructions: customExtractionInstructions || '',
  });
  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch (e) { console.error('[bungraph] extractEdges LLM failed:', e?.message || e); res = { edges: [] }; }
  const raw = Array.isArray(res?.edges) ? res.edges : [];

  const nameToUuid = new Map(nodes.map(n => [n.name.toLowerCase(), n.uuid]));
  const edges = [];
  for (const ex of raw) {
    if (!ex?.source_entity_name || !ex?.target_entity_name || !ex?.fact) continue;
    const src = nameToUuid.get(String(ex.source_entity_name).toLowerCase());
    const tgt = nameToUuid.get(String(ex.target_entity_name).toLowerCase());
    if (!src || !tgt || src === tgt) continue;
    edges.push({
      uuid: uuidv4(),
      group_id: episode.group_id,
      source_node_uuid: src,
      target_node_uuid: tgt,
      name: ex.relation_type || 'RELATES_TO',
      fact: ex.fact,
      fact_embedding: null,
      episodes: [episode.uuid],
      attributes: {},
      valid_at: ex.valid_at || null,
      invalid_at: ex.invalid_at || null,
      expired_at: null,
      reference_time: episode.valid_at,
      created_at: nowIso(),
    });
  }
  return edges;
}

export async function resolveExtractedEdge({ newEdge, existingEdges = [], invalidationCandidates = [] }) {
  if (!existingEdges.length && !invalidationCandidates.length) {
    return { duplicateOf: null, contradicted: [] };
  }
  const llm = getLLM();
  const existingCtx = existingEdges.map((e, i) => ({ idx: i, fact: e.fact, name: e.name, valid_at: e.valid_at }));
  const invalCtx = invalidationCandidates.map((e, i) => ({
    idx: existingEdges.length + i, fact: e.fact, name: e.name, valid_at: e.valid_at,
  }));
  const prompt = promptLibrary.dedupe_edges.resolve_edge({
    existing_edges: existingCtx,
    edge_invalidation_candidates: invalCtx,
    new_edge: { fact: newEdge.fact, name: newEdge.name },
  });
  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch { res = { duplicate_facts: [], contradicted_facts: [] }; }
  const dupes = (res?.duplicate_facts || []).filter(i => i >= 0 && i < existingEdges.length);
  const contras = (res?.contradicted_facts || []);
  const duplicateOf = dupes.length ? existingEdges[dupes[0]] : null;
  const contradicted = [];
  for (const i of contras) {
    if (i >= 0 && i < existingEdges.length) contradicted.push(existingEdges[i]);
    else if (i >= existingEdges.length && i < existingEdges.length + invalidationCandidates.length) {
      contradicted.push(invalidationCandidates[i - existingEdges.length]);
    }
  }
  return { duplicateOf, contradicted };
}

export async function resolveExtractedEdges({ extractedEdges, episode }) {
  const results = [];
  for (const newEdge of extractedEdges) {
    if (!newEdge.fact_embedding) newEdge.fact_embedding = await embedOne(newEdge.fact);
    const existing = await getEdgesBetween(
      [newEdge.source_node_uuid, newEdge.target_node_uuid],
      [newEdge.source_node_uuid, newEdge.target_node_uuid],
      [newEdge.group_id]
    );
    const existingUuids = new Set(existing.map(e => e.uuid));
    // broader semantic candidates for contradiction detection
    const semanticCandidates = await vectorSearchEdges(newEdge.fact_embedding, [newEdge.group_id], EDGE_DEDUP_CANDIDATE_LIMIT);
    const invalidationCandidates = semanticCandidates.filter(e => !existingUuids.has(e.uuid));
    const { duplicateOf, contradicted } = await resolveExtractedEdge({
      newEdge, existingEdges: existing, invalidationCandidates,
    });
    results.push({ newEdge, duplicateOf, contradicted });
  }
  return results;
}

export function buildEpisodicEdges({ episode, nodes }) {
  const edges = [];
  for (const n of nodes) {
    edges.push({
      uuid: uuidv4(),
      group_id: episode.group_id,
      source_node_uuid: episode.uuid,
      target_node_uuid: n.uuid,
      created_at: nowIso(),
    });
  }
  return edges;
}

export async function extractEdgeAttributes({ edge, edgeTypes }) {
  if (!edgeTypes) return edge;
  const type = edgeTypes[edge.name];
  if (!type || !type.attributes) return edge;
  const llm = getLLM();
  const prompt = promptLibrary.extract_edges.extract_attributes({
    fact: edge.fact,
    reference_time: edge.reference_time || edge.valid_at || '',
    existing_attributes: edge.attributes || {},
    attribute_descriptions: type.attributes,
  });
  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch { res = {}; }
  const attrs = res?.attributes || {};
  edge.attributes = { ...edge.attributes, ...attrs };
  return edge;
}
