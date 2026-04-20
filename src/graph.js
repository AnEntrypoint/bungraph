import {
  initStore, getDb, getEntityEdgesByUuids,
  deleteEpisode as storeDeleteEpisode, clearGroup as storeClearGroup,
} from './store.js';
import { retrieveEpisodes, buildIndicesAndConstraints, clearData } from './graph-data-operations.js';
import { buildCommunities, updateCommunity, removeCommunities } from './community-operations.js';
import { upsertSaga, summarizeSaga, getSagaEpisodes } from './saga-operations.js';
import { search, searchNodes, searchEdges, searchCommunities, searchEpisodes } from './search.js';
import { createTracer } from './tracer.js';
import { addEpisodeImpl, addEpisodeBulkImpl, addTripletImpl } from './graph-ingest.js';

const DEFAULT_GROUP = 'default';

export class Graphiti {
  constructor({
    dbPath, groupId = DEFAULT_GROUP, entityTypes = null, edgeTypes = null,
    excludedEntityTypes = null, storeRawEpisodeContent = true,
    maxCoroutines = 10, tracer = null,
  } = {}) {
    Object.assign(this, {
      dbPath, groupId, entityTypes, edgeTypes, excludedEntityTypes,
      storeRawEpisodeContent, maxCoroutines,
      tracer: tracer || createTracer(), ready: false,
    });
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

  async addEpisode(opts) { await this.init(); return addEpisodeImpl(this, opts); }
  async addEpisodeBulk(opts) { await this.init(); return addEpisodeBulkImpl(this, opts); }
  async addTriplet(opts) { await this.init(); return addTripletImpl(this, opts); }

  async search(query, { groupIds = null, config = null, centerNodeUuids = null, filters = null, limit = null, asOf = null } = {}) {
    await this.init();
    return search({ query, groupIds: groupIds || [this.groupId], config, centerNodeUuids, filters, limit, asOf });
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
  async summarizeSaga(sagaUuid) { await this.init(); return summarizeSaga({ sagaUuid }); }
  async getSagaEpisodes(sagaUuid) { await this.init(); return getSagaEpisodes(sagaUuid); }

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
    const db = getDb();
    await db.execute({ sql: `DELETE FROM entity_edge_fts WHERE uuid=?`, args: [uuid] });
    await db.execute({ sql: `DELETE FROM entity_edge WHERE uuid=?`, args: [uuid] });
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

  async deleteEpisode(uuid) { await this.init(); return storeDeleteEpisode(uuid); }

  async clearGraph({ groupIds = null } = {}) {
    await this.init();
    if (groupIds) { for (const g of groupIds) await storeClearGroup(g); }
    else { await clearData(); }
  }
}
