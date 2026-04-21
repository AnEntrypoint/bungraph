import { v4 as uuidv4 } from 'uuid';
import { embed, embedOne } from './embeddings.js';
import { getLLM } from './llm.js';
import { promptLibrary } from './prompts/index.js';
import { vectorSearchNodes } from './store.js';
import {
  buildCandidateIndexes, createDedupState, resolveWithSimilarity, promoteResolvedNode,
  normalizeExact,
} from './dedup-helpers.js';
import { MAX_SUMMARY_CHARS, truncateAtSentence } from './text-utils.js';
import { logger } from './logger.js';

const log = logger.child('node-ops');

export const NODE_DEDUP_CANDIDATE_LIMIT = 15;
export const NODE_DEDUP_COSINE_MIN_SCORE = 0.6;
export const MAX_NODES = 30;

export function buildEntityTypesContext(entityTypes) {
  const out = [{
    entity_type_id: 0,
    entity_type_name: 'Entity',
    entity_type_description: 'A specific, identifiable entity that does not fit any of the other listed types. Must still be a concrete, meaningful thing — specific enough to be uniquely identifiable. When in doubt, do not extract the entity.',
  }];
  if (entityTypes) {
    let i = 1;
    for (const [name, model] of Object.entries(entityTypes)) {
      out.push({ entity_type_id: i, entity_type_name: name, entity_type_description: model?.description || model?.__doc__ || 'Custom type' });
      i++;
    }
  }
  return out;
}

function nowIso() { return new Date().toISOString(); }

export async function extractNodes({ episode, previousEpisodes = [], entityTypes = null, excludedEntityTypes = null, customExtractionInstructions = '' }) {
  const llm = getLLM();
  const entityTypesContext = buildEntityTypesContext(entityTypes);
  const context = {
    episode_content: episode.content,
    source_description: episode.source_description || '',
    previous_episodes: previousEpisodes.map(e => e.content),
    entity_types: JSON.stringify(entityTypesContext, null, 2),
    custom_extraction_instructions: customExtractionInstructions || '',
  };

  let prompt;
  if (episode.source === 'message') prompt = promptLibrary.extract_nodes.extract_message(context);
  else if (episode.source === 'json') prompt = promptLibrary.extract_nodes.extract_json(context);
  else prompt = promptLibrary.extract_nodes.extract_text(context);

  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch (err) {
    log.warn('llm extraction failed', { err: err.message, content: episode.content.slice(0, 100) });
    res = { extracted_entities: [] };
  }
  const raw = Array.isArray(res?.extracted_entities) ? res.extracted_entities
    : Array.isArray(res?.entities) ? res.entities : [];

  log.debug('llm response parsed', { rawCount: raw.length, fullResponse: JSON.stringify(res).slice(0, 200) });

  const nodes = [];
  for (const e of raw) {
    if (!e?.name || !String(e.name).trim()) continue;
    const typeIdx = Number(e.entity_type_id ?? 0);
    const typeName = (typeIdx >= 0 && typeIdx < entityTypesContext.length)
      ? entityTypesContext[typeIdx].entity_type_name : 'Entity';
    if (excludedEntityTypes && excludedEntityTypes.includes(typeName)) continue;
    const labels = Array.from(new Set(['Entity', typeName]));
    nodes.push({
      uuid: uuidv4(), name: String(e.name).trim(),
      group_id: episode.group_id, labels, attributes: {}, summary: '',
      name_embedding: null, created_at: nowIso(),
    });
  }

  log.debug('nodes extracted', { count: nodes.length, content: episode.content.slice(0, 100) });
  return collapseExactDuplicateExtractedNodes(nodes);
}

function collapseExactDuplicateExtractedNodes(nodes) {
  if (nodes.length < 2) return nodes;
  const byName = new Map();
  const order = [];
  for (const n of nodes) {
    const key = normalizeExact(n.name);
    const existing = byName.get(key);
    if (!existing) { byName.set(key, n); order.push(key); continue; }
    const existingSpecific = existing.labels.filter(l => l !== 'Entity').length;
    const nodeSpecific = n.labels.filter(l => l !== 'Entity').length;
    if (nodeSpecific > existingSpecific || (nodeSpecific === existingSpecific && n.name.length > existing.name.length)) {
      byName.set(key, n);
    }
  }
  return order.map(k => byName.get(k));
}

