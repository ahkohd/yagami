#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";

import { getConfig } from "./config.js";
import { YagamiEngine } from "./engine.js";
import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOL_DEFINITIONS,
  executeMcpTool,
  isKnownMcpTool,
} from "./mcp.js";
import type { RuntimeConfig } from "./types/config.js";
import type { NdjsonEvent } from "./types/daemon.js";

const startupConfig = getConfig();
await fsp.mkdir(startupConfig.runtimeDir, { recursive: true });

const serverVersion = await fsp
  .readFile(new URL("../package.json", import.meta.url), "utf8")
  .then((raw) => {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return String(parsed.version || "0.0.0");
  })
  .catch(() => "0.0.0");

let runtimeConfig: RuntimeConfig = startupConfig;
let engine = new YagamiEngine(runtimeConfig, console);

let shuttingDown = false;
let reloading = false;

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number | null;

type McpSessionRecord = {
  sessionId: string;
  protocolVersion: string;
  initialized: boolean;
  createdAt: number;
};

const mcpSessions = new Map<string, McpSessionRecord>();

function sendJson(res: http.ServerResponse, statusCode: number, payload: JsonObject): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNdjson(res: http.ServerResponse, payload: NdjsonEvent): void {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as JsonObject) : {};
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function getTrimmedString(value: unknown): string {
  return String(value ?? "").trim();
}

function parsePositiveInt(value: unknown, fallback: number, max = 1000): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }

  return String(value || "").trim();
}

function hasOwnKey(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}

function normalizeJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" || typeof value === "number" || value === null) {
    return value;
  }

  return undefined;
}

function sendMcpJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: JsonObject,
  headers: JsonObject = {},
): void {
  const body = JSON.stringify(payload);

  const finalHeaders: Record<string, string | number> = {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  };

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    finalHeaders[key] = String(value);
  }

  res.writeHead(statusCode, finalHeaders);
  res.end(body);
}

function sendMcpSuccess(
  res: http.ServerResponse,
  id: JsonRpcId,
  result: unknown,
  options: {
    sessionId?: string;
    protocolVersion?: string;
    statusCode?: number;
  } = {},
): void {
  const headers: JsonObject = {};
  if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
  if (options.protocolVersion) headers["MCP-Protocol-Version"] = options.protocolVersion;

  sendMcpJson(
    res,
    options.statusCode ?? 200,
    {
      jsonrpc: "2.0",
      id,
      result,
    },
    headers,
  );
}

function sendMcpError(
  res: http.ServerResponse,
  id: JsonRpcId,
  error: { code: number; message: string; data?: unknown },
  options: {
    sessionId?: string;
    protocolVersion?: string;
    statusCode?: number;
  } = {},
): void {
  const headers: JsonObject = {};
  if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
  if (options.protocolVersion) headers["MCP-Protocol-Version"] = options.protocolVersion;

  const payloadError: JsonObject = {
    code: error.code,
    message: error.message,
  };

  if (error.data !== undefined) {
    payloadError.data = error.data;
  }

  sendMcpJson(
    res,
    options.statusCode ?? 200,
    {
      jsonrpc: "2.0",
      id,
      error: payloadError,
    },
    headers,
  );
}

function sendAccepted(res: http.ServerResponse, sessionId?: string, protocolVersion?: string): void {
  const headers: Record<string, string> = {};
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;

  res.writeHead(202, headers);
  res.end();
}

function getMcpInitializeResult(protocolVersion: string): JsonObject {
  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "yagami",
      version: serverVersion,
    },
  };
}

function summarizeConfig(config: RuntimeConfig): JsonObject {
  return {
    llmApi: config.llmApi,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    searchEngine: config.searchEngine,
    searchEngineUrlTemplate: config.searchEngineUrlTemplate,
    browseLinkTimeoutMs: config.browseLinkTimeoutMs,
    queryTimeoutMs: config.queryTimeoutMs,
    cacheTtlMs: config.cacheTtlMs,
    maxHtmlChars: config.maxHtmlChars,
    maxMarkdownChars: config.maxMarkdownChars,
    operationConcurrency: config.operationConcurrency,
    browseConcurrency: config.browseConcurrency,
    researchMaxPages: config.researchMaxPages,
    researchMaxHops: config.researchMaxHops,
    researchSameDomainOnly: config.researchSameDomainOnly,
    toolExecutionMode: config.toolExecutionMode,
    lightpandaCdpUrl: config.lightpandaCdpUrl,
    lightpandaAutoStart: config.lightpandaAutoStart,
    lightpandaAutoStop: config.lightpandaAutoStop,
    theme: config.theme,
  };
}

