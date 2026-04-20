import { z } from 'zod';

export const GroupId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_\-.]+$/, 'group_id may contain letters, numbers, underscores, hyphens, dots');
export const Uuid = z.string().min(1).max(128);
export const IsoDate = z.string().min(1).max(64).regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, 'must be ISO-8601');
export const Limit = z.number().int().min(1).max(1000);
export const Query = z.string().min(1).max(2048);

export const EpisodeSource = z.enum(['message', 'text', 'json']);

export const AddEpisodeInput = z.object({
  content: z.string().min(1).max(200_000),
  name: z.string().max(512).optional(),
  source: EpisodeSource.optional(),
  source_description: z.string().max(2048).optional(),
  valid_at: IsoDate.optional(),
  saga_uuid: Uuid.optional(),
  update_communities: z.boolean().optional(),
  group_id: GroupId.optional(),
}).strict();

export const AddEpisodeBulkInput = z.object({
  episodes: z.array(z.object({
    content: z.string().min(1).max(200_000),
    name: z.string().max(512).optional(),
    source: EpisodeSource.optional(),
    valid_at: IsoDate.optional(),
    source_description: z.string().max(2048).optional(),
    group_id: GroupId.optional(),
  }).strict()).min(1).max(500),
  group_id: GroupId.optional(),
}).strict();

export const AddTripletInput = z.object({
  sourceName: z.string().min(1).max(512),
  relation: z.string().min(1).max(128),
  targetName: z.string().min(1).max(512),
  fact: z.string().max(4096).optional(),
  valid_at: IsoDate.optional(),
  group_id: GroupId.optional(),
}).strict();

const Reranker = z.enum(['rrf', 'mmr', 'node_distance', 'episode_mentions', 'cross_encoder']);

export const SearchInput = z.object({
  query: Query,
  limit: Limit.optional(),
  center_node_uuids: z.array(Uuid).max(64).optional(),
  reranker: Reranker.optional(),
  as_of: IsoDate.optional(),
  group_id: GroupId.optional(),
}).strict();

export const SimpleQuery = z.object({
  query: Query,
  limit: Limit.optional(),
  as_of: IsoDate.optional(),
  group_id: GroupId.optional(),
}).strict();

export const GetEpisodesInput = z.object({
  limit: Limit.optional(),
  reference_time: IsoDate.optional(),
  as_of: IsoDate.optional(),
  group_id: GroupId.optional(),
}).strict();

export const UuidOnlyInput = z.object({ uuid: Uuid }).strict();
export const GroupOnlyInput = z.object({ group_id: GroupId.optional() }).strict();

export const CreateSagaInput = z.object({
  name: z.string().min(1).max(256),
  summary: z.string().max(4096).optional(),
  group_id: GroupId.optional(),
}).strict();

export const MessagesInput = z.object({
  group_id: GroupId.optional(),
  messages: z.array(z.object({
    name: z.string().max(256).optional(),
    role: z.string().max(64).optional(),
    role_type: z.string().max(64).optional(),
    content: z.string().min(1).max(200_000),
    source_description: z.string().max(2048).optional(),
    timestamp: IsoDate.optional(),
  }).strict()).min(1).max(500),
}).strict();

export const HttpSearchInput = z.object({
  query: Query,
  group_ids: z.array(GroupId).max(64).optional(),
  max_facts: Limit.optional(),
  limit: Limit.optional(),
  as_of: IsoDate.optional(),
}).strict();

export const HttpEntityNodeInput = z.object({
  uuid: Uuid.optional(),
  group_id: GroupId.optional(),
  name: z.string().min(1).max(512),
  summary: z.string().max(4096).optional(),
}).strict();

export const HttpGetMemoryInput = z.object({
  group_id: GroupId.optional(),
  max_facts: Limit.optional(),
  messages: z.array(z.object({
    role: z.string().max(64).optional(),
    role_type: z.string().max(64).optional(),
    content: z.string().min(1).max(200_000),
  }).strict()).min(1).max(500),
}).strict();

export function formatZodIssues(err) {
  if (!err?.issues) return [{ path: [], message: String(err?.message || err) }];
  return err.issues.map(i => ({ path: i.path, message: i.message, code: i.code }));
}

export function validate(schema, input) {
  const res = schema.safeParse(input);
  if (res.success) return { ok: true, value: res.data };
  return { ok: false, issues: formatZodIssues(res.error) };
}
