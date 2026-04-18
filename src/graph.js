import { v4 as uuidv4 } from 'uuid';
import {
  initStore, upsertEntityNode, upsertEpisodicNode, upsertEntityEdge, upsertEpisodicEdge,
  expireEdge, getDb, getEntityEdgesByUuids, deleteEpisode as storeDeleteEpisode, clearGroup as storeClearGroup,
} from './store.js';
import { embedOne } from './embeddings.js';
import { extractNodes, resolveExtractedNodes, extractAttributesFromNodes } from './node-operations.js';
import { extractEdges, resolveExtractedEdges, buildEpisodicEdges, extractEdgeAttributes } from './edge-operations.js';
import { retrieveEpisodes, buildIndicesAndConstraints, clearData } from './graph-data-operations.js';
import { buildCommunities, updateCommunity, removeCommunities } from './community-operations.js';
import { upsertSaga, addEpisodeToSaga, summarizeSaga, getSagaEpisodes } from './saga-operations.js';
import {
  retrievePreviousEpisodesBulk, extractNodesAndEdgesBulk, dedupeNodesBulk,
  dedupeEdgesBulk, resolveEdgePointers, addNodesAndEdgesBulk,
} from './bulk-utils.js';
import { search, searchNodes, searchEdges, searchCommunities, searchEpisodes } from './search.js';
import { SearchConfig, NodeSearchConfig, EdgeSearchConfig, CommunitySearchConfig } from './search-config.js';
import { SearchFilters } from './search-filters.js';
import { validateGroupId, getDefaultGroupId } from './namespaces.js';
import { createTracer } from './tracer.js';
import { captureEvent } from './telemetry.js';
import { MAX_SUMMARY_CHARS } from './text-utils.js';

const DEFAULT_GROUP = 'default';

function nowIso() { return new Date().toISOString(); }

export class Graphiti {
  constructor({ dbPath, groupId = DEFAULT_GROUP, entityTypes = null, edgeTypes = null, excludedEntityTypes = null, storeRawEpisodeContent = true, maxCoroutines = 10, tracer = null } = {}) {
    this.dbPath = dbPath;
    this.groupId = groupId;
    this.entityTypes = entityTypes;
    this.edgeTypes = edgeTypes;
    this.excludedEntityTypes = excludedEntityTypes;
    this.storeRawEpisodeContent = storeRawEpisodeContent;
    this.maxCoroutines = maxCoroutines;
    this.tracer = tracer || createTracer();
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await initStore(this.dbPath);
    await buildIndicesAndConstraints();
    this.ready = true;
  }

  async buildIndicesAndConstraints() { return buildIndicesAndConstraints(); }

  async retrieveEpisodes({ groupIds = null, referenceTime = null, limit = 3, source = null } = {}) {
    await this.init();
    return retrieveEpisodes({ groupIds: groupIds || [this.groupId], referenceTime, limit, source });
  }

