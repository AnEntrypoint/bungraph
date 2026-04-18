import { v4 as uuidv4 } from 'uuid';
import {
  initStore, upsertEntityNode, upsertEpisodicNode, upsertEntityEdge, upsertEpisodicEdge,
  expireEdge, vectorSearchNodes, getRecentEpisodes, getEdgesBetween, getEntityNodesByUuids,
} from './store.js';
import { embed, embedOne, EMBED_DIM } from './embeddings.js';
import { getLLM } from './llm.js';
import { promptLibrary } from './prompts/index.js';

const DEFAULT_GROUP = 'default';
const SIM_CANDIDATES = 10;

function nowIso() { return new Date().toISOString(); }

function cos(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export class Graphiti {
  constructor({ dbPath, groupId = DEFAULT_GROUP } = {}) {
    this.dbPath = dbPath;
    this.groupId = groupId;
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await initStore(this.dbPath);
    this.ready = true;
  }

  async addEpisode({ name, content, source = 'message', sourceDescription = '', validAt = null, groupId = null, previousEpisodes = null }) {
    await this.init();
    const gid = groupId || this.groupId;
    const episode = {
      uuid: uuidv4(),
      group_id: gid,
      name: name || content.slice(0, 60),
      source,
      source_description: sourceDescription,
      content,
      valid_at: validAt || nowIso(),
      created_at: nowIso(),
      entity_edges: [],
    };

    const recent = previousEpisodes || (await getRecentEpisodes([gid], 3, episode.valid_at)).map(r => ({
      role_type: r.source, content: r.content, timestamp: r.valid_at,
    }));

    const llm = getLLM();

    const entityTypesDesc = '0: Entity — Any named real-world entity.';
    const extractPromptCtx = {
      episode_content: content,
      previous_episodes: recent,
      source_description: sourceDescription,
      entity_types: entityTypesDesc,
      custom_extraction_instructions: '',
    };
    const extractPrompt = source === 'text' ? promptLibrary.extract_nodes.extract_text(extractPromptCtx)
      : source === 'json' ? promptLibrary.extract_nodes.extract_json(extractPromptCtx)
        : promptLibrary.extract_nodes.extract_message(extractPromptCtx);
    const extRes = await llm.generate(extractPrompt.system, extractPrompt.user);
    const rawEntities = Array.isArray(extRes?.extracted_entities) ? extRes.extracted_entities
      : Array.isArray(extRes?.entities) ? extRes.entities
      : [];

    const candidateNodes = [];
    for (const e of rawEntities) {
      if (!e?.name) continue;
      const emb = await embedOne(e.name);
      const candsRows = await vectorSearchNodes(emb, [gid], SIM_CANDIDATES);
      const existing = candsRows.map((r, idx) => ({
        candidate_id: idx,
        uuid: r.uuid,
        name: r.name,
        summary: r.summary,
      }));
      candidateNodes.push({ extracted: e, embedding: emb, existing, existingRows: candsRows });
    }

    const resolvedNodes = [];
    if (candidateNodes.length > 0) {
      const dedupeCtx = {
        episode_content: content,
        previous_episodes: recent,
        extracted_nodes: candidateNodes.map((c, i) => ({ id: i, name: c.extracted.name })),
        existing_nodes: candidateNodes.flatMap((c, i) =>
          c.existing.map(e => ({ ...e, candidate_id: `${i}:${e.candidate_id}` }))),
      };
      const dedupePrompt = promptLibrary.dedupe_nodes.nodes(dedupeCtx);
      let dedupeRes;
      try {
        dedupeRes = await llm.generate(dedupePrompt.system, dedupePrompt.user);
      } catch { dedupeRes = { entity_resolutions: [] }; }
      const resolutions = new Map();
      for (const r of dedupeRes?.entity_resolutions || []) {
        resolutions.set(r.id, r);
      }

      for (let i = 0; i < candidateNodes.length; i++) {
        const c = candidateNodes[i];
        const r = resolutions.get(i);
        let matchUuid = null, matchName = null;
        if (r?.duplicate_candidate_id && typeof r.duplicate_candidate_id === 'string') {
          const [ci, ei] = r.duplicate_candidate_id.split(':').map(Number);
          if (ci === i && c.existing[ei]) { matchUuid = c.existing[ei].uuid; matchName = c.existing[ei].name; }
        } else if (typeof r?.duplicate_candidate_id === 'number' && r.duplicate_candidate_id >= 0) {
          const e = c.existing[r.duplicate_candidate_id];
          if (e) { matchUuid = e.uuid; matchName = e.name; }
        }

        const finalName = (r?.name || matchName || c.extracted.name).slice(0, 200);
        if (matchUuid) {
          resolvedNodes.push({
            uuid: matchUuid, name: finalName, group_id: gid,
            labels: [], attributes: {}, summary: '',
            name_embedding: c.embedding, created_at: nowIso(),
            isNew: false, extracted: c.extracted,
          });
        } else {
          resolvedNodes.push({
            uuid: uuidv4(), name: finalName, group_id: gid,
            labels: [], attributes: {}, summary: '',
            name_embedding: c.embedding, created_at: nowIso(),
            isNew: true, extracted: c.extracted,
          });
        }
      }
    }

    for (const n of resolvedNodes) {
      await upsertEntityNode(n);
    }

    let extractedEdges = [];
    if (resolvedNodes.length >= 2) {
      const edgePrompt = promptLibrary.extract_edges.edge({
        episode_content: content,
        previous_episodes: recent,
        nodes: resolvedNodes.map(n => ({ name: n.name })),
        reference_time: episode.valid_at,
        custom_extraction_instructions: '',
      });
      let edgeRes;
      try { edgeRes = await llm.generate(edgePrompt.system, edgePrompt.user); }
      catch { edgeRes = { edges: [] }; }
      extractedEdges = Array.isArray(edgeRes?.edges) ? edgeRes.edges : [];
    }

    const nameToUuid = new Map(resolvedNodes.map(n => [n.name.toLowerCase(), n.uuid]));
    const savedEdges = [];
    for (const ex of extractedEdges) {
      if (!ex?.source_entity_name || !ex?.target_entity_name || !ex?.fact) continue;
      const srcUuid = nameToUuid.get(ex.source_entity_name.toLowerCase());
      const tgtUuid = nameToUuid.get(ex.target_entity_name.toLowerCase());
      if (!srcUuid || !tgtUuid || srcUuid === tgtUuid) continue;

      const factEmb = await embedOne(ex.fact);
      const newEdge = {
        uuid: uuidv4(),
        group_id: gid,
        source_node_uuid: srcUuid,
        target_node_uuid: tgtUuid,
        name: ex.relation_type || 'RELATES_TO',
        fact: ex.fact,
        fact_embedding: factEmb,
        episodes: [episode.uuid],
        attributes: {},
        valid_at: ex.valid_at || null,
        invalid_at: ex.invalid_at || null,
        expired_at: null,
        reference_time: episode.valid_at,
        created_at: nowIso(),
      };

      const existingBetween = await getEdgesBetween([srcUuid, tgtUuid], [srcUuid, tgtUuid], [gid]);
      if (existingBetween.length > 0) {
        const items = existingBetween.map((e, i) => ({ idx: i, fact: e.fact, name: e.name }));
        const resolvePrompt = promptLibrary.dedupe_edges.resolve_edge({
          existing_edges: items,
          edge_invalidation_candidates: [],
          new_edge: { fact: ex.fact, name: newEdge.name },
        });
        let resolveRes;
        try { resolveRes = await llm.generate(resolvePrompt.system, resolvePrompt.user); }
        catch { resolveRes = { duplicate_facts: [], contradicted_facts: [] }; }
        const dupes = new Set(resolveRes?.duplicate_facts || []);
        const contras = new Set(resolveRes?.contradicted_facts || []);
        let skip = false;
        for (let i = 0; i < existingBetween.length; i++) {
          if (dupes.has(i)) { skip = true; break; }
        }
        for (let i = 0; i < existingBetween.length; i++) {
          if (contras.has(i)) {
            await expireEdge(existingBetween[i].uuid, nowIso(), newEdge.valid_at || nowIso());
          }
        }
        if (skip) continue;
      }

      await upsertEntityEdge(newEdge);
      await upsertEpisodicEdge({
        uuid: uuidv4(), group_id: gid,
        source_node_uuid: episode.uuid,
        target_node_uuid: srcUuid,
        created_at: nowIso(),
      });
      await upsertEpisodicEdge({
        uuid: uuidv4(), group_id: gid,
        source_node_uuid: episode.uuid,
        target_node_uuid: tgtUuid,
        created_at: nowIso(),
      });
      episode.entity_edges.push(newEdge.uuid);
      savedEdges.push(newEdge);
    }

    await upsertEpisodicNode(episode);

    return {
      episode,
      nodes: resolvedNodes.map(({ name_embedding, isNew, extracted, ...rest }) => rest),
      edges: savedEdges.map(({ fact_embedding, ...rest }) => rest),
    };
  }
}