function collectRestartOnlyChanges(previous: RuntimeConfig, next: RuntimeConfig): string[] {
  const restartFields: string[] = [];

  if (previous.host !== next.host) restartFields.push("host");
  if (previous.port !== next.port) restartFields.push("port");
  if (previous.runtimeDir !== next.runtimeDir) restartFields.push("runtimeDir");
  if (previous.configFile !== next.configFile) restartFields.push("configFile");
  if (previous.pidFile !== next.pidFile) restartFields.push("pidFile");
  if (previous.logFile !== next.logFile) restartFields.push("logFile");

  return restartFields;
}

async function reloadRuntimeConfig(): Promise<JsonObject> {
  if (reloading) {
    throw new Error("reload already in progress");
  }

  reloading = true;

  const previous = runtimeConfig;
  const next = getConfig();
  const restartOnlyChanges = collectRestartOnlyChanges(previous, next);

  await fsp.mkdir(next.runtimeDir, { recursive: true }).catch(() => {});

  const nextEngine = new YagamiEngine(next, console);

  try {
    await nextEngine.init();

    const oldEngine = engine;
    engine = nextEngine;
    runtimeConfig = next;

    void oldEngine
      .enqueueOperation(async () => {
        await oldEngine.close();
      })
      .catch(() => {});

    return {
      reloaded: true,
      applied: summarizeConfig(runtimeConfig),
      previous: summarizeConfig(previous),
      restartOnlyChanges,
      message:
        restartOnlyChanges.length > 0
          ? `Reloaded runtime settings. Restart daemon to apply: ${restartOnlyChanges.join(", ")}`
          : "Reloaded runtime settings.",
    };
  } catch (error) {
    await nextEngine.close().catch(() => {});
    throw error;
  } finally {
    reloading = false;
  }
}

async function streamQuery(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  query: string,
  options: JsonObject = {},
): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const requestAbort = new AbortController();
  let disconnected = false;

  const abortRequest = () => {
    if (disconnected) return;
    disconnected = true;
    requestAbort.abort();
  };

  const onRequestAborted = () => {
    abortRequest();
  };

  const onRequestClose = () => {
    if (!req.complete) abortRequest();
  };

  const onResponseClose = () => {
    if (!res.writableEnded) abortRequest();
  };

  req.on("aborted", onRequestAborted);
  req.on("close", onRequestClose);
  res.on("close", onResponseClose);

  const emit = (payload: NdjsonEvent): void => {
    if (disconnected || res.writableEnded) return;
    sendNdjson(res, payload);
  };

  emit({ type: "start", pid: process.pid, startedAt: Date.now() });

  try {
    const result = await engine.enqueueQuery(query, {
      ...options,
      abortSignal: requestAbort.signal,
      onProgress: (event: Record<string, unknown>) => emit({ type: "progress", event }),
    });

    emit({ type: "result", result: result as Record<string, unknown> });
  } catch (error) {
    if (!requestAbort.signal.aborted) {
      emit({ type: "error", error: toErrorMessage(error) });
    }
  } finally {
    req.off("aborted", onRequestAborted);
    req.off("close", onRequestClose);
    res.off("close", onResponseClose);

    if (!res.writableEnded) res.end();
  }
}

