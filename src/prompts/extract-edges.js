import { toPromptJson } from '../text-utils.js';

export function edge(ctx) {
  let edgeTypesSection = '';
  if (ctx.edge_types) {
    edgeTypesSection = `
<FACT_TYPES>
${toPromptJson(ctx.edge_types)}
</FACT_TYPES>
`;
  }
  const sys = 'You are an expert fact extractor that extracts fact triples from text. 1. Extracted fact triples should also be extracted with relevant date information. 2. Treat the CURRENT TIME as the time the CURRENT MESSAGE was sent. All temporal information should be extracted relative to this time.';
  const user = `
<PREVIOUS_MESSAGES>
${toPromptJson(ctx.previous_episodes)}
</PREVIOUS_MESSAGES>

<CURRENT_MESSAGE>
${ctx.episode_content}
</CURRENT_MESSAGE>

<ENTITIES>
${toPromptJson(ctx.nodes)}
</ENTITIES>

<REFERENCE_TIME>
${ctx.reference_time}
</REFERENCE_TIME>
${edgeTypesSection}
# TASK
Extract all factual relationships between the given ENTITIES based on the CURRENT MESSAGE.
Only extract facts that:
- involve two DISTINCT ENTITIES from the ENTITIES list,
- are clearly stated or unambiguously implied in the CURRENT MESSAGE,
    and can be represented as edges in a knowledge graph.
- Facts should include entity names rather than pronouns whenever possible.

You may use information from the PREVIOUS MESSAGES only to disambiguate references or support continuity.


${ctx.custom_extraction_instructions || ''}

# EXTRACTION RULES

1. **Entity Name Validation**: \`source_entity_name\` and \`target_entity_name\` must use only the \`name\` values from the ENTITIES list provided above.
   - **CRITICAL**: Using names not in the list will cause the edge to be rejected
2. Each fact must involve two **distinct** entities — \`source_entity_name\` and \`target_entity_name\` NEVER refer to the same entity.
3. NEVER extract facts that describe only a single entity's state, feeling, or attribute. Instead, identify the second entity that the state or feeling relates to and form a proper triple.
   - BAD: "Alice feels happy" (single-entity state — what is Alice happy about?)
   - GOOD: "Alice feels happy about Bob's promotion" → Alice -> FEELS_HAPPY_ABOUT -> Bob's promotion
   - GOOD: "Alice congratulated Bob" (relationship between two entities), "Alice lives in Paris" (relationship between entity and place)
4. NEVER emit duplicate or semantically redundant facts.
5. The \`fact\` should closely paraphrase the original source sentence(s). Do not verbatim quote the original text.
6. Use \`REFERENCE_TIME\` to resolve vague or relative temporal expressions (e.g., "last week").
7. Do **not** hallucinate or infer temporal bounds from unrelated events.

# RELATION TYPE RULES

- If FACT_TYPES are provided and the relationship matches one of the types (considering the entity type signature), use that fact_type_name as the \`relation_type\`.
- Otherwise, derive a \`relation_type\` from the relationship predicate in SCREAMING_SNAKE_CASE (e.g., WORKS_AT, LIVES_IN, IS_FRIENDS_WITH).

# DATETIME RULES

- Use ISO 8601 with "Z" suffix (UTC) (e.g., 2025-04-30T00:00:00Z).
- If the fact is ongoing (present tense), set \`valid_at\` to REFERENCE_TIME.
- If a change/termination is expressed, set \`invalid_at\` to the relevant timestamp.
- Leave both fields \`null\` if no explicit or resolvable time is stated.
- If only a date is mentioned (no time), assume 00:00:00.
- If only a year is mentioned, use January 1st at 00:00:00.

Return JSON: {"edges":[{"source_entity_name":"","target_entity_name":"","relation_type":"","fact":"","valid_at":null,"invalid_at":null}]}
`;
  return { system: sys, user, schema: 'edges' };
}

export function extractAttributes(ctx) {
  const sys = 'You are a fact attribute extraction specialist. NEVER hallucinate or infer values not explicitly stated.';
  const user = `
Given the following FACT, its REFERENCE TIME, and any EXISTING ATTRIBUTES, extract or update
attributes based on the information explicitly stated in the fact. Use the provided attribute
descriptions to understand how each attribute should be determined.

Guidelines:
1. NEVER hallucinate or infer attribute values — only use values explicitly stated in the FACT.
2. Only use information stated in the FACT to set attribute values.
3. Use REFERENCE TIME to resolve any relative temporal expressions in the fact.
4. Preserve existing attribute values unless the fact explicitly provides new information.

<FACT>
${ctx.fact}
</FACT>

<REFERENCE TIME>
${ctx.reference_time}
</REFERENCE TIME>

<EXISTING ATTRIBUTES>
${toPromptJson(ctx.existing_attributes)}
</EXISTING ATTRIBUTES>

Return JSON: {"attributes":{}}
`;
  return { system: sys, user, schema: 'attributes' };
}
