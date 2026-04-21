# bungraph

Turnkey temporal context graph on libsql for AI agents. A 1:1 JavaScript port of [Graphiti](https://github.com/getzep/graphiti) built on:

- **libsql** — single-file embedded graph + vector (F32_BLOB + `vector_top_k`) + FTS5 keyword search. Zero external servers.
- **Local embeddings** — `Xenova/all-MiniLM-L6-v2` (384d) via transformers.js. No API keys.
- **Pluggable LLM** — default uses your local `claude` CLI (`claude -p`). Set `BUNGRAPH_LLM_PROVIDER=acp` + `BUNGRAPH_ACP_COMMAND="opencode acp"` (or any Agent Client Protocol agent: kilo, gemini-cli, custom) to route all extraction/dedupe/summary calls through an ACP stdio subprocess via `@agentclientprotocol/sdk`. Long-lived session, mutex-serialized turns, auto-allow permissions, JSON output parsed from streamed `agent_message_chunk` text.

## Quick start

One command, three modes. Default is MCP.

```bash
# MCP stdio server (default — for Claude Code, Cursor, IDE plugins)
bunx bungraph
# or explicit:
bunx bungraph --mcp

# HTTP REST server (graphiti upstream server parity)
bunx bungraph --serve --port 8000

# CLI one-shots
bunx bungraph add "Alice Johnson joined Acme Corp as a software engineer in March 2024." --source text
bunx bungraph search "What is Alice's current role?"
```

Register as a permanent MCP server:

```bash
claude mcp add -s user bungraph -- bunx bungraph
```

## MCP tools (21)

Ingestion: `add_episode`, `add_episode_bulk`, `add_triplet`
Search: `search`, `search_nodes`, `search_facts`, `search_communities`, `search_episodes` — all accept `as_of` for bitemporal queries
Retrieval: `get_episodes`, `get_node`, `get_edge`, `get_episode`
Communities: `build_communities`, `remove_communities`
Sagas: `create_saga`, `summarize_saga`
Mutation: `delete_episode`, `delete_entity_edge`, `delete_entity_node`, `clear_graph`
Observability: `debug_state` — returns in-process subsystem snapshot (tx stats, writer mutex, LLM inflight, embeddings cache, store URL)

All tool inputs validated with strict zod schemas; unknown keys rejected. Every tool returns `structuredContent` alongside human-readable `content`; failures return RFC 9457-style problem descriptors.

## HTTP endpoints

`POST /messages` · `POST /entity-node` · `DELETE /entity-edge/:uuid` · `DELETE /group/:gid` · `DELETE /episode/:uuid` · `POST /clear` · `POST /search` (accepts `as_of`) · `GET /entity-edge/:uuid` · `GET /episodes/:gid` · `POST /get-memory` · `POST /build-communities` · `POST /triplet` · `GET /healthcheck` · `GET /debug/state`

Errors conform to RFC 9457 `application/problem+json`: `{type, title, status, detail, issues?}`. Bodies capped at 4 MB; invalid JSON returns 400; validation failures surface zod issues.

## Bitemporal queries

Every edge carries `valid_at` (when the fact became true in the world) and `expired_at` (when the system learned it was no longer true). Search accepts `as_of: <ISO-8601>` and returns only edges active at that moment:

```js
await graph.search('who does Alice work for', { asOf: '2024-06-01T00:00:00Z' });
```

Transaction safety: every multi-statement upsert runs through `withTx` with BEGIN IMMEDIATE semantics + writer mutex + jittered SQLITE_BUSY retry (up to 8 attempts, exponential backoff capped at 2s).

## Configuration

| env | default | purpose |
|---|---|---|
| `BUNGRAPH_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`silent` |
| `BUNGRAPH_LLM_MAX_ATTEMPTS` | 5 | retry budget for claude-cli failures |
| `BUNGRAPH_LLM_TIMEOUT_MS` | 60000 | per-call timeout |
| `BUNGRAPH_LLM_BACKOFF_CAP_MS` | 20000 | max backoff between retries |
| `BUNGRAPH_CLAUDE_BIN` | auto-detect | override path to `claude` binary |
| `BUNGRAPH_LLM_PROVIDER` | `claude-code` | `claude-code` or `acp` |
| `BUNGRAPH_ACP_COMMAND` | — | ACP agent stdio command, e.g. `opencode acp`, `kilo acp`, `gemini acp` |
| `BUNGRAPH_ACP_ARGS` | — | extra args (JSON array or space-separated) appended to command |
| `BUNGRAPH_DEBUG_ACP` | off | log ACP subprocess stderr |
| `BUNGRAPH_STUB_EMBEDDINGS` | off | stub deterministic vectors for offline tests |
| `BUNDAG_SKIP_LLM` | off | skip LLM-dependent branches of `test.js` |

Logs are JSON lines on stderr with subsystem routing; API keys and `authorization`/`apiKey`/`token`/`secret`/`password`/`bearer` fields redacted automatically.

## Pipeline

Each episode goes through:

1. **Entity extraction** — LLM via ACP extracts named entities (message/text/json source-type-specific prompts)
2. **Semantic dedup** — vector-similar existing nodes surfaced via `vector_top_k`, exact/loose-name match first, then LLM dedupe prompt
3. **Edge extraction** — LLM extracts fact triples between resolved entities with ISO-8601 validity windows
4. **Temporal resolution** — LLM detects duplicates + contradictions against existing edges; contradicted edges get `expired_at` + `invalid_at` set
5. **Attribute + summary extraction** — per-entity attribute extraction (if schema provided) + batch entity summaries
6. **Persistence** — nodes/edges written to libsql with vector + FTS indices
7. **Episodic edges** — `MENTIONS` edges created from episode to each resolved node
8. **Optional** — saga linkage (`HAS_EPISODE` + `NEXT_EPISODE`), community refresh

## Search

Combines `vector_top_k` (F32 cosine) + FTS5 (BM25) via Reciprocal Rank Fusion. Rerankers: `rrf`, `mmr`, `node_distance`, `episode_mentions`, `cross_encoder` (via ACP).

16 recipes available from upstream: `NODE_HYBRID_SEARCH_RRF`, `NODE_HYBRID_SEARCH_MMR`, `NODE_HYBRID_SEARCH_NODE_DISTANCE`, `NODE_HYBRID_SEARCH_EPISODE_MENTIONS`, `NODE_HYBRID_SEARCH_CROSS_ENCODER`, `EDGE_HYBRID_SEARCH_*` (5 variants), `COMMUNITY_HYBRID_SEARCH_*` (3 variants), `COMBINED_HYBRID_SEARCH_*` (3 variants), `EPISODE_HYBRID_SEARCH_RRF`.

## Architecture vs. upstream Graphiti

| Aspect | Graphiti (Python) | bungraph |
|---|---|---|
| Graph DB | Neo4j / Kuzu / FalkorDB / Neptune | libsql (single file) |
| Vector | Provider-specific | libsql F32_BLOB + `vector_top_k` |
| Keyword | Provider-specific (Lucene/FTS) | libsql FTS5 |
| LLM | OpenAI / Anthropic / Gemini / Groq SDKs | local `claude -p` (no keys) |
| Embeddings | OpenAI / Voyage / Gemini / HF | transformers.js local (offline) |
| Cross-encoder | OpenAI / BGE / Gemini | local `claude -p` |
| Runtime | Python 3.10+ | bun / node 18+ |

## License

Apache-2.0
