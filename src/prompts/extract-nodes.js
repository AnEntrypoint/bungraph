import { MAX_SUMMARY_CHARS, toPromptJson } from '../text-utils.js';
import { summaryInstructions } from './snippets.js';

export function extractMessage(ctx) {
  const sys = 'You are an entity extraction specialist for conversational messages. NEVER extract abstract concepts, feelings, or generic words.';
  const user = `
NEVER extract any of the following:
- Pronouns (you, me, I, he, she, they, we, us, it, them, him, her, this, that, those)
- Abstract concepts or feelings (joy, balance, growth, resilience, happiness, passion, motivation)
- Generic common nouns or bare object words (day, life, people, work, stuff, things, food, time,
  way, tickets, supplies, clothes, keys, gear)
- Generic media/content nouns unless uniquely identified in the node name itself (photo, pic, picture,
  image, video, post, story)
- Generic event/activity nouns unless uniquely identified in the node name itself (event, game, meeting,
  class, workshop, competition)
- Broad institutional nouns unless explicitly named or uniquely qualified (government, school, company,
  team, office)
- Ambiguous bare nouns whose meaning depends on sentence context rather than the node name itself
- Sentence fragments or clauses ("what you really care about", "results of that effort")
- Adjectives or descriptive phrases ("amazing", "something different", "new hair color")
- Duplicate references to the same real-world entity. Extract each entity at most once per message,
  even if it appears multiple times or both as a speaker label and in the body text.
- Bare relational or kinship terms (dad, mom, mother, father, sister, brother, husband, wife,
  spouse, son, daughter, uncle, aunt, cousin, grandma, grandpa, friend, boss, teacher, neighbor,
  roommate) and bare animal/pet words (dog, cat, pet, puppy, kitten). These are too generic on
  their own. Instead, qualify them with the possessor: extract "Nisha's dad" not "dad",
  "Jordan's dog" not "dog".
- Bare generic objects that cannot be meaningfully qualified with a possessor, brand, or
  distinguishing detail (e.g., NEVER extract "supplies" from "I picked up some supplies")

Your task is to extract **entity nodes** that are **explicitly** mentioned in the CURRENT MESSAGE.
Pronoun references such as he/she/they or this/that/those should be disambiguated to the names of the
reference entities. Only extract distinct entities from the CURRENT MESSAGE.

<ENTITY TYPES>
${ctx.entity_types}
</ENTITY TYPES>

<PREVIOUS MESSAGES>
${toPromptJson(ctx.previous_episodes)}
</PREVIOUS MESSAGES>

<CURRENT MESSAGE>
${ctx.episode_content}
</CURRENT MESSAGE>

1. **Speaker Extraction**: Always extract the speaker (the part before the colon \`:\` in each dialogue line) as the first entity node.
   - If the speaker is mentioned again in the message, treat both mentions as a **single entity**.

2. **Entity Identification**:
   - Extract named entities and specific, concrete things that are **explicitly** mentioned in the CURRENT MESSAGE.
   - Only extract entities that are specific enough to be uniquely identifiable. Ask: "Could this have its own Wikipedia article or database entry?"
   - When a speaker or named person refers to a relative, pet, or associate using a bare term
     (e.g., "my dad", "his cat"), extract the entity qualified with the possessor's name
     (e.g., "Nisha's dad", "Jordan's cat"). Do NOT extract the bare term alone.
   - **Exclude** entities mentioned only in the PREVIOUS MESSAGES (they are for context only).

3. **Entity Classification**:
   - Use the descriptions in ENTITY TYPES to classify each extracted entity.
   - Assign the appropriate \`entity_type_id\` for each one.

4. **Exclusions**:
   - Do NOT extract entities representing relationships or actions.
   - Do NOT extract dates, times, or other temporal information — these will be handled separately.
   - When in doubt, do NOT extract.

5. **Specificity**:
   - Always use the **most specific form** mentioned in the message. If the message says "road cycling",
     extract "road cycling" not "cycling". If it says "wool coat", extract "wool coat" not "coat".
   - When context makes an object's type clear, include that context in the name. For example, if the
     message mentions forgetting a leash while discussing a dog walk, extract "dog leash" not "leash".
   - If a phrase would not be distinguishable when read alone later, do NOT extract it.

6. **Formatting**:
   - Be **explicit and unambiguous** in naming entities (e.g., use full names when available).

<EXAMPLE>
Message: "Jordan: We just moved to Denver last month. My spouse started a new role at Lockheed Martin and I enrolled in a ceramics workshop at the Belmont Arts Center."
Good extractions: "Jordan" (speaker), "Denver" (Location), "Lockheed Martin" (Organization), "Belmont Arts Center" (Location), "ceramics" (Topic)
Do NOT extract: "spouse" (generic reference — extract only if named), "new role" (not an entity), "last month" (temporal), "we" (pronoun)
</EXAMPLE>

<EXAMPLE>
Message: "Nisha: My dad is visiting next week. He loves walking his dogs in Riverside Park."
Good extractions: "Nisha" (speaker), "Nisha's dad" (Person), "Riverside Park" (Location)
Do NOT extract: "dad" (bare relational term — qualify as "Nisha's dad"), "dogs" (bare animal word — no specific identity), "next week" (temporal)
</EXAMPLE>

<EXAMPLE>
Message: "Mary: I forgot Trigger's leash so I couldn't take him on a dog walk. After that I went road cycling in my new wool coat."
Good extractions: "Mary" (speaker), "Trigger" (animal name), "dog leash" (Object), "road cycling" (Topic), "wool coat" (Object)
Do NOT extract: "leash" (too generic — use "dog leash"), "cycling" (too generic — use "road cycling"), "coat" (too generic — use "wool coat"), "dog walk" (activity, not an entity)
</EXAMPLE>

<EXAMPLE>
Message: "Alex: I shared a pic from the game after the event."
Good extractions: "Alex" (speaker)
Do NOT extract: "pic" (generic media noun), "game" (generic event noun), "event" (generic event noun)
</EXAMPLE>

<EXAMPLE>
Message: "Jordan: We won by a tight score. Scoring that last basket felt incredible."
Good extractions: "Jordan" (speaker)
Do NOT extract: "basket" (ambiguous bare noun that depends on sentence context)
</EXAMPLE>

${ctx.custom_extraction_instructions || ''}

Respond with ONLY this JSON shape (no other fields, no wrapper): {"extracted_entities":[{"name":"string","entity_type_id":0}]}
`;
  return { system: sys, user, schema: 'extracted_entities', jsonSchema: 'return JSON: {"extracted_entities":[{"name":"string","entity_type_id":0}]}' };
}