export async function semanticCandidateSearch(extractedNodes) {
  if (!extractedNodes.length) return [];
  const queries = extractedNodes.map(n => n.name.replace(/\n/g, ' '));
  const vectors = await embed(queries);
  const results = [];
  for (let i = 0; i < extractedNodes.length; i++) {
    const rows = await vectorSearchNodes(vectors[i], [extractedNodes[i].group_id], NODE_DEDUP_CANDIDATE_LIMIT);
    const filtered = rows.filter(r => (1 - (r.dist || 0)) >= NODE_DEDUP_COSINE_MIN_SCORE);
    results.push({ candidates: filtered, vector: vectors[i] });
  }
  return results;
}

export async function resolveExtractedNodes({ extractedNodes, episode = null, previousEpisodes = null, entityTypes = null, existingNodesOverride = null }) {
  if (!extractedNodes.length) return { resolved: [], uuidMap: {}, duplicatePairs: [] };
  const llm = getLLM();
  const searchResults = await semanticCandidateSearch(extractedNodes);

  const state = createDedupState(extractedNodes.length);

  for (let i = 0; i < extractedNodes.length; i++) {
    const sr = searchResults[i];
    extractedNodes[i].name_embedding = sr?.vector;
    const candidates = sr?.candidates || [];
    if (!candidates.length) continue;
    const indexes = buildCandidateIndexes(candidates);
    const localState = createDedupState(1);
    resolveWithSimilarity([extractedNodes[i]], indexes, localState);
    if (localState.resolvedNodes[0]) {
      state.resolvedNodes[i] = localState.resolvedNodes[0];
      Object.assign(state.uuidMap, localState.uuidMap);
      state.duplicatePairs.push(...localState.duplicatePairs);
      continue;
    }
    state.unresolvedIndices.push(i);
  }

  if (state.unresolvedIndices.length) {
    const merged = new Map();
    for (const i of state.unresolvedIndices) {
      for (const c of searchResults[i]?.candidates || []) {
        if (!merged.has(c.uuid)) merged.set(c.uuid, c);
      }
    }
    const llmCandidates = [...merged.values()];
    await resolveWithLLM({
      llm, extractedNodes, candidates: llmCandidates, state, episode, previousEpisodes, entityTypes,
    });
  }

  for (let i = 0; i < extractedNodes.length; i++) {
    if (!state.resolvedNodes[i]) {
      state.resolvedNodes[i] = extractedNodes[i];
      state.uuidMap[extractedNodes[i].uuid] = extractedNodes[i].uuid;
    }
  }

  return {
    resolved: state.resolvedNodes.filter(Boolean),
    uuidMap: state.uuidMap,
    duplicatePairs: state.duplicatePairs,
  };
}

async function resolveWithLLM({ llm, extractedNodes, candidates, state, episode, previousEpisodes, entityTypes }) {
  if (!state.unresolvedIndices.length) return;
  const llmNodes = state.unresolvedIndices.map(i => extractedNodes[i]);
  const extractedCtx = llmNodes.map((n, i) => ({
    id: i, name: n.name, entity_type: n.labels,
    entity_type_description: (n.labels.find(l => l !== 'Entity') || 'Entity'),
  }));
  const existingCtx = candidates.map((c, i) => ({
    ...(typeof c.attributes === 'string' ? JSON.parse(c.attributes || '{}') : c.attributes || {}),
    candidate_id: i, name: c.name,
    entity_types: typeof c.labels === 'string' ? JSON.parse(c.labels || '[]') : c.labels,
    summary: (c.summary || '').slice(0, 120),
  }));

  const prompt = promptLibrary.dedupe_nodes.nodes({
    extracted_nodes: extractedCtx,
    existing_nodes: existingCtx,
    episode_content: episode?.content || '',
    previous_episodes: (previousEpisodes || []).map(e => e.content),
  });

  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch { res = { entity_resolutions: [] }; }
  const resolutions = Array.isArray(res?.entity_resolutions) ? res.entity_resolutions : [];
  const processed = new Set();
  for (const r of resolutions) {
    const rid = Number(r.id);
    if (processed.has(rid) || rid < 0 || rid >= state.unresolvedIndices.length) continue;
    processed.add(rid);
    const origIdx = state.unresolvedIndices[rid];
    const ext = extractedNodes[origIdx];
    const dupId = Number(r.duplicate_candidate_id);
    let resolved;
    if (dupId < 0) {
      resolved = ext;
    } else if (dupId >= 0 && dupId < candidates.length) {
      resolved = promoteResolvedNode(ext, candidates[dupId]);
    } else {
      resolved = ext;
    }
    state.resolvedNodes[origIdx] = resolved;
    state.uuidMap[ext.uuid] = resolved.uuid;
    if (resolved.uuid !== ext.uuid) state.duplicatePairs.push([ext, resolved]);
  }
}