async function handleMcpHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const protocolHeader = getHeaderString(req.headers["mcp-protocol-version"]);
  if (protocolHeader && !MCP_SUPPORTED_PROTOCOL_VERSIONS.has(protocolHeader)) {
    return sendJson(res, 400, {
      ok: false,
      error: `Unsupported MCP-Protocol-Version: ${protocolHeader}`,
    });
  }

  if (req.method === "GET") {
    res.writeHead(405, {
      allow: "POST, DELETE",
    });
    res.end();
    return;
  }

  if (req.method === "DELETE") {
    const sessionId = getHeaderString(req.headers["mcp-session-id"]);
    if (!sessionId) {
      return sendJson(res, 400, {
        ok: false,
        error: "Missing Mcp-Session-Id header",
      });
    }

    if (!mcpSessions.has(sessionId)) {
      res.writeHead(404);
      res.end();
      return;
    }

    mcpSessions.delete(sessionId);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, {
      allow: "POST, GET, DELETE",
    });
    res.end();
    return;
  }

  const body = await readJsonBody(req);
  const jsonrpc = getTrimmedString(body.jsonrpc);
  const method = getTrimmedString(body.method);
  const hasId = hasOwnKey(body, "id");
  const id = normalizeJsonRpcId(body.id);

  if (jsonrpc !== "2.0" || !method) {
    if (hasId && id !== undefined) {
      return sendMcpError(
        res,
        id,
        {
          code: -32600,
          message: "Invalid Request",
        },
        { statusCode: 400 },
      );
    }

    return sendJson(res, 400, {
      ok: false,
      error: "Invalid JSON-RPC payload",
    });
  }

  if (method === "initialize") {
    if (!hasId || id === undefined) {
      return sendMcpError(
        res,
        null,
        {
          code: -32600,
          message: "initialize must include a valid id",
        },
        { statusCode: 400 },
      );
    }

    const params = typeof body.params === "object" && body.params !== null ? (body.params as JsonObject) : {};
    const requestedProtocol = getTrimmedString(params.protocolVersion);
    const protocolVersion = MCP_SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocol)
      ? requestedProtocol
      : MCP_DEFAULT_PROTOCOL_VERSION;

    const sessionId = randomUUID();
    mcpSessions.set(sessionId, {
      sessionId,
      protocolVersion,
      initialized: false,
      createdAt: Date.now(),
    });

    return sendMcpSuccess(res, id, getMcpInitializeResult(protocolVersion), {
      sessionId,
      protocolVersion,
    });
  }

  const sessionId = getHeaderString(req.headers["mcp-session-id"]);
  if (!sessionId) {
    if (hasId && id !== undefined) {
      return sendMcpError(
        res,
        id,
        {
          code: -32000,
          message: "Missing Mcp-Session-Id header",
        },
        { statusCode: 400 },
      );
    }

    return sendJson(res, 400, {
      ok: false,
      error: "Missing Mcp-Session-Id header",
    });
  }

  const session = mcpSessions.get(sessionId);
  if (!session) {
    if (hasId && id !== undefined) {
      return sendMcpError(
        res,
        id,
        {
          code: -32001,
          message: "Unknown MCP session",
        },
        { statusCode: 404 },
      );
    }

    res.writeHead(404);
    res.end();
    return;
  }

  const protocolVersion = protocolHeader || session.protocolVersion || MCP_DEFAULT_PROTOCOL_VERSION;

  if (!hasId) {
    if (method === "notifications/initialized") {
      session.initialized = true;
    }

    return sendAccepted(res, session.sessionId, protocolVersion);
  }

  if (id === undefined) {
    return sendMcpError(
      res,
      null,
      {
        code: -32600,
        message: "Invalid Request id",
      },
      {
        sessionId: session.sessionId,
        protocolVersion,
        statusCode: 400,
      },
    );
  }

  if (method === "ping") {
    return sendMcpSuccess(
      res,
      id,
      {},
      {
        sessionId: session.sessionId,
        protocolVersion,
      },
    );
  }

  if (method === "tools/list") {
    return sendMcpSuccess(
      res,
      id,
      {
        tools: MCP_TOOL_DEFINITIONS,
      },
      {
        sessionId: session.sessionId,
        protocolVersion,
      },
    );
  }

  if (method === "tools/call") {
    const params = typeof body.params === "object" && body.params !== null ? (body.params as JsonObject) : {};
    const toolName = getTrimmedString(params.name);
    const toolArgs = typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {};

    if (!toolName) {
      return sendMcpError(
        res,
        id,
        {
          code: -32602,
          message: "Missing required field: name",
        },
        {
          sessionId: session.sessionId,
          protocolVersion,
          statusCode: 400,
        },
      );
    }

    if (!isKnownMcpTool(toolName)) {
      return sendMcpError(
        res,
        id,
        {
          code: -32602,
          message: `Unknown tool: ${toolName}`,
        },
        {
          sessionId: session.sessionId,
          protocolVersion,
          statusCode: 400,
        },
      );
    }

    try {
      const result = await executeMcpTool(engine, toolName, toolArgs);
      return sendMcpSuccess(res, id, result, {
        sessionId: session.sessionId,
        protocolVersion,
      });
    } catch (error) {
      return sendMcpSuccess(
        res,
        id,
        {
          content: [
            {
              type: "text",
              text: `${toolName} error: ${toErrorMessage(error)}`,
            },
          ],
          isError: true,
        },
        {
          sessionId: session.sessionId,
          protocolVersion,
        },
      );
    }
  }

  return sendMcpError(
    res,
    id,
    {
      code: -32601,
      message: `Method not found: ${method}`,
    },
    {
      sessionId: session.sessionId,
      protocolVersion,
      statusCode: 200,
    },
  );
}