export function extractJson(ctx) {
  const sys = 'You are an entity extraction specialist for JSON data. NEVER extract abstract concepts, dates, or generic field values.';
  const user = `
NEVER extract:
- Date, time, or timestamp values
- Abstract concepts or generic field values (e.g., "true", "active", "pending")
- Numeric IDs or codes that are not meaningful entity names
- Bare relational or kinship terms (e.g., "spouse", "parent", "pet") — only extract if qualified
  with a possessor name
- Bare generic objects or common nouns (e.g., "supplies", "tickets", "gear") — only extract if
  qualified with a distinguishing detail
- Generic media/content nouns unless uniquely identified in the value itself (photo, pic, picture,
  image, video, post, story)
- Generic event/activity nouns unless uniquely identified in the value itself (event, game, meeting,
  class, workshop, competition)
- Broad institutional nouns unless explicitly named or uniquely qualified (government, school, company,
  team, office)
- Ambiguous bare nouns whose meaning depends on surrounding text rather than the extracted value itself

Extract entities from the JSON and classify each using the ENTITY TYPES above.

<ENTITY TYPES>
${ctx.entity_types}
</ENTITY TYPES>

<SOURCE DESCRIPTION>
${ctx.source_description}
</SOURCE DESCRIPTION>

<JSON>
${ctx.episode_content}
</JSON>

Guidelines:
1. Extract the primary entity the JSON represents (e.g., a "name" or "user" field).
2. Extract named entities referenced in other properties throughout the JSON structure.
3. Only extract entities specific enough to be uniquely identifiable.
4. Be explicit in naming entities — use full names when available.
5. Use the most specific form present in the data (e.g., "road cycling" not "cycling").
6. If a value would not be meaningful and distinguishable when read alone later, do NOT extract it.

${ctx.custom_extraction_instructions || ''}

<EXAMPLE>
JSON: {"user": "Jordan Lee", "company": "Acme Corp", "role": "engineer", "start_date": "2024-01-15", "location": "Denver", "active": true}
Good extractions: "Jordan Lee" (Person), "Acme Corp" (Organization), "Denver" (Location)
Do NOT extract: "engineer" (role, not an entity), "2024-01-15" (date), "true" (field value)
</EXAMPLE>

<EXAMPLE>
JSON: {"author": "Alex", "attachment_type": "photo", "event_name": "event", "agency": "government"}
Good extractions: "Alex" (Person)
Do NOT extract: "photo" (generic media noun), "event" (generic event noun), "government" (broad institutional noun)
</EXAMPLE>

Respond with ONLY this JSON shape (no other fields, no wrapper): {"extracted_entities":[{"name":"string","entity_type_id":0}]}
`;
  return { system: sys, user, schema: 'extracted_entities', jsonSchema: 'return JSON: {"extracted_entities":[{"name":"string","entity_type_id":0}]}' };
}

