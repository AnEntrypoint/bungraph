import { MAX_SUMMARY_CHARS, toPromptJson } from '../text-utils.js';
import { summaryInstructions } from './snippets.js';

export function summarizePair(ctx) {
  const sys = 'You are a helpful assistant that combines summaries into a single dense factual summary.';
  const user = `
        Synthesize the information from the following two summaries into a single information-dense summary.

        IMPORTANT:
        - Preserve all materially relevant names, roles, places, dates, counts, and changes over time that are explicitly supported.
        - Prefer compact factual sentences over vague thematic phrasing.
        - When the durable fact is the content of what was said, state the content directly instead of narrating that it was said.
        - Use communication verbs only when the act of speaking, asking, sharing, presenting, or announcing is itself the important fact.
        - Avoid filler verbs like "mentioned", "described", "stated", "reported", "noted", "discussed", "referenced", and "indicated" unless the communication act itself matters.
        - SUMMARIES MUST BE LESS THAN ${MAX_SUMMARY_CHARS} CHARACTERS.

        Summaries:
        ${toPromptJson(ctx.node_summaries)}

        Return JSON: {"summary":"string"}
        `;
  return { system: sys, user, schema: 'summary' };
}

export function summarizeContext(ctx) {
  const sys = 'You are a helpful assistant that generates detailed, information-dense summaries and attributes from provided text.';
  const user = `
        Given the MESSAGES and the ENTITY name, create a summary for the ENTITY. Your summary must only use
        information from the provided MESSAGES. Your summary should also only contain information relevant to the
        provided ENTITY.

        In addition, extract any values for the provided entity properties based on their descriptions.
        If the value of the entity property cannot be found in the current context, set the value of the property to null.

        ${summaryInstructions}

        <MESSAGES>
        ${toPromptJson(ctx.previous_episodes)}
        ${toPromptJson(ctx.episode_content)}
        </MESSAGES>

        <ENTITY>
        ${ctx.node_name}
        </ENTITY>

        <ENTITY CONTEXT>
        ${ctx.node_summary}
        </ENTITY CONTEXT>

        <ATTRIBUTES>
        ${toPromptJson(ctx.attributes)}
        </ATTRIBUTES>

        Return JSON: {"summary":"string","attributes":{}}
        `;
  return { system: sys, user, schema: 'summary_with_attributes' };
}

export function summaryDescription(ctx) {
  const sys = 'You are a helpful assistant that describes provided contents in a single sentence.';
  const user = `
        Create a short one sentence description of the summary that explains what kind of information is summarized.
        Summaries must be under ${MAX_SUMMARY_CHARS} characters.

        Summary:
        ${toPromptJson(ctx.summary)}

        Return JSON: {"description":"string"}
        `;
  return { system: sys, user, schema: 'description' };
}
