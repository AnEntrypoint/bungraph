import * as extractNodes from './extract-nodes.js';
import * as dedupeNodes from './dedupe-nodes.js';
import * as extractEdges from './extract-edges.js';
import * as dedupeEdges from './dedupe-edges.js';
import * as summarizeNodes from './summarize-nodes.js';
import * as summarizeSagas from './summarize-sagas.js';
import * as evalPrompts from './eval.js';

export const promptLibrary = {
  extract_nodes: {
    extract_message: extractNodes.extractMessage,
    extract_json: extractNodes.extractJson,
    extract_text: extractNodes.extractText,
    classify_nodes: extractNodes.classifyNodes,
    extract_attributes: extractNodes.extractAttributes,
    extract_summary: extractNodes.extractSummary,
    extract_summaries_batch: extractNodes.extractSummariesBatch,
    extract_entity_summaries_from_episodes: extractNodes.extractEntitySummariesFromEpisodes,
  },
  dedupe_nodes: {
    node: dedupeNodes.node,
    nodes: dedupeNodes.nodes,
    node_list: dedupeNodes.nodeList,
  },
  extract_edges: {
    edge: extractEdges.edge,
    extract_attributes: extractEdges.extractAttributes,
  },
  dedupe_edges: {
    resolve_edge: dedupeEdges.resolveEdge,
  },
  summarize_nodes: {
    summarize_pair: summarizeNodes.summarizePair,
    summarize_context: summarizeNodes.summarizeContext,
    summary_description: summarizeNodes.summaryDescription,
  },
  summarize_sagas: {
    summarize_saga: summarizeSagas.summarizeSaga,
  },
  eval: {
    qa_prompt: evalPrompts.qaPrompt,
    eval_prompt: evalPrompts.evalPrompt,
    query_expansion: evalPrompts.queryExpansion,
    eval_add_episode_results: evalPrompts.evalAddEpisodeResults,
  },
};

export * from './extract-nodes.js';
export * from './dedupe-nodes.js';
export * from './extract-edges.js';
export * from './dedupe-edges.js';
export * from './summarize-nodes.js';
export * from './summarize-sagas.js';
export * from './eval.js';
