import { v4 as uuidv4 } from 'uuid';
import {
  upsertEntityNode, upsertEpisodicNode, upsertEntityEdge, upsertEpisodicEdge,
  expireEdge, getDb,
} from './store.js';
import { embedOne } from './embeddings.js';
import { extractNodes, resolveExtractedNodes, extractAttributesFromNodes } from './node-operations.js';
import { extractEdges, buildEpisodicEdges, extractEdgeAttributes } from './edge-operations.js';
import { retrieveEpisodes } from './graph-data-operations.js';
import { updateCommunity } from './community-operations.js';
import { addEpisodeToSaga } from './saga-operations.js';
import {
  extractNodesAndEdgesBulk, dedupeNodesBulk,
  dedupeEdgesBulk, resolveEdgePointers, addNodesAndEdgesBulk,
} from './bulk-utils.js';
import { validateGroupId } from './namespaces.js';
import { captureEvent } from './telemetry.js';

function nowIso() { return new Date().toISOString(); }

export async function addEpisodeImpl(ctx, {
  name = null, content, source = 'message', sourceDescription = '', validAt = null,
  groupId = null, previousEpisodes = null, sagaUuid = null, entityTypes = null,
  edgeTypes = null, customExtractionInstructions = '', excludedEntityTypes = null,
  updateCommunities = false,
}) {
  const gid = validateGroupId(groupId || ctx.groupId);
  const ets = entityTypes || ctx.entityTypes;
  const edts = edgeTypes || ctx.edgeTypes;
  const excl = excludedEntityTypes || ctx.excludedEntityTypes;

  const episode = {
    uuid: uuidv4(), group_id: gid,
    name: name || String(content).slice(0, 60),
    source, source_description: sourceDescription, content,
    valid_at: validAt || nowIso(), created_at: nowIso(), entity_edges: [],
  };

  const prev = previousEpisodes || await retrieveEpisodes({ groupIds: [gid], referenceTime: episode.valid_at, limit: 3 });
  const extracted = await extractNodes({ episode, previousEpisodes: prev, entityTypes: ets, excludedEntityTypes: excl, customExtractionInstructions });
  const { resolved } = await resolveExtractedNodes({ extractedNodes: extracted, episode, previousEpisodes: prev, entityTypes: ets });
  const rawEdges = await extractEdges({ episode, nodes: resolved, previousEpisodes: prev, edgeTypes: edts, customExtractionInstructions });

  const savedEdges = [];
  for (const ne of rawEdges) {
    if (!ne.fact_embedding) ne.fact_embedding = await embedOne(ne.fact);
    const existing = (await getDb().execute({
      sql: `SELECT * FROM entity_edge WHERE ((source_node_uuid=? AND target_node_uuid=?) OR (source_node_uuid=? AND target_node_uuid=?)) AND group_id=? AND expired_at IS NULL`,
      args: [ne.source_node_uuid, ne.target_node_uuid, ne.target_node_uuid, ne.source_node_uuid, gid],
    })).rows;

    let skip = false;
    if (existing.length) {
      const items = existing.map((e, i) => ({ idx: i, fact: e.fact, name: e.name }));
      const { promptLibrary } = await import('./prompts/index.js');
      const { getLLM } = await import('./llm.js');
      const llm = getLLM();
      const prompt = promptLibrary.dedupe_edges.resolve_edge({
        existing_edges: items, edge_invalidation_candidates: [],
        new_edge: { fact: ne.fact, name: ne.name },
      });
      let res;
      try { res = await llm.generate(prompt.system, prompt.user); }
      catch { res = { duplicate_facts: [], contradicted_facts: [] }; }
      const dupes = new Set(res?.duplicate_facts || []);
      const contras = new Set(res?.contradicted_facts || []);
      for (let i = 0; i < existing.length; i++) {
        if (contras.has(i)) await expireEdge(existing[i].uuid, nowIso(), ne.valid_at || nowIso());
        if (dupes.has(i)) { skip = true; break; }
      }
    }
    if (skip) continue;
    if (edts) await extractEdgeAttributes({ edge: ne, edgeTypes: edts });
    await upsertEntityEdge(ne);
    episode.entity_edges.push(ne.uuid);
    savedEdges.push(ne);
  }

  await extractAttributesFromNodes({ nodes: resolved, episode, previousEpisodes: prev, entityTypes: ets, edges: savedEdges });
  for (const n of resolved) await upsertEntityNode(n);

  const epEdges = buildEpisodicEdges({ episode, nodes: resolved });
  for (const ee of epEdges) await upsertEpisodicEdge(ee);

  if (!ctx.storeRawEpisodeContent) episode.content = '';
  await upsertEpisodicNode(episode);

  if (sagaUuid) {
    const prevEp = prev.length ? prev[prev.length - 1] : null;
    await addEpisodeToSaga({ sagaUuid, episodeUuid: episode.uuid, groupId: gid, previousEpisodeUuid: prevEp?.uuid });
  }
  if (updateCommunities) {
    for (const n of resolved) { try { await updateCommunity({ nodeUuid: n.uuid, groupId: gid }); } catch {} }
  }

  captureEvent('add_episode', { group_id: gid, nodes: resolved.length, edges: savedEdges.length });

  return {
    episode,
    nodes: resolved.map(({ name_embedding, ...rest }) => rest),
    edges: savedEdges.map(({ fact_embedding, ...rest }) => rest),
    episodic_edges: epEdges, communities: [], community_edges: [],
  };
}

