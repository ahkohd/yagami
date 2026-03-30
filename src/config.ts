import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LlmApi, RuntimeConfig, SearchEnginePreset, ThemeName, ToolExecutionMode } from "./types/config.js";

function toInt(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function toStringOr(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function parseToolExecutionMode(value: unknown, fallback: ToolExecutionMode = "parallel"): ToolExecutionMode {
  if (!value) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "parallel" || normalized === "sequential") return normalized;
  return fallback;
}

function parseTheme(value: unknown, fallback: ThemeName = "ansi"): ThemeName {
  if (!value) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "ansi" || normalized === "none") return normalized;
  return fallback;
}

function parseSearchEngine(value: unknown, fallback: SearchEnginePreset = "duckduckgo"): SearchEnginePreset {
  if (!value) return fallback;
  const normalized = String(value).trim().toLowerCase();

  if (normalized === "duckduckgo") return "duckduckgo";
  if (normalized === "bing") return "bing";
  if (normalized === "google") return "google";
  if (normalized === "brave") return "brave";
  if (normalized === "tavily") return "tavily";
  if (normalized === "custom") return "custom";

  return fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadFileConfig(runtimeDir: string): { configFile: string; values: Record<string, unknown> } {
  const configFile = process.env.YAGAMI_CONFIG_FILE || path.join(runtimeDir, "config.json");

  try {
    const raw = fs.readFileSync(configFile, "utf8");
    if (!raw.trim()) {
      return { configFile, values: {} };
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      return { configFile, values: {} };
    }

    const ui = isObject(parsed.ui) ? parsed.ui : {};
    return {
      configFile,
      values: {
        ...parsed,
        ...ui,
      },
    };
  } catch {
    return { configFile, values: {} };
  }
}

function parseThemeTokens(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};

  const tokens: Record<string, string> = {};

  for (const [token, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;

    const key = String(token || "").trim();
    if (!key) continue;

    const normalizedValue = String(raw).trim();
    if (!normalizedValue) continue;

    tokens[key] = normalizedValue;
  }

  return tokens;
}

function parseThemeTokensEnv(rawValue: unknown): Record<string, string> {
  if (!rawValue) return {};

  try {
    const parsed: unknown = JSON.parse(String(rawValue));
    return parseThemeTokens(parsed);
  } catch {
    return {};
  }
}

function normalizeLlmApi(value: unknown, fallback: LlmApi = "openai-completions"): LlmApi {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;

  if (raw === "anthropic-messages") return "anthropic-messages";
  if (raw === "openai-completions") return "openai-completions";

  return fallback;
}

function defaultLlmBaseUrl(api: LlmApi): string {
  if (api === "anthropic-messages") return "https://api.anthropic.com";
  return "http://127.0.0.1:1234/v1";
}

function parseCdpEndpoint(rawCdpUrl: string): { host: string; port: number } {
  try {
    const url = new URL(rawCdpUrl);
    const host = url.hostname || "127.0.0.1";
    const port = url.port ? Number.parseInt(url.port, 10) : 9222;

    return {
      host,
      port: Number.isFinite(port) ? port : 9222,
    };
  } catch {
    return {
      host: "127.0.0.1",
      port: 9222,
    };
  }
}

function defaultRuntimeDir(): string {
  const xdgConfigHome = String(process.env.XDG_CONFIG_HOME || "").trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, "yagami");
  }

  return path.join(os.homedir(), ".config", "yagami");
}

