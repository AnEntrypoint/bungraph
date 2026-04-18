import { MAX_SUMMARY_CHARS } from '../text-utils.js';

export function summarizeSaga(ctx) {
  const sagaName = ctx.saga_name || 'Unknown';
  const existingSummary = ctx.existing_summary || '';
  const episodes = ctx.episodes || [];
  const episodesText = episodes.length ? episodes.join('\n---\n') : '(no messages)';

  let existingSummarySection = '';
  if (existingSummary) {
    existingSummarySection = `
Previous summary of this conversation thread:
${existingSummary}

The following messages may include new content since the previous summary. Update the summary to incorporate any new information.
`;
  }

  const sys = `You are a helpful assistant that summarizes conversation threads. Produce a single dense factual summary of the conversation. Keep the summary under ${MAX_SUMMARY_CHARS} characters. State facts directly. Do not use filler verbs like "mentioned", "discussed", "noted", or "stated". Preserve names, dates, decisions, and outcomes. Begin with the main topic or outcome, not with "This conversation" or "The thread".`;
  const user = `Summarize the following conversation thread "${sagaName}":
${existingSummarySection}
Messages:
${episodesText}

Return JSON: {"summary":"string"}`;
  return { system: sys, user, schema: 'summary' };
}
