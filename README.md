# Yagami

[![CI](https://github.com/ahkohd/yagami/actions/workflows/ci.yml/badge.svg)](https://github.com/ahkohd/yagami/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@ahkohd/yagami.svg)](https://www.npmjs.com/package/@ahkohd/yagami) [![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

<!-- Demo source: https://github.com/user-attachments/assets/eced71f9-f60d-4b8b-929d-ecd5a3fd54f7 -->
https://github.com/user-attachments/assets/eced71f9-f60d-4b8b-929d-ecd5a3fd54f7

Local-first web search agent

Yagami gives you:
- **Agentic web search**: `search`, `search-advanced`, `code`, `company`, `similar`
- **Deterministic extraction**: `fetch` (`browse & present`)
- **Async deep agentic web search**: `deep start` / `deep check`

## Install

```bash
npm i -g @ahkohd/yagami
```

## Quick start

```bash
yagami start
yagami doctor
yagami search "latest updates in browser automation"
yagami fetch https://example.com --max-chars 2000

yagami deep start "Research FlashAttention in LLMs with citations" --effort thorough
yagami deep check <researchId>

yagami stop
```

## Pi package

- [`packages/pi-yagami-search`](./packages/pi-yagami-search/)

## Commands

- `yagami start` / `stop` / `status` / `reload` / `doctor` — Daemon lifecycle & health checks (`status --cache --tokens` for detailed stats)
- `yagami search <query>` — Agentic web search (default: collated source records)
- `yagami search-advanced <query>` — Agentic web search with filters (`--include-domains`, `--category`, etc.)
- `yagami code <query>` — Agentic code/docs-focused search
- `yagami company <name>` — Agentic company search
- `yagami similar <url>` — Agentic alternative/similar-site discovery
- `yagami fetch <url>` — Deterministic single-page extraction
- `yagami deep start <instructions>` — Starts async deep agentic web search
- `yagami deep check <researchId>` — Checks deep agentic search status/result
- `yagami config ...` — Read/write `~/.config/yagami/config.json`
- `yagami theme preview` — Preview CLI theme styling

Useful flags:
- `--json` for machine-readable output
- `--profile` for latency breakdown on search commands

## HTTP API

The CLI talks to a local HTTP daemon (default: `http://127.0.0.1:43111`).

Core endpoints:
- `GET /health`
- `GET /metrics`
- `POST /stats`
- `POST /reload`
- `POST /stop`
- `POST /mcp` (MCP over HTTP JSON-RPC)
- `GET /mcp` (returns 405; SSE stream not enabled)
- `DELETE /mcp` (terminate MCP session)
- `POST /search`, `POST /search/stream`
- `POST /search/advanced`, `POST /search/advanced/stream`
- `POST /code-context`, `POST /code-context/stream`
- `POST /company-research`, `POST /company-research/stream`
- `POST /find-similar`, `POST /find-similar/stream`
- `POST /fetch`
- `POST /deep-research/start`, `POST /deep-research/check`

You can configure daemon bind address with config keys (`host`, `port`) or env (`YAGAMI_HOST`, `YAGAMI_PORT`).

## MCP over HTTP

`POST /mcp` exposes the Yagami MCP server (tools are discoverable via `tools/list`).

## Observability

`GET /metrics` exposes Prometheus-format counters and gauges for the daemon, covering activity, cache, concurrency, and token usage.

```bash
curl http://127.0.0.1:43111/metrics
```

Metrics exported:

- `yagami_queries_total` — `runQuery` invocations (excludes `/fetch`)
- `yagami_queries_active` — currently running queries
- `yagami_operations_by_type_total{type="..."}` — per-type operation count: `search | code | company | similar | deep_research | fetch`
- `yagami_operations_errors_by_type_total{type="..."}` — per-type error count
- `yagami_operation_duration_seconds_sum{type="..."}` and `yagami_operation_duration_seconds_count{type="..."}` — histogram-like duration (compute avg via `rate(sum) / rate(count)`)
- `yagami_cache_hits_total`, `yagami_cache_misses_total`, `yagami_cache_hit_rate`
- `yagami_documents_cached`, `yagami_url_cache_entries`
- `yagami_deep_research_tasks` — active deep research tasks
- `yagami_operation_slots_active`, `yagami_operation_slots_pending` — operation concurrency
- `yagami_browse_slots_active`, `yagami_browse_slots_pending` — browse concurrency
- `yagami_tokens_total`, `yagami_tokens_input`, `yagami_tokens_output`
- `yagami_uptime_seconds`

Scrape config:

```yaml
- job_name: yagami
  metrics_path: /metrics
  static_configs:
    - targets: ["127.0.0.1:43111"]
```

## Configuration

### Config file (recommended)

Default path: `~/.config/yagami/config.json` (or `$XDG_CONFIG_HOME/yagami/config.json`).

Recommended local setup:

```json
{
  "host": "127.0.0.1",
  "port": 43111,
  "llmApi": "openai-completions",
  "llmBaseUrl": "http://127.0.0.1:1234/v1",
  "llmApiKey": "",
  "llmModel": "qwen3.5-9b",
  "searchEngine": "duckduckgo",
  "browseLinkTimeoutMs": 7000,
  "cacheTtlMs": 600000,
  "maxMarkdownChars": 120000,
  "operationConcurrency": 4,
  "browseConcurrency": 8,
  "theme": "ansi"
}
```
Common local endpoints:
- vLLM: `http://127.0.0.1:8000/v1`
- SGLang: `http://127.0.0.1:30000/v1`
- Ollama: `http://127.0.0.1:11434/v1`
- LM Studio: `http://127.0.0.1:1234/v1`

If you run an `anthropic-messages` compatible **local** gateway:

```json
{
  "llmApi": "anthropic-messages",
  "llmBaseUrl": "http://127.0.0.1:4000",
  "llmApiKey": "",
  "llmModel": "minimax-m2.5"
}
```

`llmApiKey` is empty by default. If your local endpoint ignores auth, leave it empty.

For a custom search endpoint template:

```json
{
  "searchEngine": "custom",
  "searchEngineUrlTemplate": "https://searx.example/search?q={query}&language=en"
}
```

#### Canonical `config.json` keys

- `host` (string, default: `127.0.0.1`)
- `port` (integer, default: `43111`)
- `llmApi` (`openai-completions` | `anthropic-messages`, default: `openai-completions`)
- `llmBaseUrl` (string; default: `http://127.0.0.1:1234/v1`, or `https://api.anthropic.com` for `anthropic-messages`)
- `llmApiKey` (string, default: empty string)
- `llmModel` (string, optional; if empty YAGAMI auto-detects via provider model-list endpoint)
- `searchEngine` (`duckduckgo` | `bing` | `google` | `brave` | `custom`, default: `duckduckgo`)
- `searchEngineUrlTemplate` (string URL template, optional; supports `{query}` placeholder; if set, overrides presets)
- `browseLinkTimeoutMs` (integer milliseconds, default: `7000`)
- `cacheTtlMs` (integer milliseconds for URL browse cache TTL, default: `600000`)
- `maxMarkdownChars` (integer markdown extraction cap for `present()`, default: `120000`)
- `operationConcurrency` (integer concurrent operation slots, default: `4`)
- `browseConcurrency` (integer concurrent browse slots, default: `8`)
- `theme` (`ansi` | `none`, default: `ansi`)
- `themeTokens` (object of token overrides, e.g. `{ "domain": "cyan", "error": "red bold" }`)
  - built-in token names: `domain`, `title`, `duration`, `error`, `dim`, `cyan`, `bold`

#### File parsing notes

- `ui.<key>`: same keys as above under a `ui` object (merged over top-level)
- `colors` / `themeColors`: compatibility aliases for `themeTokens`

### Config CLI

```bash
yagami config path
yagami config show
yagami config get llmApi
yagami config set llmApi openai-completions
yagami config set port 43111 --json-value
yagami config set browseLinkTimeoutMs 7000 --json-value
yagami config set cacheTtlMs 600000 --json-value
yagami config set maxMarkdownChars 120000 --json-value
yagami config set operationConcurrency 4 --json-value
yagami config set browseConcurrency 8 --json-value
yagami config unset themeTokens.domain
```

### Environment variables

- `YAGAMI_CONFIG_FILE` (default: `$YAGAMI_RUNTIME_DIR/config.json`)
- `YAGAMI_RUNTIME_DIR` (default: `$XDG_CONFIG_HOME/yagami` or `~/.config/yagami`)
- `YAGAMI_HOST` (default: `127.0.0.1`)
- `YAGAMI_PORT` (default: `43111`)

- `YAGAMI_LLM_API` (`openai-completions` | `anthropic-messages`, default: `openai-completions`)
- `YAGAMI_LLM_BASE_URL` (default: `http://127.0.0.1:1234/v1`, or `https://api.anthropic.com` for `anthropic-messages`)
- `YAGAMI_LLM_API_KEY` (default: empty string)
- `YAGAMI_LLM_MODEL` (optional)
- `YAGAMI_SEARCH_ENGINE` (`duckduckgo` | `bing` | `google` | `brave` | `custom`, default: `duckduckgo`)
- `YAGAMI_SEARCH_ENGINE_URL_TEMPLATE` (optional URL template, e.g. `https://searx.example/search?q={query}`)

- `YAGAMI_CDP_URL` (default: `ws://127.0.0.1:9222`)
- `YAGAMI_LIGHTPANDA_HOST` (default: host parsed from `YAGAMI_CDP_URL`)
- `YAGAMI_LIGHTPANDA_PORT` (default: port parsed from `YAGAMI_CDP_URL`)
- `YAGAMI_LIGHTPANDA_AUTO_START` (default: `true`)
- `YAGAMI_LIGHTPANDA_AUTO_STOP` (default: `true`)

- `YAGAMI_BROWSE_LINK_TIMEOUT_MS` (default: `7000`)
- `YAGAMI_QUERY_TIMEOUT_MS` (default: `180000`)
- `YAGAMI_CACHE_TTL_MS` (default: `600000`)
- `YAGAMI_MAX_HTML_CHARS` (default: `250000`)
- `YAGAMI_MAX_MARKDOWN_CHARS` (default: value from `config.json`, else `120000`)
- `YAGAMI_MAX_DOCUMENTS` (default: `200`)
- `YAGAMI_OPERATION_CONCURRENCY` (default: `4`)
- `YAGAMI_BROWSE_CONCURRENCY` (default: `8`)

- `YAGAMI_RESEARCH_MAX_PAGES` (default: `12`)
- `YAGAMI_RESEARCH_MAX_HOPS` (default: `2`)
- `YAGAMI_RESEARCH_SAME_DOMAIN_ONLY` (default: `false`)

- `YAGAMI_TOOL_EXECUTION` (`sequential` | `parallel`, default: `parallel`)
- `YAGAMI_THEME` (`ansi` | `none`, default: `ansi`)
- `YAGAMI_THEME_TOKENS` (JSON token overrides)
- `YAGAMI_NO_COLOR` (disable color when truthy)
- `YAGAMI_MARKDOWN_RENDER` (default: render markdown only on TTY; set `0`, `false`, `off`, or `no` to force plain text output)