const server = http.createServer(async (req, res) => {
  try {
    if (
      reloading &&
      !(req.method === "GET" && req.url === "/health") &&
      !(req.method === "GET" && req.url === "/metrics") &&
      !(req.method === "POST" && req.url === "/stats") &&
      !(req.method === "POST" && req.url === "/reload") &&
      !(req.method === "POST" && req.url === "/stop")
    ) {
      return sendJson(res, 503, {
        ok: false,
        error: "daemon reload in progress; retry shortly",
      });
    }

    if (req.url === "/mcp") {
      await handleMcpHttp(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        reloading,
        ...(engine.getHealth() as JsonObject),
      });
    }

    if (req.method === "GET" && req.url === "/metrics") {
      const h = engine.getHealth() as Record<string, unknown>;
      const tokens = (h.tokens || {}) as Record<string, unknown>;
      const queriesByType = (h.queriesByType || {}) as Record<string, number>;
      const errorsByType = (h.errorsByType || {}) as Record<string, number>;
      const durationSumByType = (h.durationSumByType || {}) as Record<string, number>;
      const durationCountByType = (h.durationCountByType || {}) as Record<string, number>;

      const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

      const allTypes = new Set<string>([
        ...Object.keys(queriesByType),
        ...Object.keys(errorsByType),
        ...Object.keys(durationCountByType),
      ]);
      const sortedTypes = [...allTypes].sort();

      const lines: string[] = [
        "# HELP yagami_queries_total Total number of queries processed (runQuery only; excludes fetch)",
        "# TYPE yagami_queries_total counter",
        `yagami_queries_total ${h.queries || 0}`,
        "# HELP yagami_queries_active Currently active queries",
        "# TYPE yagami_queries_active gauge",
        `yagami_queries_active ${h.activeQueries || 0}`,

        "# HELP yagami_operations_by_type_total Operations grouped by type (search|code|company|similar|deep_research|fetch)",
        "# TYPE yagami_operations_by_type_total counter",
      ];
      for (const t of sortedTypes) {
        const v = queriesByType[t] || 0;
        lines.push(`yagami_operations_by_type_total{type="${escapeLabel(t)}"} ${v}`);
      }

      lines.push(
        "# HELP yagami_operations_errors_by_type_total Operation errors grouped by type",
        "# TYPE yagami_operations_errors_by_type_total counter",
      );
      for (const t of sortedTypes) {
        const v = errorsByType[t] || 0;
        lines.push(`yagami_operations_errors_by_type_total{type="${escapeLabel(t)}"} ${v}`);
      }

      lines.push(
        "# HELP yagami_operation_duration_seconds_sum Sum of operation durations grouped by type",
        "# TYPE yagami_operation_duration_seconds_sum counter",
      );
      for (const t of sortedTypes) {
        const v = (durationSumByType[t] || 0) / 1000;
        lines.push(`yagami_operation_duration_seconds_sum{type="${escapeLabel(t)}"} ${v}`);
      }

      lines.push(
        "# HELP yagami_operation_duration_seconds_count Count of completed operations grouped by type",
        "# TYPE yagami_operation_duration_seconds_count counter",
      );
      for (const t of sortedTypes) {
        const v = durationCountByType[t] || 0;
        lines.push(`yagami_operation_duration_seconds_count{type="${escapeLabel(t)}"} ${v}`);
      }

      lines.push(
        "# HELP yagami_cache_hits_total Total cache hits",
        "# TYPE yagami_cache_hits_total counter",
        `yagami_cache_hits_total ${h.cacheHits || 0}`,
        "# HELP yagami_cache_misses_total Total cache misses",
        "# TYPE yagami_cache_misses_total counter",
        `yagami_cache_misses_total ${h.cacheMisses || 0}`,
        "# HELP yagami_cache_hit_rate Cache hit rate ratio",
        "# TYPE yagami_cache_hit_rate gauge",
        `yagami_cache_hit_rate ${h.cacheHitRate || 0}`,
        "# HELP yagami_documents_cached Number of cached documents",
        "# TYPE yagami_documents_cached gauge",
        `yagami_documents_cached ${h.documentsCached || 0}`,
        "# HELP yagami_url_cache_entries Number of URL cache entries",
        "# TYPE yagami_url_cache_entries gauge",
        `yagami_url_cache_entries ${h.urlCacheEntries || 0}`,
        "# HELP yagami_deep_research_tasks Active deep research tasks",
        "# TYPE yagami_deep_research_tasks gauge",
        `yagami_deep_research_tasks ${h.deepResearchTasks || 0}`,
        "# HELP yagami_operation_slots_active Active operation slots",
        "# TYPE yagami_operation_slots_active gauge",
        `yagami_operation_slots_active ${h.operationSlotsActive || 0}`,
        "# HELP yagami_operation_slots_pending Pending operation slots",
        "# TYPE yagami_operation_slots_pending gauge",
        `yagami_operation_slots_pending ${h.operationSlotsPending || 0}`,
        "# HELP yagami_browse_slots_active Active browse slots",
        "# TYPE yagami_browse_slots_active gauge",
        `yagami_browse_slots_active ${h.browseSlotsActive || 0}`,
        "# HELP yagami_browse_slots_pending Pending browse slots",
        "# TYPE yagami_browse_slots_pending gauge",
        `yagami_browse_slots_pending ${h.browseSlotsPending || 0}`,
        "# HELP yagami_tokens_total Total tokens used",
        "# TYPE yagami_tokens_total counter",
        `yagami_tokens_total ${tokens.total || 0}`,
        "# HELP yagami_tokens_input Input tokens used",
        "# TYPE yagami_tokens_input counter",
        `yagami_tokens_input ${tokens.input || 0}`,
        "# HELP yagami_tokens_output Output tokens used",
        "# TYPE yagami_tokens_output counter",
        `yagami_tokens_output ${tokens.output || 0}`,
        "# HELP yagami_uptime_seconds Daemon uptime in seconds",
        "# TYPE yagami_uptime_seconds gauge",
        `yagami_uptime_seconds ${h.uptimeSec || 0}`,
        "",
      );
      const body = lines.join("\n");
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    if (req.method === "POST" && req.url === "/stats") {
      const body = await readJsonBody(req);
      const includeCacheEntries = Boolean(body.includeCacheEntries);
      const cacheEntriesLimit = parsePositiveInt(body.cacheEntriesLimit, 20, 500);

      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        reloading,
        result: engine.getHealth({
          includeCacheEntries,
          cacheEntriesLimit,
        }) as JsonObject,
      });
    }

    if (req.method === "POST" && req.url === "/reload") {
      const result = await reloadRuntimeConfig();
      return sendJson(res, 200, { ok: true, result });
    }

    if (req.method === "POST" && req.url === "/search/stream") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      await streamQuery(req, res, query, {});
      return;
    }

    if (req.method === "POST" && req.url === "/search") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      const result = await engine.enqueueQuery(query, {});
      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/search/advanced/stream") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      await streamQuery(req, res, query, {
        researchPolicy: body,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/search/advanced") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      const result = await engine.enqueueQuery(query, {
        researchPolicy: body,
      });

      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/fetch") {
      const body = await readJsonBody(req);
      const url = getTrimmedString(body.url);

      if (!url) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: url" });
      }

      const result = await engine.enqueueOperation(() =>
        engine.fetchContent(url, {
          maxCharacters: body.maxCharacters,
          noCache: body.noCache,
        }),
      );

      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/code-context/stream") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      await streamQuery(req, res, query, {
        researchPolicy: {
          mode: "code",
          ...body,
        },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/code-context") {
      const body = await readJsonBody(req);
      const query = getTrimmedString(body.query);

      if (!query) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: query" });
      }

      const result = await engine.enqueueQuery(query, {
        researchPolicy: {
          mode: "code",
          ...body,
        },
      });

      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/company-research/stream") {
      const body = await readJsonBody(req);
      const companyName = getTrimmedString(body.companyName || body.query);

      if (!companyName) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: companyName" });
      }

      const query = getTrimmedString(body.query || companyName);

      await streamQuery(req, res, query, {
        researchPolicy: {
          mode: "company",
          ...body,
          companyName,
        },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/company-research") {
      const body = await readJsonBody(req);
      const companyName = getTrimmedString(body.companyName || body.query);

      if (!companyName) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: companyName" });
      }

      const query = getTrimmedString(body.query || companyName);

      const result = await engine.enqueueQuery(query, {
        researchPolicy: {
          mode: "company",
          ...body,
          companyName,
        },
      });

      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/find-similar/stream") {
      const body = await readJsonBody(req);
      const url = getTrimmedString(body.url);

      if (!url) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: url" });
      }

      const query = getTrimmedString(
        body.query ||
          `Find web pages similar to ${url}. Focus on same product category, target users, and use-case overlap. Avoid dictionary/synonym pages.`,
      );

      await streamQuery(req, res, query, {
        researchPolicy: {
          mode: "similar",
          ...body,
          seedUrls: [url, ...(Array.isArray(body.seedUrls) ? body.seedUrls : [])],
        },
      });
      return;
    }

    if (req.method === "POST" && req.url === "/find-similar") {
      const body = await readJsonBody(req);
      const url = getTrimmedString(body.url);

      if (!url) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: url" });
      }

      const query = getTrimmedString(
        body.query ||
          `Find web pages similar to ${url}. Focus on same product category, target users, and use-case overlap. Avoid dictionary/synonym pages.`,
      );

      const result = await engine.enqueueQuery(query, {
        researchPolicy: {
          mode: "similar",
          ...body,
          seedUrls: [url, ...(Array.isArray(body.seedUrls) ? body.seedUrls : [])],
        },
      });

      return sendJson(res, 200, { ok: true, result: result as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/deep-research/start") {
      const body = await readJsonBody(req);
      const instructions = getTrimmedString(body.instructions);

      if (!instructions) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: instructions" });
      }

      if (body.model !== undefined) {
        return sendJson(res, 400, {
          ok: false,
          error: "Field 'model' has been removed. Use 'effort' (fast|balanced|thorough).",
        });
      }

      const result = await engine.deepResearchStart(instructions, {
        effort: body.effort,
      });

      return sendJson(res, 200, { ok: true, result: result as unknown as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/deep-research/check") {
      const body = await readJsonBody(req);
      const researchId = getTrimmedString(body.researchId);

      if (!researchId) {
        return sendJson(res, 400, { ok: false, error: "Missing required field: researchId" });
      }

      const result = await engine.deepResearchCheck(researchId);
      return sendJson(res, 200, { ok: true, result: result as unknown as Record<string, unknown> });
    }

    if (req.method === "POST" && req.url === "/stop") {
      sendJson(res, 200, { ok: true, stopping: true });
      setTimeout(() => {
        void shutdown("api-stop");
      }, 25);
      return;
    }

    return sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: toErrorMessage(error),
    });
  }
});

