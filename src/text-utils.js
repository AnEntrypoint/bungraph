export const MAX_SUMMARY_CHARS = 1000;

export function truncateAtSentence(text, maxChars) {
  if (!text || text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const re = /[.!?](?:\s|$)/g;
  let lastEnd = -1, m;
  while ((m = re.exec(truncated))) lastEnd = m.index + 1;
  if (lastEnd > 0) return text.slice(0, lastEnd).trimEnd();
  return truncated.trimEnd();
}

export function toPromptJson(data, indent = 0) {
  return JSON.stringify(data, null, indent || undefined);
}