export async function extractAttributesFromNodes({ nodes, episode = null, previousEpisodes = null, entityTypes = null, edges = null, skipFactAppending = false }) {
  const llm = getLLM();
  const edgesByNode = buildEdgesByNode(edges);

  for (const node of nodes) {
    const typeName = node.labels.find(l => l !== 'Entity');
    const typeModel = entityTypes && typeName ? entityTypes[typeName] : null;
    if (typeModel && typeModel.attributes && Object.keys(typeModel.attributes).length > 0) {
      const ctx = {
        node: { name: node.name, entity_types: node.labels, attributes: node.attributes },
        episode_content: episode?.content || '',
        previous_episodes: (previousEpisodes || []).map(e => e.content),
      };
      const prompt = promptLibrary.extract_nodes.extract_attributes(ctx);
      let res;
      try { res = await llm.generate(prompt.system, prompt.user); }
      catch { res = {}; }
      const attrs = res?.attributes || res || {};
      if (attrs && typeof attrs === 'object') Object.assign(node.attributes, attrs);
    }
  }

  await extractEntitySummariesBatch({ nodes, episode, previousEpisodes, edgesByNode, skipFactAppending });

  for (const n of nodes) {
    if (!n.name_embedding) n.name_embedding = await embedOne(n.name);
  }

  return nodes;
}

function buildEdgesByNode(edges) {
  const out = {};
  if (!edges) return out;
  for (const e of edges) {
    if (!out[e.source_node_uuid]) out[e.source_node_uuid] = [];
    if (!out[e.target_node_uuid]) out[e.target_node_uuid] = [];
    out[e.source_node_uuid].push(e);
    out[e.target_node_uuid].push(e);
  }
  return out;
}

async function extractEntitySummariesBatch({ nodes, episode, previousEpisodes, edgesByNode, skipFactAppending }) {
  const needLLM = [];
  for (const node of nodes) {
    if (skipFactAppending) {
      if (episode || node.summary) needLLM.push(node);
      continue;
    }
    const nodeEdges = edgesByNode[node.uuid] || [];
    let summaryWithEdges = node.summary || '';
    if (nodeEdges.length) {
      const facts = nodeEdges.map(e => e.fact).filter(Boolean).join('\n');
      summaryWithEdges = (summaryWithEdges + '\n' + facts).trim();
    }
    if (summaryWithEdges && summaryWithEdges.length <= MAX_SUMMARY_CHARS * 2) {
      node.summary = summaryWithEdges;
      continue;
    }
    if (!summaryWithEdges && !episode) continue;
    needLLM.push(node);
  }

  if (!needLLM.length) return;

  const flights = [];
  for (let i = 0; i < needLLM.length; i += MAX_NODES) flights.push(needLLM.slice(i, i + MAX_NODES));

  await Promise.all(flights.map(flight => processSummaryFlight({ nodes: flight, episode, previousEpisodes, useEpisodePrompt: skipFactAppending })));
}

async function processSummaryFlight({ nodes, episode, previousEpisodes, useEpisodePrompt = false }) {
  const llm = getLLM();
  const entitiesCtx = nodes.map(n => ({ name: n.name, summary: n.summary, entity_types: n.labels, attributes: n.attributes }));
  const ctx = {
    entities: entitiesCtx,
    episode_content: episode?.content || '',
    previous_episodes: (previousEpisodes || []).map(e => e.content),
  };
  const prompt = useEpisodePrompt
    ? promptLibrary.extract_nodes.extract_entity_summaries_from_episodes(ctx)
    : promptLibrary.extract_nodes.extract_summaries_batch(ctx);
  let res;
  try { res = await llm.generate(prompt.system, prompt.user); }
  catch { res = { summaries: [] }; }
  const summaries = Array.isArray(res?.summaries) ? res.summaries : [];

  const nameToNodes = new Map();
  for (const n of nodes) {
    const k = n.name.toLowerCase();
    if (!nameToNodes.has(k)) nameToNodes.set(k, []);
    nameToNodes.get(k).push(n);
  }
  for (const s of summaries) {
    const targets = nameToNodes.get((s.name || '').toLowerCase()) || [];
    const truncated = truncateAtSentence(s.summary || '', MAX_SUMMARY_CHARS);
    for (const n of targets) n.summary = truncated;
  }
}