async function writePidFile(): Promise<void> {
  await fsp.writeFile(startupConfig.pidFile, `${process.pid}\n`, "utf8");
}

async function removePidFile(): Promise<void> {
  if (!fs.existsSync(startupConfig.pidFile)) return;

  try {
    const current = (await fsp.readFile(startupConfig.pidFile, "utf8")).trim();
    if (current === String(process.pid)) {
      await fsp.unlink(startupConfig.pidFile);
    }
  } catch {
    // ignore cleanup errors
  }
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[yagami] shutdown requested (${reason})`);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  await engine.close().catch(() => {});
  await removePidFile();

  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("sigterm");
});
process.on("SIGINT", () => {
  void shutdown("sigint");
});

await engine.init();
await writePidFile();

server.listen(startupConfig.port, startupConfig.host, () => {
  console.log(`[yagami] daemon listening on ${startupConfig.daemonUrl}`);
  console.log(`[yagami] LLM: api=${runtimeConfig.llmApi} baseUrl=${runtimeConfig.llmBaseUrl}`);
  console.log(`[yagami] Search engine: ${runtimeConfig.searchEngine || "duckduckgo"}`);
  console.log(`[yagami] CDP: ${runtimeConfig.lightpandaCdpUrl}`);
  console.log(
    `[yagami] Lightpanda auto-start: ${runtimeConfig.lightpandaAutoStart} (${runtimeConfig.lightpandaHost}:${runtimeConfig.lightpandaPort})`,
  );
});