export function getConfig(): RuntimeConfig {
  const runtimeDir = process.env.YAGAMI_RUNTIME_DIR || defaultRuntimeDir();

  const fileConfig = loadFileConfig(runtimeDir);
  const fileValues = fileConfig.values || {};

  const fileHost = toStringOr(fileValues.host, "127.0.0.1");
  const filePort = toInt(fileValues.port, 43111);

  const host = toStringOr(process.env.YAGAMI_HOST, fileHost || "127.0.0.1");
  const port = toInt(process.env.YAGAMI_PORT, filePort);

  const fileTheme = parseTheme(fileValues.theme, "ansi");
  const fileThemeTokens = parseThemeTokens(fileValues.themeTokens ?? fileValues.colors ?? fileValues.themeColors);
  const envThemeTokens = parseThemeTokensEnv(process.env.YAGAMI_THEME_TOKENS);

  const fileLlmApi = normalizeLlmApi(fileValues.llmApi, "openai-completions");
  const fileLlmBaseUrl = toStringOr(fileValues.llmBaseUrl, "");
  const fileLlmApiKey = toStringOr(fileValues.llmApiKey, "");
  const fileLlmModel = toStringOr(fileValues.llmModel, "");
  const fileSearchEngine = parseSearchEngine(fileValues.searchEngine, "duckduckgo");
  const fileSearchEngineUrlTemplate = toStringOr(fileValues.searchEngineUrlTemplate, "");
  const fileTavilyApiKey = toStringOr(fileValues.tavilyApiKey, "");

  const fileBrowseLinkTimeoutMs = toInt(fileValues.browseLinkTimeoutMs, 7000);
  const fileCacheTtlMs = toInt(fileValues.cacheTtlMs, 10 * 60 * 1000);
  const fileMaxMarkdownChars = toInt(fileValues.maxMarkdownChars, 120000);
  const fileOperationConcurrency = toInt(fileValues.operationConcurrency, 4);
  const fileBrowseConcurrency = toInt(fileValues.browseConcurrency, 8);

  const llmApi = normalizeLlmApi(process.env.YAGAMI_LLM_API, fileLlmApi);
  const llmBaseUrl = toStringOr(process.env.YAGAMI_LLM_BASE_URL, fileLlmBaseUrl || defaultLlmBaseUrl(llmApi));
  const llmApiKey = toStringOr(process.env.YAGAMI_LLM_API_KEY, fileLlmApiKey || "");
  const llmModel = toStringOr(process.env.YAGAMI_LLM_MODEL, fileLlmModel || "");
  const searchEngine = parseSearchEngine(process.env.YAGAMI_SEARCH_ENGINE, fileSearchEngine);
  const searchEngineUrlTemplate = toStringOr(
    process.env.YAGAMI_SEARCH_ENGINE_URL_TEMPLATE,
    fileSearchEngineUrlTemplate || "",
  );
  const tavilyApiKey = toStringOr(process.env.TAVILY_API_KEY, fileTavilyApiKey || "");

  const lightpandaCdpUrl = process.env.YAGAMI_CDP_URL || "ws://127.0.0.1:9222";
  const cdpEndpoint = parseCdpEndpoint(lightpandaCdpUrl);

  const browseLinkTimeoutMs = toInt(process.env.YAGAMI_BROWSE_LINK_TIMEOUT_MS, fileBrowseLinkTimeoutMs);

  return {
    runtimeDir,
    configFile: fileConfig.configFile,
    host,
    port,
    daemonUrl: `http://${host}:${port}`,

    pidFile: path.join(runtimeDir, "yagami.pid"),
    logFile: path.join(runtimeDir, "yagami.log"),

    llmApi,
    llmBaseUrl,
    llmApiKey,
    llmModel,

    searchEngine,
    searchEngineUrlTemplate,
    tavilyApiKey,

    lightpandaCdpUrl,
    lightpandaHost: process.env.YAGAMI_LIGHTPANDA_HOST || cdpEndpoint.host,
    lightpandaPort: toInt(process.env.YAGAMI_LIGHTPANDA_PORT, cdpEndpoint.port),
    lightpandaAutoStart: toBool(process.env.YAGAMI_LIGHTPANDA_AUTO_START, true),
    lightpandaAutoStop: toBool(process.env.YAGAMI_LIGHTPANDA_AUTO_STOP, true),

    browseLinkTimeoutMs,
    queryTimeoutMs: toInt(process.env.YAGAMI_QUERY_TIMEOUT_MS, 180000),

    cacheTtlMs: Math.max(1000, toInt(process.env.YAGAMI_CACHE_TTL_MS, fileCacheTtlMs)),
    maxHtmlChars: toInt(process.env.YAGAMI_MAX_HTML_CHARS, 250000),
    maxMarkdownChars: toInt(process.env.YAGAMI_MAX_MARKDOWN_CHARS, fileMaxMarkdownChars),
    maxDocuments: toInt(process.env.YAGAMI_MAX_DOCUMENTS, 200),

    operationConcurrency: Math.max(1, toInt(process.env.YAGAMI_OPERATION_CONCURRENCY, fileOperationConcurrency)),
    browseConcurrency: Math.max(1, toInt(process.env.YAGAMI_BROWSE_CONCURRENCY, fileBrowseConcurrency)),

    researchMaxPages: toInt(process.env.YAGAMI_RESEARCH_MAX_PAGES, 12),
    researchMaxHops: toInt(process.env.YAGAMI_RESEARCH_MAX_HOPS, 2),
    researchSameDomainOnly: toBool(process.env.YAGAMI_RESEARCH_SAME_DOMAIN_ONLY, false),

    toolExecutionMode: parseToolExecutionMode(process.env.YAGAMI_TOOL_EXECUTION, "parallel"),
    theme: parseTheme(process.env.YAGAMI_THEME, fileTheme),
    themeTokens: {
      ...fileThemeTokens,
      ...envThemeTokens,
    },
  };
}
