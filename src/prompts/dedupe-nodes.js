import { toPromptJson } from '../text-utils.js';

export function node(ctx) {
  const sys = 'You are an entity deduplication assistant. NEVER fabricate entity names or mark distinct entities as duplicates.';
  const user = `
<PREVIOUS MESSAGES>
${toPromptJson(ctx.previous_episodes)}
</PREVIOUS MESSAGES>

<CURRENT MESSAGE>
${ctx.episode_content}
</CURRENT MESSAGE>

<NEW ENTITY>
${toPromptJson(ctx.extracted_node)}
</NEW ENTITY>

<ENTITY TYPE DESCRIPTION>
${toPromptJson(ctx.entity_type_description)}
</ENTITY TYPE DESCRIPTION>

<EXISTING ENTITIES>
${toPromptJson(ctx.existing_nodes)}
</EXISTING ENTITIES>

Entities should only be considered duplicates if they refer to the *same real-world object or concept*.
Semantic Equivalence: if a descriptive label in EXISTING ENTITIES clearly refers to a named entity in context, treat them as duplicates.

NEVER mark entities as duplicates if:
- They are related but distinct.
- They have similar names or purposes but refer to separate instances or concepts.

Task:
1. Compare the NEW ENTITY against each EXISTING ENTITY (identified by \`candidate_id\`).
2. If it refers to the same real-world object or concept, return the \`candidate_id\` of that match.
3. Return \`duplicate_candidate_id = -1\` when there is no match or you are unsure.

<EXAMPLE>
NEW ENTITY: "Sam" (Person)
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Sam", "entity_types": ["Person"], "summary": "Sam enjoys hiking and photography"}]
Result: duplicate_candidate_id = 0 (same person referenced in conversation)

NEW ENTITY: "NYC"
EXISTING ENTITIES: [{"candidate_id": 0, "name": "New York City", "entity_types": ["Location"]}, {"candidate_id": 1, "name": "New York Knicks", "entity_types": ["Organization"]}]
Result: duplicate_candidate_id = 0 (same location, abbreviated name)

NEW ENTITY: "Java" (programming language)
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Java", "entity_types": ["Location"], "summary": "An island in Indonesia"}]
Result: duplicate_candidate_id = -1 (same name but distinct real-world things)

NEW ENTITY: "Marco's car"
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Marco's vehicle", "entity_types": ["Entity"], "summary": "Marco drives a red sedan."}]
Result: duplicate_candidate_id = 0 (synonym — "car" and "vehicle" refer to the same thing, same possessor)
</EXAMPLE>

Return JSON: {"id":0,"name":"string","duplicate_candidate_id":-1}
`;
  return { system: sys, user, schema: 'node_duplicate' };
}

export function nodes(ctx) {
  const n = (ctx.extracted_nodes || []).length;
  const sys = 'You are an entity deduplication assistant. NEVER fabricate entity names or mark distinct entities as duplicates.';
  const user = `
<PREVIOUS MESSAGES>
${toPromptJson(ctx.previous_episodes)}
</PREVIOUS MESSAGES>

<CURRENT MESSAGE>
${ctx.episode_content}
</CURRENT MESSAGE>

<ENTITIES>
${toPromptJson(ctx.extracted_nodes)}
</ENTITIES>

<EXISTING ENTITIES>
${toPromptJson(ctx.existing_nodes)}
</EXISTING ENTITIES>

Each of the above ENTITIES was extracted from the CURRENT MESSAGE.
For each entity, determine if it is a duplicate of any EXISTING ENTITY.
Entities should only be considered duplicates if they refer to the *same real-world object or concept*.

NEVER mark entities as duplicates if:
- They are related but distinct.
- They have similar names or purposes but refer to separate instances or concepts.

Task:
ENTITIES contains ${n} entities with IDs 0 through ${n - 1}.
Your response MUST include EXACTLY ${n} resolutions with IDs 0 through ${n - 1}. Do not skip or add IDs.

For every entity, provide:
- \`id\`: integer id from ENTITIES
- \`name\`: the best full name for the entity (preserve the original name unless a duplicate has a more complete name)
- \`duplicate_candidate_id\`: the \`candidate_id\` of the EXISTING ENTITY that is the best duplicate match, or -1 if there is no duplicate

<EXAMPLE>
ENTITY: "Sam" (Person)
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Sam", "entity_types": ["Person"], "summary": "Sam enjoys hiking and photography"}]
Result: duplicate_candidate_id = 0 (same person referenced in conversation)

ENTITY: "NYC"
EXISTING ENTITIES: [{"candidate_id": 0, "name": "New York City", "entity_types": ["Location"]}, {"candidate_id": 1, "name": "New York Knicks", "entity_types": ["Organization"]}]
Result: duplicate_candidate_id = 0 (same location, abbreviated name)

ENTITY: "Java" (programming language)
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Java", "entity_types": ["Location"], "summary": "An island in Indonesia"}]
Result: duplicate_candidate_id = -1 (same name but distinct real-world things)

ENTITY: "Marco's car"
EXISTING ENTITIES: [{"candidate_id": 0, "name": "Marco's vehicle", "entity_types": ["Entity"], "summary": "Marco drives a red sedan."}]
Result: duplicate_candidate_id = 0 (synonym — "car" and "vehicle" refer to the same thing, same possessor)
</EXAMPLE>

Return JSON: {"entity_resolutions":[{"id":0,"name":"string","duplicate_candidate_id":-1}]}
`;
  return { system: sys, user, schema: 'entity_resolutions' };
}

export function nodeList(ctx) {
  const sys = 'You are an entity deduplication assistant that groups duplicate nodes by UUID.';
  const user = `
Given the following context, deduplicate a list of nodes:

<NODES>
${toPromptJson(ctx.nodes)}
</NODES>

Task:
1. Group nodes together such that all duplicate nodes are in the same list of uuids.
2. All duplicate uuids should be grouped together in the same list.
3. Also return a new summary that synthesizes the summaries into a new short summary.

Guidelines:
1. Each uuid from the list of nodes should appear EXACTLY once in your response.
2. If a node has no duplicates, it should appear in the response in a list of only one uuid.

<EXAMPLE>
Input nodes:
[
  {"uuid": "a1", "name": "NYC", "summary": "New York City"},
  {"uuid": "b2", "name": "New York City", "summary": "The city of New York"},
  {"uuid": "c3", "name": "Los Angeles", "summary": "City in California"}
]

Result:
[
  {"uuids": ["a1", "b2"], "summary": "New York City, also known as NYC"},
  {"uuids": ["c3"], "summary": "City in California"}
]
</EXAMPLE>

Return JSON: {"groups":[{"uuids":["..."],"summary":"string"}]}
`;
  return { system: sys, user, schema: 'groups' };
}