  async addEpisode({
    name = null, content, source = 'message', sourceDescription = '', validAt = null,
    groupId = null, previousEpisodes = null, sagaUuid = null, entityTypes = null,
    edgeTypes = null, customExtractionInstructions = '', excludedEntityTypes = null,
    updateCommunities = false,
  }) {
    await this.init();
    const gid = validateGroupId(groupId || this.groupId);
    const ets = entityTypes || this.entityTypes;
    const edts = edgeTypes || this.edgeTypes;
    const excl = excludedEntityTypes || this.excludedEntityTypes;

    const episode = {
      uuid: uuidv4(),
      group_id: gid,
      name: name || String(content).slice(0, 60),
      source,
      source_description: sourceDescription,
      content,
      valid_at: validAt || nowIso(),
      created_at: nowIso(),
      entity_edges: [],
    };

    const prev = previousEpisodes || await retrieveEpisodes({ groupIds: [gid], referenceTime: episode.valid_at, limit: 3 });

    const extracted = await extractNodes({
      episode, previousEpisodes: prev, entityTypes: ets,
      excludedEntityTypes: excl, customExtractionInstructions,
    });

    const { resolved, uuidMap, duplicatePairs } = await resolveExtractedNodes({
      extractedNodes: extracted, episode, previousEpisodes: prev, entityTypes: ets,
    });

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

    // Attribute & summary extraction for nodes using episode context
    await extractAttributesFromNodes({
      nodes: resolved, episode, previousEpisodes: prev, entityTypes: ets, edges: savedEdges,
    });

    for (const n of resolved) await upsertEntityNode(n);

    // Persist episode + episodic edges
    const epEdges = buildEpisodicEdges({ episode, nodes: resolved });
    for (const ee of epEdges) await upsertEpisodicEdge(ee);

    if (!this.storeRawEpisodeContent) episode.content = '';
    await upsertEpisodicNode(episode);

    // Saga linkage
    if (sagaUuid) {
      const prevEp = prev.length ? prev[prev.length - 1] : null;
      await addEpisodeToSaga({ sagaUuid, episodeUuid: episode.uuid, groupId: gid, previousEpisodeUuid: prevEp?.uuid });
    }

    // Optional community update for each resolved node
    if (updateCommunities) {
      for (const n of resolved) {
        try { await updateCommunity({ nodeUuid: n.uuid, groupId: gid }); } catch {}
      }
    }

    captureEvent('add_episode', { group_id: gid, nodes: resolved.length, edges: savedEdges.length });

    return {
      episode,
      nodes: resolved.map(({ name_embedding, ...rest }) => rest),
      edges: savedEdges.map(({ fact_embedding, ...rest }) => rest),
      episodic_edges: epEdges,
      communities: [],
      community_edges: [],
    };
  }

