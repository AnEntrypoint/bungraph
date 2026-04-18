import { toPromptJson } from '../text-utils.js';

export function queryExpansion(ctx) {
  const sys = 'You are an expert at rephrasing questions into queries used in a database retrieval system';
  const user = `
    Bob is asking Alice a question, are you able to rephrase the question into a simpler one about Alice in the third person
    that maintains the relevant context?
    <QUESTION>
    ${toPromptJson(ctx.query)}
    </QUESTION>

    Return JSON: {"query":"string"}
    `;
  return { system: sys, user, schema: 'query' };
}

export function qaPrompt(ctx) {
  const sys = 'You are Alice and should respond to all questions from the first person perspective of Alice';
  const user = `
    Your task is to briefly answer the question in the way that you think Alice would answer the question.
    You are given the following entity summaries and facts to help you determine the answer to your question.
    <ENTITY_SUMMARIES>
    ${toPromptJson(ctx.entity_summaries)}
    </ENTITY_SUMMARIES>
    <FACTS>
    ${toPromptJson(ctx.facts)}
    </FACTS>
    <QUESTION>
    ${ctx.query}
    </QUESTION>

    Return JSON: {"ANSWER":"string"}
    `;
  return { system: sys, user, schema: 'ANSWER' };
}

export function evalPrompt(ctx) {
  const sys = 'You are a judge that determines if answers to questions match a gold standard answer';
  const user = `
    Given the QUESTION and the gold standard ANSWER determine if the RESPONSE to the question is correct or incorrect.
    Although the RESPONSE may be more verbose, mark it as correct as long as it references the same topic
    as the gold standard ANSWER. Also include your reasoning for the grade.
    <QUESTION>
    ${ctx.query}
    </QUESTION>
    <ANSWER>
    ${ctx.answer}
    </ANSWER>
    <RESPONSE>
    ${ctx.response}
    </RESPONSE>

    Return JSON: {"is_correct":false,"reasoning":"string"}
    `;
  return { system: sys, user, schema: 'eval' };
}

export function evalAddEpisodeResults(ctx) {
  const sys = 'You are a judge that determines whether a baseline graph building result from a list of messages is better than a candidate graph building result based on the same messages.';
  const user = `
    Given the following PREVIOUS MESSAGES and MESSAGE, determine if the BASELINE graph data extracted from the
    conversation is higher quality than the CANDIDATE graph data extracted from the conversation.

    Return False if the BASELINE extraction is better, and True otherwise. If the CANDIDATE extraction and
    BASELINE extraction are nearly identical in quality, return True. Add your reasoning for your decision to the reasoning field

    <PREVIOUS MESSAGES>
    ${ctx.previous_messages}
    </PREVIOUS MESSAGES>
    <MESSAGE>
    ${ctx.message}
    </MESSAGE>

    <BASELINE>
    ${ctx.baseline}
    </BASELINE>

    <CANDIDATE>
    ${ctx.candidate}
    </CANDIDATE>

    Return JSON: {"candidate_is_worse":false,"reasoning":"string"}
    `;
  return { system: sys, user, schema: 'eval_add_episode' };
}