export function extractText(ctx) {
  const sys = 'You are an entity extraction specialist for unstructured text. NEVER extract abstract concepts, feelings, or generic words.';
  const user = `
NEVER extract:
- Pronouns (you, me, he, she, they, it, them, him, her, we, us, this, that, those)
- Abstract concepts (joy, balance, growth, resilience, passion, motivation)
- Generic common nouns or bare object words (day, life, people, work, stuff, things, food, time,
  tickets, supplies, clothes, keys, gear)
- Generic media/content nouns unless uniquely identified in the node name itself (photo, pic, picture,
  image, video, post, story)
- Generic event/activity nouns unless uniquely identified in the node name itself (event, game, meeting,
  class, workshop, competition)
- Broad institutional nouns unless explicitly named or uniquely qualified (government, school, company,
  team, office)
- Ambiguous bare nouns whose meaning depends on sentence context rather than the node name itself
- Sentence fragments or clauses as entity names
- Bare relational or kinship terms (dad, mom, sister, brother, spouse, friend, boss, pet, dog,
  cat) unless qualified with a possessor (e.g., "Nisha's dad" is acceptable, "dad" alone is not)
- Bare generic objects that cannot be meaningfully qualified with a possessor, brand, or
  distinguishing detail (e.g., NEVER extract "supplies" from "I picked up some supplies")

Extract entities from the TEXT that are **explicitly mentioned**.
For each entity, classify it using the ENTITY TYPES above.
Only extract entities specific enough to be uniquely identifiable — ask: "Could this have its own Wikipedia article or database entry?"

<ENTITY TYPES>
${ctx.entity_types}
</ENTITY TYPES>

<TEXT>
${ctx.episode_content}
</TEXT>

Guidelines:
1. Extract named entities and specific, concrete things.
2. Do not create nodes for relationships or actions.
3. Do not create nodes for temporal information like dates, times or years.
4. Be explicit in node names, using full names and avoiding abbreviations.
5. Always use the most specific form from the text (e.g., "road cycling" not "cycling",
   "wool coat" not "coat"). Include qualifying context when it's clear from the text.
6. When the text refers to a person's relative, pet, or associate by a bare term, qualify the
   entity with the possessor's name (e.g., "Dr. Osei's colleague" not "colleague").
7. If a phrase would not be meaningful and distinguishable when read alone later, do NOT extract it.
8. When in doubt, do NOT extract.

${ctx.custom_extraction_instructions || ''}

<EXAMPLE>
Text: "Dr. Amara Osei presented her migraine study results at the AAN conference. The study tracked 340 patients using a new CGRP combination protocol."
Good extractions: "Dr. Amara Osei" (Person), "AAN" (Organization), "migraine study" (Topic), "CGRP combination protocol" (Object)
Do NOT extract: "results" (generic noun), "340" (number), "patients" (generic noun), "conference" (generic without a specific name)
</EXAMPLE>

<EXAMPLE>
Text: "Alex shared a pic after the event and said scoring the last basket felt incredible."
Good extractions: "Alex" (Person)
Do NOT extract: "pic" (generic media noun), "event" (generic event noun), "basket" (ambiguous bare noun)
</EXAMPLE>

Respond with ONLY this JSON shape (no other fields, no wrapper): {"extracted_entities":[{"name":"string","entity_type_id":0}]}
`;
  return { system: sys, user, schema: 'extracted_entities', jsonSchema: 'return JSON: {"extracted_entities":[{"name":"string","entity_type_id":0}]}' };
}