  async addEpisodeBulk({ episodes, entityTypes = null, edgeTypes = null, groupId = null, customExtractionInstructions = '' }) {
    await this.init();
    const gid = validateGroupId(groupId || this.groupId);
    const episodeObjs = episodes.map(ep => ({
      uuid: uuidv4(),
      group_id: ep.group_id || gid,
      name: ep.name || String(ep.content).slice(0, 60),
      source: ep.source || 'message',
      source_description: ep.source_description || '',
      content: ep.content,
      valid_at: ep.valid_at || nowIso(),
      created_at: nowIso(),
      entity_edges: [],
    }));
    const results = await extractNodesAndEdgesBulk({
      episodes: episodeObjs,
      entityTypes: entityTypes || this.entityTypes,
      edgeTypes: edgeTypes || this.edgeTypes,
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

  async addTriplet({ sourceName, relation, targetName, fact, groupId = null, validAt = null }) {
    await this.init();
    const gid = validateGroupId(groupId || this.groupId);
    const srcEmb = await embedOne(sourceName);
    const tgtEmb = await embedOne(targetName);
    const srcNode = {
      uuid: uuidv4(), name: sourceName, group_id: gid, labels: ['Entity'],
      attributes: {}, summary: '', name_embedding: srcEmb, created_at: nowIso(),
    };
    const tgtNode = {
      uuid: uuidv4(), name: targetName, group_id: gid, labels: ['Entity'],
      attributes: {}, summary: '', name_embedding: tgtEmb, created_at: nowIso(),
    };
    await upsertEntityNode(srcNode);
    await upsertEntityNode(tgtNode);
    const factText = fact || `${sourceName} ${relation} ${targetName}`;
    const edge = {
      uuid: uuidv4(), group_id: gid,
      source_node_uuid: srcNode.uuid,
      target_node_uuid: tgtNode.uuid,
      name: relation, fact: factText,
      fact_embedding: await embedOne(factText),
      episodes: [], attributes: {},
      valid_at: validAt || nowIso(), invalid_at: null, expired_at: null,
      reference_time: validAt || nowIso(), created_at: nowIso(),
    };
    await upsertEntityEdge(edge);
    return { nodes: [srcNode, tgtNode], edges: [edge] };
  }

  async search(query, { groupIds = null, config = null, centerNodeUuids = null, filters = null, limit = null } = {}) {
    await this.init();
    return search({ query, groupIds: groupIds || [this.groupId], config, centerNodeUuids, filters, limit });
  }

  async searchNodes(query, opts = {}) { await this.init(); return searchNodes({ query, groupIds: opts.groupIds || [this.groupId], ...opts }); }
  async searchEdges(query, opts = {}) { await this.init(); return searchEdges({ query, groupIds: opts.groupIds || [this.groupId], ...opts }); }
  async searchCommunities(query, opts = {}) { await this.init(); return searchCommunities({ query, groupIds: opts.groupIds || [this.groupId], ...opts }); }
  async searchEpisodes(query, opts = {}) { await this.init(); return searchEpisodes({ query, groupIds: opts.groupIds || [this.groupId], ...opts }); }

  async buildCommunities({ groupIds = null } = {}) {
    await this.init();
    return buildCommunities({ groupIds: groupIds || [this.groupId] });
  }

  async removeCommunities({ groupIds = null } = {}) {
    await this.init();
    return removeCommunities({ groupIds: groupIds || [this.groupId] });
  }

  async updateCommunityForNode(nodeUuid, groupId = null) {
    await this.init();
    return updateCommunity({ nodeUuid, groupId: groupId || this.groupId });
  }

  async createSaga({ name, groupId = null, summary = '' }) {
    await this.init();
    return upsertSaga({ groupId: groupId || this.groupId, name, summary });
  }

  async summarizeSaga(sagaUuid) {
    await this.init();
    return summarizeSaga({ sagaUuid });
  }

  async getSagaEpisodes(sagaUuid) {
    await this.init();
    return getSagaEpisodes(sagaUuid);
  }

  async getNodeByUuid(uuid) {
    await this.init();
    const r = await getDb().execute({ sql: `SELECT * FROM entity_node WHERE uuid=?`, args: [uuid] });
    return r.rows[0] || null;
  }

  async getEdgeByUuid(uuid) {
    await this.init();
    const r = await getDb().execute({ sql: `SELECT * FROM entity_edge WHERE uuid=?`, args: [uuid] });
    return r.rows[0] || null;
  }

  async getEpisodeByUuid(uuid) {
    await this.init();
    const r = await getDb().execute({ sql: `SELECT * FROM episodic_node WHERE uuid=?`, args: [uuid] });
    return r.rows[0] || null;
  }

  async getNodesAndEdgesByEpisode(episodeUuid) {
    await this.init();
    const db = getDb();
    const ep = (await db.execute({ sql: `SELECT * FROM episodic_node WHERE uuid=?`, args: [episodeUuid] })).rows[0];
    if (!ep) return { episode: null, nodes: [], edges: [] };
    const nodes = (await db.execute({
      sql: `SELECT n.* FROM entity_node n JOIN episodic_edge ee ON ee.target_node_uuid = n.uuid WHERE ee.source_node_uuid=?`,
      args: [episodeUuid],
    })).rows;
    const edgeUuids = JSON.parse(ep.entity_edges || '[]');
    const edges = edgeUuids.length ? await getEntityEdgesByUuids(edgeUuids) : [];
    return { episode: ep, nodes, edges };
  }

  async deleteEntityEdge(uuid) {
    await this.init();
    await getDb().execute({ sql: `DELETE FROM entity_edge_fts WHERE uuid=?`, args: [uuid] });
    await getDb().execute({ sql: `DELETE FROM entity_edge WHERE uuid=?`, args: [uuid] });
  }

  async deleteEntityNode(uuid) {
    await this.init();
    const db = getDb();
    const edgesToDelete = await db.execute({
      sql: `SELECT uuid FROM entity_edge WHERE source_node_uuid=? OR target_node_uuid=?`,
      args: [uuid, uuid],
    });
    for (const e of edgesToDelete.rows) {
      await db.execute({ sql: `DELETE FROM entity_edge_fts WHERE uuid=?`, args: [e.uuid] });
    }
    await db.execute({ sql: `DELETE FROM entity_edge WHERE source_node_uuid=? OR target_node_uuid=?`, args: [uuid, uuid] });
    await db.execute({ sql: `DELETE FROM episodic_edge WHERE target_node_uuid=?`, args: [uuid] });
    await db.execute({ sql: `DELETE FROM entity_node_fts WHERE uuid=?`, args: [uuid] });
    await db.execute({ sql: `DELETE FROM entity_node WHERE uuid=?`, args: [uuid] });
  }

  async deleteEpisode(uuid) {
    await this.init();
    return storeDeleteEpisode(uuid);
  }

  async clearGraph({ groupIds = null } = {}) {
    await this.init();
    if (groupIds) {
      for (const g of groupIds) await storeClearGroup(g);
    } else {
      await clearData();
    }
  }
}