export async function addEpisodeBulkImpl(ctx, { episodes, entityTypes = null, edgeTypes = null, groupId = null, customExtractionInstructions = '' }) {
  const gid = validateGroupId(groupId || ctx.groupId);
  const episodeObjs = episodes.map(ep => ({
    uuid: uuidv4(), group_id: ep.group_id || gid,
    name: ep.name || String(ep.content).slice(0, 60),
    source: ep.source || 'message', source_description: ep.source_description || '',
    content: ep.content, valid_at: ep.valid_at || nowIso(),
    created_at: nowIso(), entity_edges: [],
  }));
  const results = await extractNodesAndEdgesBulk({
    episodes: episodeObjs,
    entityTypes: entityTypes || ctx.entityTypes,
    edgeTypes: edgeTypes || ctx.edgeTypes,
    customInstructions: customExtractionInstructions,
  });
  const allNodes = [];
  const allEdges = [];
  for (const { nodes, edges, uuidMap } of results) {
    allNodes.push(...nodes);
    await resolveEdgePointers(edges, uuidMap);
    allEdges.push(...edges);
  }
  const dedupedNodes = await dedupeNodesBulk([allNodes]);
  const dedupedEdges = await dedupeEdgesBulk([allEdges]);
  for (const n of dedupedNodes) if (!n.name_embedding) n.name_embedding = await embedOne(n.name);
  for (const e of dedupedEdges) if (!e.fact_embedding) e.fact_embedding = await embedOne(e.fact);
  await addNodesAndEdgesBulk({ episodes: episodeObjs, nodes: dedupedNodes, edges: dedupedEdges });
  return { episodes: episodeObjs, nodes: dedupedNodes, edges: dedupedEdges };
}

export async function addTripletImpl(ctx, { sourceName, relation, targetName, fact, groupId = null, validAt = null }) {
  const gid = validateGroupId(groupId || ctx.groupId);
  const now = nowIso();
  const srcNode = {
    uuid: uuidv4(), name: sourceName, group_id: gid, labels: ['Entity'],
    attributes: {}, summary: '', name_embedding: await embedOne(sourceName), created_at: now,
  };
  const tgtNode = {
    uuid: uuidv4(), name: targetName, group_id: gid, labels: ['Entity'],
    attributes: {}, summary: '', name_embedding: await embedOne(targetName), created_at: now,
  };
  await upsertEntityNode(srcNode);
  await upsertEntityNode(tgtNode);
  const factText = fact || `${sourceName} ${relation} ${targetName}`;
  const edge = {
    uuid: uuidv4(), group_id: gid,
    source_node_uuid: srcNode.uuid, target_node_uuid: tgtNode.uuid,
    name: relation, fact: factText, fact_embedding: await embedOne(factText),
    episodes: [], attributes: {},
    valid_at: validAt || now, invalid_at: null, expired_at: null,
    reference_time: validAt || now, created_at: now,
  };
  await upsertEntityEdge(edge);
  return { nodes: [srcNode, tgtNode], edges: [edge] };
}