export function classifyNodes(ctx) {
  const sys = 'You are an entity classification specialist. NEVER assign types not listed in ENTITY TYPES.';
  const user = `
<PREVIOUS MESSAGES>
${toPromptJson(ctx.previous_episodes)}
</PREVIOUS MESSAGES>

<CURRENT MESSAGE>
${ctx.episode_content}
</CURRENT MESSAGE>

<EXTRACTED ENTITIES>
${ctx.extracted_entities}
</EXTRACTED ENTITIES>

<ENTITY TYPES>
${ctx.entity_types}
</ENTITY TYPES>

Given the above conversation, extracted entities, and provided entity types and their descriptions, classify the extracted entities.

Guidelines:
1. Each entity must have exactly one type.
2. NEVER use types not listed in ENTITY TYPES.
3. If none of the provided entity types accurately classify an extracted entity, the type should be set to None.

Return JSON: {"entity_classifications":[{"name":"string","entity_type":"string|null"}]}
`;
  return { system: sys, user, schema: 'entity_classifications' };
}

export function extractAttributes(ctx) {
  const sys = 'You are an entity attribute extraction specialist. NEVER hallucinate or infer values not explicitly stated.';
  const user = `
Given the MESSAGES and the following ENTITY, update any of its attributes based on the information provided
in MESSAGES. Use the provided attribute descriptions to better understand how each attribute should be determined.

Guidelines:
1. NEVER hallucinate or infer property values — only use values explicitly stated in the MESSAGES.
2. Only use the provided MESSAGES and ENTITY to set attribute values.

<MESSAGES>
${toPromptJson(ctx.previous_episodes)}
${toPromptJson(ctx.episode_content)}
</MESSAGES>

<ENTITY>
${toPromptJson(ctx.node)}
</ENTITY>

Return JSON: {"attributes":{}}
`;
  return { system: sys, user, schema: 'attributes' };
}

export function extractSummary(ctx) {
  const sys = 'You are a helpful assistant that extracts entity summaries from the provided text.';
  const user = `
        Given the MESSAGES and the ENTITY, update the summary that combines relevant information about the entity
        from the messages and relevant information from the existing summary. Summary must be under ${MAX_SUMMARY_CHARS} characters.

        ${summaryInstructions}

        <MESSAGES>
        ${toPromptJson(ctx.previous_episodes)}
        ${toPromptJson(ctx.episode_content)}
        </MESSAGES>

        <ENTITY>
        ${toPromptJson(ctx.node)}
        </ENTITY>

        Return JSON: {"summary":"string"}
        `;
  return { system: sys, user, schema: 'summary' };
}

export function extractSummariesBatch(ctx) {
  const sys = 'You are a helpful assistant that generates concise entity summaries from provided context.';
  const user = `
Given the MESSAGES and a list of ENTITIES, generate an updated summary for each entity that needs one.
Each summary must be under ${MAX_SUMMARY_CHARS} characters.

${summaryInstructions}

<MESSAGES>
${toPromptJson(ctx.previous_episodes)}
${toPromptJson(ctx.episode_content)}
</MESSAGES>

<ENTITIES>
${toPromptJson(ctx.entities)}
</ENTITIES>

For each entity, combine relevant information from the MESSAGES with any existing summary content.
Only return summaries for entities that have meaningful information to summarize.
If an entity has no relevant information in the messages and no existing summary, you may skip it.

Return JSON: {"summaries":[{"name":"string","summary":"string"}]}
`;
  return { system: sys, user, schema: 'summaries' };
}

const entityEpisodeSummarySystem = `You maintain detailed, information-dense entity memories from episode text.

Use ONLY facts explicitly stated in EPISODES and durable facts already present in EXISTING_SUMMARY.
NEVER infer beyond what is directly supported.

Primary goal:
Write a dense factual summary of the entity that preserves as many supported details as possible while staying coherent and durable.

What to capture:
- Stable facts about the entity
- All materially relevant named people, organizations, places, events, documents, objects, and other entities linked to it
- Explicit actions, roles, responsibilities, relationships, and outcomes
- Counts, sequences, and repeated patterns when the evidence supports them
- Temporal details at the highest fidelity available: dates, months, years, ordering, and changes over time
- Current state over superseded state when newer episodes clearly update older information

Rules:
- Be exhaustive within the evidence. Prefer retaining a supported concrete detail over omitting it for brevity.
- NEVER infer preferences, habits, recurrence, frequency, causality, intent, importance, or category from a name, a single mention, or weak evidence.
- Only describe something as recurring, preferred, typical, habitual, or ongoing when multiple episodes explicitly support that claim or one episode states it directly.
- Include all materially relevant named participants that appear in the evidence.
- Include temporal qualifiers whenever they are available.
- Mention counts when they are directly supported and meaningful. Prefer direct factual phrasing over meta phrasing.
- When the durable fact is the content of what was said, state the content directly instead of describing that it was said.
- Use communication verbs only when the act of speaking, asking, sharing, presenting, announcing, or telling is itself the important fact.
- NEVER manufacture pattern language from a single occurrence. A single mention can support a fact, but not a trend, habit, or preference unless the text states that directly.
- If the evidence is insufficient or ambiguous, omit the claim.
- NEVER mention the source material or summarization process.
- NEVER mention episodes, messages, prompts, summaries, memory, graphs, nodes, labels, node types, ontology, schema, or categorization.
- NEVER output phrases like "the summary", "the entity", "categorized as", "tagged as", "suggests", "implies", "appears to", or "recorded interaction".
- NEVER use "the entity" as a pronoun. Use the entity's actual name or a natural pronoun (he, she, it, they).
- NEVER use meta-language verbs like "mentioned", "described", "stated", "noted", "discussed", "referenced", "indicated", or "reported". State the fact directly instead of describing how it was communicated.
- NEVER begin the summary with "A ", "An ", or "This is". If the entity's name starts with "The" (e.g. "The Washington Post"), that is acceptable; otherwise NEVER lead with "The ". Lead with the entity's name or a concrete fact.
- When newer episode text conflicts with older summary content, prefer the newer explicit fact.
- If the new episodes add no durable fact, return the existing summary unchanged.
- The summary should read like a compact brief, not a tagline.
- Write 2-6 dense sentences in third person.
- Return only the summary text.`;

export function extractEntitySummariesFromEpisodes(ctx) {
  return {
    system: entityEpisodeSummarySystem,
    user: `NEVER include meta-language about the summarization process. Use ONLY facts from the provided EPISODES.
Each summary must be under ${MAX_SUMMARY_CHARS} characters. Write 2-6 dense sentences in third person. Preserve all material names, roles, dates, counts, and changes over time that are explicitly supported.

For each entity below, generate an updated summary using ONLY the provided EPISODES and any existing summary already on the entity.

<EPISODES>
${toPromptJson(ctx.previous_episodes)}
${toPromptJson(ctx.episode_content)}
</EPISODES>

<ENTITIES>
${toPromptJson(ctx.entities)}
</ENTITIES>

Only return summaries for entities that have meaningful information to summarize.
If an entity has no relevant information in the episodes and no existing summary, you may skip it.

Return JSON: {"summaries":[{"name":"string","summary":"string"}]}
`,
    schema: 'summaries',
  };
}
