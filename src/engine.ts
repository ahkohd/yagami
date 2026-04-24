// TypeScript-native engine implementation.

import { randomUUID } from "node:crypto";

import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Model } from "@mariozechner/pi-ai";
import { lightpanda } from "@lightpanda/browser";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import {
  buildDeepCustomInstruction,
  buildDeepFollowUpPrompts,
  composeDeepResearchReport,
  createDeepResearchTask,
  evictOldDeepResearchTasks,
  getDeepEffortProfile,
  resolveDeepEffort,
} from "./engine/deep-research.js";
import { ConcurrencyLimiter } from "./engine/limiter.js";
import { withSuppressedDefuddleWarnings } from "./engine/defuddle-utils.js";
import { tryFetchGitHubRepoContent } from "./engine/github-fetch.js";
import {
  buildContext,
  clampInteger,
  countWords,
  domainMatches,
  extractAssistantText,
  extractCitationUrls,
  extractTextContent,
  extractTopTerms,
  getHostname,
  isChallengeLikeContent,
  isDiscoveryDomain,
  isHostAllowed,
  isValidPublicHostname,
  normalizeDomainFilter,
  normalizeEnum,
  parseIsoDate,
  parseStringList,
  stripHtml,
  toBool,
  truncateText,
} from "./engine/helpers.js";
import { buildSystemPrompt, deriveResearchPlan, normalizeResearchPolicy } from "./engine/policy.js";
import {
  discoverSearchResults,
  parseDuckDuckGoResults,
  resolveSearchEngineTemplate,
} from "./engine/search-discovery.js";
import {
  anthropicModelsUrl,
  delay,
  fetchJson,
  joinUrl,
  normalizeLlmApi,
  normalizeThinkingLevel,
  resolveRuntimeApiKey,
} from "./engine/runtime-utils.js";
import { normalizeUniqueUrls, normalizeUrl, normalizeUrlForDedupe, rewriteBrowseUrl } from "./engine/url-utils.js";
import type { RuntimeConfig } from "./types/config.js";
import type {
  DeepResearchCheckResult,
  DeepResearchStartResult,
  DeepResearchTaskRecord,
  NormalizedResearchPolicy,
  RawResearchPolicy,
  ResearchPlan,
  WebSearchLikeResult,
} from "./types/engine.js";

function collectResultCitations(answer: string, toolProfiles: Array<Record<string, unknown>>): string[] {
  const candidates: string[] = [];

  for (const url of extractCitationUrls(answer)) {
    candidates.push(url);
  }

  for (const tool of toolProfiles) {
    if (tool.isError) continue;
    const url = String(tool.url || "").trim();
    if (url) candidates.push(url);
  }

  const citations: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    let normalized: string;
    let dedupeKey: string;
    try {
      normalized = normalizeUrl(candidate);
      dedupeKey = normalizeUrlForDedupe(normalized);
    } catch {
      continue;
    }

    const hostname = getHostname(normalized);
    if (!hostname) continue;
    if (!isValidPublicHostname(hostname)) continue;
    if (isDiscoveryDomain(hostname)) continue;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    citations.push(normalized);
  }

  return citations;
}

function collectResultFindings(toolsUsed: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const findings: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const tool of toolsUsed) {
    if (String(tool.toolName || "") !== "present") continue;
    if (tool.isError) continue;

    const details = (tool.details as Record<string, unknown> | null) || {};
    const rawUrl = String(details.url || details.finalUrl || "").trim();
    if (!rawUrl) continue;

    let normalizedUrl: string;
    let dedupeKey: string;
    try {
      normalizedUrl = normalizeUrl(rawUrl);
      dedupeKey = normalizeUrlForDedupe(normalizedUrl);
    } catch {
      continue;
    }

    if (seen.has(dedupeKey)) continue;

    const content = String(details.content || "").trim();
    const wordCount = Number(details.wordCount || 0) || 0;

    if (!content) continue;

    seen.add(dedupeKey);
    findings.push({
      sourceType: "present",
      rank: findings.length + 1,
      url: normalizedUrl,
      title: String(details.title || "").trim(),
      author: String(details.author || "").trim(),
      published: String(details.published || "").trim(),
      wordCount: wordCount || undefined,
      documentId: String(details.documentId || "").trim(),
      content,
      truncated: Boolean(details.truncated),
    });
  }

  if (findings.length > 0) {
    return findings;
  }

  for (const tool of toolsUsed) {
    if (String(tool.toolName || "") !== "browse") continue;
    if (tool.isError) continue;

    const details = (tool.details as Record<string, unknown> | null) || {};
    const rawUrl = String(details.finalUrl || details.url || "").trim();
    if (!rawUrl) continue;

    let normalizedUrl: string;
    let dedupeKey: string;
    try {
      normalizedUrl = normalizeUrl(rawUrl);
      dedupeKey = normalizeUrlForDedupe(normalizedUrl);
    } catch {
      continue;
    }

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    findings.push({
      sourceType: "browse",
      rank: findings.length + 1,
      url: normalizedUrl,
      title: String(details.title || "").trim(),
      status: Number(details.status || 0) || undefined,
      documentId: String(details.documentId || "").trim(),
      content: "",
    });
  }

  return findings;
}

function buildCollatedAnswer(
  findings: Array<Record<string, unknown>>,
  toolsUsed: Array<Record<string, unknown>>,
): string {
  const lines: string[] = [];

  for (const finding of findings) {
    const url = String(finding.url || "").trim();
    const title = String(finding.title || "").trim() || "Untitled";
    const author = String(finding.author || "").trim() || "Unknown";
    const publishedRaw = String(finding.published || "").trim();
    const published = publishedRaw && publishedRaw.toLowerCase() !== "unknown" ? publishedRaw : "Unknown";
    const content = String(finding.content || "").trim();

    lines.push(`**Title:** ${title}  `);
    lines.push(`**Author:** ${author}  `);
    lines.push(`**Published Date:** ${published}  `);
    lines.push(`**URL:** ${url}`);
    lines.push("");
    if (content) {
      lines.push(content.replace(/```/g, "``\u200b`"));
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  const failedCalls = toolsUsed
    .filter((tool) => Boolean(tool.isError))
    .slice(0, 12)
    .map((tool) => {
      const details = (tool.details as Record<string, unknown> | null) || {};
      const rawUrl = String(details.url || details.finalUrl || "").trim();
      const rawError =
        String(tool.errorMessage || "")
          .trim()
          .split("\n")[0] || "tool call failed";
      return {
        toolName: String(tool.toolName || "tool"),
        url: rawUrl,
        error: rawError,
      };
    });

  if (findings.length === 0) {
    if (toolsUsed.length > 0 && failedCalls.length === 0) {
      lines.push("No sources were selected from gathered pages.", "");
    } else {
      lines.push("No sources were successfully extracted.", "");
    }

    if (failedCalls.length > 0) {
      lines.push("Errors:");
      for (const failed of failedCalls) {
        const suffix = failed.url ? ` ${failed.url}` : "";
        lines.push(`- [${failed.toolName}]${suffix} — ${failed.error}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}

function isExplicitNoneCollateAnswer(answer: string): boolean {
  const raw = String(answer || "").trim();
  if (!raw) return false;

  if (/^NONE$/i.test(raw)) return true;

  const blockMatch = raw.match(/SOURCES([\s\S]*?)SOURCES/i);
  if (!blockMatch) return false;

  return /^NONE$/i.test(String(blockMatch[1] || "").trim());
}

function throwIfAborted(signal: AbortSignal | undefined, message = "operation aborted"): void {
  if (signal?.aborted) {
    throw new Error(message);
  }
}

function asAbortSignal(value: unknown): AbortSignal | undefined {
  if (!value || typeof value !== "object") return undefined;

  const candidate = value as { aborted?: unknown; addEventListener?: unknown; removeEventListener?: unknown };
  if (
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  ) {
    return value as AbortSignal;
  }

  return undefined;
}

function toFiniteNonNegativeNumber(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

export class YagamiEngine {
  config: RuntimeConfig & { [key: string]: unknown };
  logger: Console;
  operationLimiter: ConcurrencyLimiter;
  browseLimiter: ConcurrencyLimiter;
  model: Model<"anthropic-messages"> | Model<"openai-completions"> | null;
  initPromise: Promise<void> | null;
  browser: Browser | null;
  lightpandaManaged: boolean;
  lightpandaProcess: {
    pid?: number;
    kill: (signal?: string) => void;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    once: (event: string, listener: () => void) => void;
    removeListener: (event: string, listener: () => void) => void;
  } | null;

  documents: Map<string, Record<string, unknown>>;
  urlCache: Map<string, { documentId: string; expiresAt: number }>;
  presentCache: Map<string, { maxChars: number; payload: Record<string, unknown> }>;
  deepResearchTasks: Map<string, DeepResearchTaskRecord>;
  metrics: {
    cacheHits: number;
    cacheMisses: number;
    queries: number;
    activeQueries: number;
    startedAt: number;
    tokenInput: number;
    tokenOutput: number;
    tokenCacheRead: number;
    tokenCacheWrite: number;
    tokenTotal: number;
    costInput: number;
    costOutput: number;
    costCacheRead: number;
    costCacheWrite: number;
    costTotal: number;
    queriesByType: Record<string, number>;
    errorsByType: Record<string, number>;
    durationSumByType: Record<string, number>;
    durationCountByType: Record<string, number>;
  };

  constructor(config: RuntimeConfig & object, logger: Console = console) {
    this.config = config as RuntimeConfig & { [key: string]: unknown };
    this.logger = logger;

    this.browser = null;
    this.model = null;

    this.lightpandaProcess = null;
    this.lightpandaManaged = false;

    this.documents = new Map();
    this.urlCache = new Map();
    this.presentCache = new Map();
    this.deepResearchTasks = new Map();

    this.operationLimiter = new ConcurrencyLimiter(Math.max(1, Number(this.config.operationConcurrency || 4)));
    this.browseLimiter = new ConcurrencyLimiter(Math.max(1, Number(this.config.browseConcurrency || 8)));

    this.initPromise = null;

    this.metrics = {
      queries: 0,
      activeQueries: 0,
      cacheHits: 0,
      cacheMisses: 0,
      startedAt: Date.now(),
      tokenInput: 0,
      tokenOutput: 0,
      tokenCacheRead: 0,
      tokenCacheWrite: 0,
      tokenTotal: 0,
      costInput: 0,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 0,
      queriesByType: {},
      errorsByType: {},
      durationSumByType: {},
      durationCountByType: {},
    };
  }

  log(message: string): void {
    this.logger.log(`[yagami] ${message}`);
  }

  normalizeResearchPolicy(rawPolicy: RawResearchPolicy = {}): NormalizedResearchPolicy {
    return normalizeResearchPolicy(rawPolicy);
  }

  deriveResearchPlan(query: string, options: { researchPolicy?: RawResearchPolicy } = {}): ResearchPlan {
    return deriveResearchPlan(query, this.config, options);
  }

  buildSystemPrompt(plan: ResearchPlan): string {
    const resolvedSearch = resolveSearchEngineTemplate(this.config.searchEngine, this.config.searchEngineUrlTemplate);

    const template = resolvedSearch.template.includes("{query}")
      ? resolvedSearch.template.replace(/\{query\}/g, "<url-encoded query>")
      : resolvedSearch.template.includes("%s")
        ? resolvedSearch.template.replace(/%s/g, "<url-encoded query>")
        : `${resolvedSearch.template}<url-encoded query>`;

    return buildSystemPrompt(plan, { engine: resolvedSearch.engine, template });
  }

  async init(): Promise<void> {
    if (this.model) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      const api = normalizeLlmApi(this.config.llmApi);
      const provider = api === "anthropic-messages" ? "anthropic" : "openai";
      const baseUrl = this.config.llmBaseUrl;
      const configuredModelId = this.config.llmModel;
      const modelId = configuredModelId || (await this.detectModelId(api, baseUrl));

      if (api === "anthropic-messages") {
        this.model = {
          id: modelId,
          name: `Anthropic ${modelId}`,
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 8192,
        };
      } else {
        this.model = {
          id: modelId,
          name: `Local ${modelId}`,
          api: "openai-completions",
          provider,
          baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 262144,
          maxTokens: 8192,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        };
      }

      this.log(`using model ${this.model.id} (${this.model.api}) via ${this.model.baseUrl}`);
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async detectModelId(api: "anthropic-messages" | "openai-completions", baseUrl: string): Promise<string> {
    if (api === "anthropic-messages") {
      const data = await fetchJson(anthropicModelsUrl(baseUrl), {
        method: "GET",
        headers: {
          "x-api-key": resolveRuntimeApiKey(api, this.config.llmApiKey),
          "anthropic-version": "2023-06-01",
        },
      });

      const modelId = ((data?.data as Array<{ id?: string }> | undefined)?.[0]?.id || "").trim();
      if (!modelId) {
        throw new Error(`Could not detect model from ${anthropicModelsUrl(baseUrl)}. Set YAGAMI_LLM_MODEL explicitly.`);
      }

      return modelId;
    }

    const data = await fetchJson(joinUrl(baseUrl, "models"), {
      method: "GET",
      headers: {
        authorization: `Bearer ${resolveRuntimeApiKey(api, this.config.llmApiKey)}`,
      },
    });

    const modelId = ((data?.data as Array<{ id?: string }> | undefined)?.[0]?.id || "").trim();
    if (!modelId) {
      throw new Error(`Could not detect model from ${joinUrl(baseUrl, "models")}. Set YAGAMI_LLM_MODEL explicitly.`);
    }

    return modelId;
  }

  async connectBrowser(): Promise<Browser> {
    this.log(`connecting to Lightpanda CDP at ${this.config.lightpandaCdpUrl}`);
    const browser = await chromium.connectOverCDP(this.config.lightpandaCdpUrl);

    browser.on("disconnected", () => {
      this.log("CDP connection disconnected");
      this.browser = null;
    });

    return browser;
  }

  async startManagedLightpanda(): Promise<void> {
    if (this.lightpandaProcess) return;

    this.log(`starting managed Lightpanda on ${this.config.lightpandaHost}:${this.config.lightpandaPort}`);

    const processHandle = (await lightpanda.serve({
      host: this.config.lightpandaHost,
      port: this.config.lightpandaPort,
    })) as unknown as {
      pid?: number;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      kill: (signal?: string) => void;
      once: (event: string, listener: () => void) => void;
      removeListener: (event: string, listener: () => void) => void;
    };

    this.lightpandaProcess = processHandle;
    this.lightpandaManaged = true;

    processHandle.on("exit", (code, signal) => {
      this.log(`managed Lightpanda exited (code=${String(code ?? "null")}, signal=${String(signal ?? "null")})`);
      this.lightpandaProcess = null;
      this.lightpandaManaged = false;
    });

    processHandle.on("error", (error) => {
      const message = (error as Error)?.message || String(error);
      this.log(`managed Lightpanda error: ${message}`);
    });
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;

    try {
      this.browser = await this.connectBrowser();
      return this.browser;
    } catch (initialError) {
      if (!this.config.lightpandaAutoStart) {
        throw initialError;
      }

      if (!this.lightpandaProcess) {
        await this.startManagedLightpanda();
      }

      const retries = 12;
      for (let i = 0; i < retries; i += 1) {
        try {
          this.browser = await this.connectBrowser();
          return this.browser;
        } catch {
          await delay(250);
        }
      }

      throw initialError;
    }
  }

  evictOldDocuments(): void {
    while (this.documents.size > this.config.maxDocuments) {
      const oldestKey = this.documents.keys().next().value;
      if (!oldestKey) break;
      this.documents.delete(oldestKey);
      this.presentCache.delete(oldestKey);
    }
  }

  getCachedByUrl(url: string): Record<string, unknown> | null {
    const entry = this.urlCache.get(url);
    if (!entry) return null;

    if (entry.expiresAt < Date.now()) {
      this.urlCache.delete(url);
      return null;
    }

    const doc = this.documents.get(entry.documentId);
    if (!doc) {
      this.urlCache.delete(url);
      return null;
    }

    return doc;
  }

  formatBrowseResult(doc: Record<string, unknown>, fromCache: boolean): Record<string, unknown> {
    return {
      documentId: doc.id,
      url: doc.url,
      finalUrl: doc.finalUrl,
      status: doc.status,
      title: doc.title || "",
      contentType: doc.contentType || "text/html",
      fetchedAt: new Date(Number(doc.fetchedAt || Date.now())).toISOString(),
      bytes: Buffer.byteLength(String(doc.html || ""), "utf8"),
      fromCache,
    };
  }

  isRecoverableBrowseError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
    if (!message) return false;

    const recoverablePatterns = [
      "target page, context or browser has been closed",
      "target closed",
      "browser has been closed",
      "connection closed",
      "has been disconnected",
      "disconnected",
      "socket hang up",
      "econnreset",
      "websocket is not open",
      "connect econnrefused",
      "failed to connect",
      "protocol error",
    ];

    return recoverablePatterns.some((pattern) => message.includes(pattern));
  }

  isTimeoutBrowseError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error || "")).toLowerCase();
    return message.includes("timeout");
  }

  extractTitleFromHtml(html: string): string {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch?.[1]) return "";
    return titleMatch[1].replace(/\s+/g, " ").trim();
  }

  extractMarkdownFrontmatterField(markdown: string, fieldName: string): string {
    const input = String(markdown || "");
    const match = input.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
    if (!match?.[1]) return "";

    const normalizedField = String(fieldName || "")
      .trim()
      .toLowerCase();

    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = String(rawLine || "").trim();
      if (!line || line.startsWith("#")) continue;
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) continue;

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      if (key !== normalizedField) continue;

      return line.slice(separatorIndex + 1).trim();
    }

    return "";
  }

  stripMarkdownFrontmatter(markdown: string): string {
    const input = String(markdown || "");
    return input.replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "").trim();
  }

  extractTitleFromMarkdown(markdown: string): string {
    const fromFrontmatter = this.extractMarkdownFrontmatterField(markdown, "title");
    if (fromFrontmatter) return fromFrontmatter;

    const body = this.stripMarkdownFrontmatter(markdown);
    const headingMatch = body.match(/^#\s+(.+)$/m);
    if (!headingMatch?.[1]) return "";
    return headingMatch[1].replace(/\s+/g, " ").trim();
  }

  isMarkdownContentType(contentType: string): boolean {
    const normalized = String(contentType || "")
      .trim()
      .toLowerCase();
    if (!normalized) return false;
    return normalized.includes("markdown") || normalized.includes("text/plain; profile=markdown");
  }

  buildHttpAcceptHeader(expectedContentType: string): string {
    if (this.isMarkdownContentType(expectedContentType)) {
      return "text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.5";
    }

    return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  }

  extractTextFromHtmlFallback(html: string): string {
    const withoutScripts = String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
    return stripHtml(withoutScripts);
  }

  getHttpEscalationReason(result: { status: number; title: string; html: string; contentType: string }): string | null {
    const body = String(result.html || "").trim();
    const title = String(result.title || "").trim();

    if (result.status >= 400) {
      return `http status ${result.status}`;
    }

    if (!body) {
      return this.isMarkdownContentType(result.contentType) ? "empty markdown" : "empty html";
    }

    if (this.isMarkdownContentType(result.contentType)) {
      if (body.length < 80) {
        return "markdown too short";
      }
      return null;
    }

    if (isChallengeLikeContent(title, body)) {
      return "challenge/interstitial content";
    }

    if (body.length < 800) {
      return "html too short";
    }

    return null;
  }

  async browseViaHttpFallback(
    url: string,
    abortSignal?: AbortSignal,
    expectedContentType = "text/html",
  ): Promise<{ status: number; finalUrl: string; html: string; title: string; contentType: string }> {
    throwIfAborted(abortSignal, "browse aborted");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.browseLinkTimeoutMs);

    const onAbort = () => {
      controller.abort();
    };
    if (abortSignal) abortSignal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Yagami/0.1 (+https://github.com/yagami)",
          accept: this.buildHttpAcceptHeader(expectedContentType),
        },
      });

      throwIfAborted(abortSignal, "browse aborted");

      const bodyRaw = await response.text();
      const body = truncateText(bodyRaw, this.config.maxHtmlChars, "YAGAMI_MAX_HTML_CHARS");
      const responseContentType = String(response.headers.get("content-type") || expectedContentType || "text/html")
        .trim()
        .toLowerCase();

      return {
        status: response.status,
        finalUrl: response.url || url,
        html: body,
        title: this.isMarkdownContentType(responseContentType)
          ? this.extractTitleFromMarkdown(body)
          : this.extractTitleFromHtml(body),
        contentType: responseContentType,
      };
    } finally {
      clearTimeout(timeoutId);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    }
  }

  async resetBrowserForRetry(): Promise<void> {
    const currentBrowser = this.browser;
    this.browser = null;

    if (currentBrowser && typeof currentBrowser.close === "function") {
      try {
        await currentBrowser.close();
      } catch {
        // Ignore close errors while recovering from a failed browse attempt.
      }
    }

    await delay(150);
  }

  async browse(rawUrl: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const abortSignal = asAbortSignal(options.abortSignal);

    return await this.enqueueBrowse(async () => {
      throwIfAborted(abortSignal, "browse aborted");

      const startedAt = Date.now();
      const url = normalizeUrl(rawUrl);
      const rewriteResult = rewriteBrowseUrl(url);
      const browseUrl = rewriteResult.url;
      const bypassCache = toBool(options.bypassCache, false);

      if (!bypassCache) {
        const cached = this.getCachedByUrl(url);
        if (cached) {
          this.metrics.cacheHits += 1;
          return {
            ...this.formatBrowseResult(cached, true),
            timing: {
              cache: "hit",
              totalMs: Date.now() - startedAt,
            },
          };
        }
      }

      this.metrics.cacheMisses += 1;

      if (rewriteResult.rewritten) {
        this.log(
          `rewriting browse URL (${rewriteResult.ruleId || "rule"}): ${url} -> ${browseUrl} (expect=${rewriteResult.expectedContentType})`,
        );
      }

      const persistDocument = (source: {
        finalUrl: string;
        status: number;
        title: string;
        html: string;
        contentType?: string;
      }) => {
        const doc = {
          id: randomUUID(),
          url,
          finalUrl: rewriteResult.preserveCanonicalUrl ? url : source.finalUrl,
          status: source.status,
          title: source.title,
          html: source.html,
          contentType: String(source.contentType || rewriteResult.expectedContentType || "text/html"),
          fetchedAt: Date.now(),
        };

        this.documents.set(doc.id, doc);
        if (!bypassCache) {
          this.urlCache.set(url, {
            documentId: doc.id,
            expiresAt: Date.now() + this.config.cacheTtlMs,
          });
        }
        this.evictOldDocuments();

        return doc;
      };

      type HttpAttempt = {
        status: number;
        finalUrl: string;
        html: string;
        title: string;
        contentType: string;
        durationMs: number;
        escalationReason: string | null;
      };

      let httpAttempt: HttpAttempt | null = null;
      let httpFirstError: unknown = null;

      try {
        const httpStart = Date.now();
        const httpResult = await this.browseViaHttpFallback(browseUrl, abortSignal, rewriteResult.expectedContentType);
        const httpDurationMs = Date.now() - httpStart;
        const escalationReason = this.getHttpEscalationReason(httpResult);

        httpAttempt = {
          ...httpResult,
          durationMs: httpDurationMs,
          escalationReason,
        };

        if (!escalationReason) {
          const doc = persistDocument(httpResult);
          return {
            ...this.formatBrowseResult(doc, false),
            timing: {
              cache: "miss",
              totalMs: Date.now() - startedAt,
              strategy: "http",
              httpMs: httpDurationMs,
            },
          };
        }

        this.log(`http-first browse escalation for ${url}: ${escalationReason}`);
      } catch (error) {
        httpFirstError = error;
        const message = error instanceof Error ? error.message : String(error);
        this.log(`http-first browse failed for ${url}: ${message}`);
      }

      const maxAttempts = 2;
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let ensureBrowserMs = 0;
        let contextMs = 0;
        let newPageMs = 0;
        let context: BrowserContext | null = null;
        let page: Page | null = null;
        let abortCleanup: (() => void) | null = null;

        try {
          throwIfAborted(abortSignal, "browse aborted");

          const ensureBrowserStart = Date.now();
          const browser = await this.ensureBrowser();
          ensureBrowserMs = Date.now() - ensureBrowserStart;

          const contextStart = Date.now();
          context = await browser.newContext();
          contextMs = Date.now() - contextStart;

          const pageStart = Date.now();
          page = await context.newPage();
          newPageMs = Date.now() - pageStart;

          if (abortSignal) {
            const onAbort = () => {
              void page?.close().catch(() => {});
              void context?.close().catch(() => {});
            };
            abortSignal.addEventListener("abort", onAbort, { once: true });
            abortCleanup = () => abortSignal.removeEventListener("abort", onAbort);
          }

          throwIfAborted(abortSignal, "browse aborted");

          const gotoStart = Date.now();
          const response = await page.goto(browseUrl, {
            waitUntil: "domcontentloaded",
            timeout: this.config.browseLinkTimeoutMs,
          });
          const gotoMs = Date.now() - gotoStart;

          throwIfAborted(abortSignal, "browse aborted");

          const contentStart = Date.now();
          const htmlRaw = await page.content();
          const html = truncateText(htmlRaw, this.config.maxHtmlChars);
          const contentMs = Date.now() - contentStart;

          const titleStart = Date.now();
          const title = await page.title();
          const titleMs = Date.now() - titleStart;

          throwIfAborted(abortSignal, "browse aborted");

          const browserContentType = String(response?.headers()?.["content-type"] || "text/html")
            .trim()
            .toLowerCase();
          const doc = persistDocument({
            finalUrl: page.url(),
            status: response?.status() ?? 0,
            title,
            html,
            contentType: browserContentType || "text/html",
          });

          return {
            ...this.formatBrowseResult(doc, false),
            timing: {
              cache: "miss",
              totalMs: Date.now() - startedAt,
              strategy: "browser",
              ensureBrowserMs,
              contextMs,
              newPageMs,
              gotoMs,
              contentMs,
              titleMs,
              httpFirstMs: httpAttempt?.durationMs,
              httpEscalationReason: httpAttempt?.escalationReason || undefined,
              httpFirstError:
                httpFirstError instanceof Error
                  ? httpFirstError.message
                  : httpFirstError
                    ? String(httpFirstError)
                    : undefined,
            },
          };
        } catch (error) {
          lastError = error;

          if (abortSignal?.aborted) {
            break;
          }

          if (this.isTimeoutBrowseError(error) && !httpAttempt) {
            try {
              const fallbackStart = Date.now();
              const fallback = await this.browseViaHttpFallback(
                browseUrl,
                abortSignal,
                rewriteResult.expectedContentType,
              );
              const fallbackMs = Date.now() - fallbackStart;
              const escalationReason = this.getHttpEscalationReason(fallback);
              httpAttempt = {
                ...fallback,
                durationMs: fallbackMs,
                escalationReason,
              };

              if (!escalationReason) {
                const doc = persistDocument(fallback);
                return {
                  ...this.formatBrowseResult(doc, false),
                  timing: {
                    cache: "miss",
                    totalMs: Date.now() - startedAt,
                    strategy: "http-timeout-fallback",
                    fallbackMs,
                  },
                };
              }

              this.log(`http fallback escalation for ${url}: ${escalationReason}`);
            } catch (fallbackError) {
              const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
              this.log(`http fallback failed for ${url}: ${fallbackMessage}`);
              lastError = fallbackError;
            }
          }

          const shouldRetry = attempt < maxAttempts && this.isRecoverableBrowseError(error);
          if (!shouldRetry) {
            break;
          }

          const message = error instanceof Error ? error.message : String(error);
          this.log(`browse attempt failed for ${url}; retrying with fresh browser: ${message}`);
          await this.resetBrowserForRetry();
        } finally {
          if (abortCleanup) abortCleanup();
          if (page) await page.close().catch(() => {});
          if (context) await context.close().catch(() => {});
        }
      }

      throwIfAborted(abortSignal, "browse aborted");

      if (httpAttempt) {
        const doc = persistDocument(httpAttempt);
        return {
          ...this.formatBrowseResult(doc, false),
          timing: {
            cache: "miss",
            totalMs: Date.now() - startedAt,
            strategy: "http-after-browser-failure",
            httpMs: httpAttempt.durationMs,
            httpEscalationReason: httpAttempt.escalationReason || undefined,
            browserError: lastError instanceof Error ? lastError.message : lastError ? String(lastError) : undefined,
          },
        };
      }

      if (lastError instanceof Error) throw lastError;
      if (httpFirstError instanceof Error) throw httpFirstError;
      throw new Error(`browse failed for ${url}`);
    }, abortSignal);
  }

  async present(documentId: string, maxChars = this.config.maxMarkdownChars): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const doc = this.documents.get(documentId);
    if (!doc) {
      throw new Error(`Unknown documentId: ${documentId}. Call browse(url) first.`);
    }

    const cached = this.presentCache.get(documentId);
    if (cached && cached.maxChars === maxChars) {
      return {
        ...cached.payload,
        timing: {
          cache: "hit",
          totalMs: Date.now() - startedAt,
        },
      };
    }

    const docContentType = String(doc.contentType || "")
      .trim()
      .toLowerCase();
    if (this.isMarkdownContentType(docContentType)) {
      const parseStart = Date.now();
      const rawMarkdown = String(doc.html || "");
      const markdownBody = this.stripMarkdownFrontmatter(rawMarkdown);
      const parseMs = Date.now() - parseStart;

      const formatStart = Date.now();
      const content = truncateText(markdownBody, maxChars, "YAGAMI_MAX_MARKDOWN_CHARS");
      const sourceTitle = this.extractTitleFromMarkdown(rawMarkdown);
      const sourceTimestamp = this.extractMarkdownFrontmatterField(rawMarkdown, "timestamp");
      const publishedDate = parseIsoDate(sourceTimestamp);

      const payload = {
        documentId,
        url: String(doc.finalUrl || doc.url || ""),
        title: String(sourceTitle || doc.title || "").trim(),
        author: String(doc.author || "Unknown"),
        published: publishedDate ? publishedDate.toISOString() : "Unknown",
        wordCount: countWords(content),
        content,
        truncated: markdownBody.length > content.length,
        extractor: "markdown-pass-through",
        extractorError: undefined,
      };
      const formatMs = Date.now() - formatStart;

      this.presentCache.set(documentId, { maxChars, payload });

      return {
        ...payload,
        timing: {
          cache: "miss",
          totalMs: Date.now() - startedAt,
          parseMs,
          formatMs,
          contentType: docContentType,
        },
      };
    }

    const importStart = Date.now();
    const [defuddleModule, linkedomModule] = await Promise.all([import("defuddle/node"), import("linkedom")]);
    const importMs = Date.now() - importStart;

    const Defuddle = (
      defuddleModule as unknown as { Defuddle: (...args: unknown[]) => Promise<Record<string, unknown>> }
    ).Defuddle;
    const parseHTML = (linkedomModule as unknown as { parseHTML: (html: string) => { document: unknown } }).parseHTML;

    const parseStart = Date.now();
    const parsed = parseHTML(String(doc.html || ""));
    const document = (parsed as { document: unknown }).document;
    const windowLike =
      ((document as { defaultView?: Record<string, unknown> }).defaultView as Record<string, unknown> | undefined) ||
      (document as Record<string, unknown>);
    if (typeof windowLike.getComputedStyle !== "function") {
      windowLike.getComputedStyle = () => new Proxy({}, { get: () => "" });
    }
    const parseMs = Date.now() - parseStart;

    const extractStart = Date.now();
    let extracted: Record<string, unknown>;
    let extractor: "defuddle" | "fallback-strip-html" = "defuddle";
    let extractorError: string | null = null;

    try {
      const extractedResult = await withSuppressedDefuddleWarnings(
        async () => await Defuddle(document, String(doc.finalUrl || doc.url || ""), { markdown: true }),
      );
      extracted = extractedResult.value;
    } catch (error) {
      extractor = "fallback-strip-html";
      extractorError = error instanceof Error ? error.message : String(error);
      this.log(`present defuddle fallback for ${String(doc.finalUrl || doc.url || "")}: ${extractorError}`);

      const fallbackText = this.extractTextFromHtmlFallback(String(doc.html || ""));
      extracted = {
        title: String(doc.title || this.extractTitleFromHtml(String(doc.html || ""))),
        author: "Unknown",
        published: "Unknown",
        wordCount: countWords(fallbackText),
        content: fallbackText,
      };
    }

    const extractMs = Date.now() - extractStart;

    const formatStart = Date.now();
    const rawContent = String(extracted.content || "");
    const content = truncateText(rawContent, maxChars, "YAGAMI_MAX_MARKDOWN_CHARS");

    const payload = {
      documentId,
      url: String(doc.finalUrl || doc.url || ""),
      title: String(extracted.title || doc.title || ""),
      author: String(extracted.author || "Unknown"),
      published: String(extracted.published || "Unknown"),
      wordCount: Number(extracted.wordCount || countWords(content)),
      content,
      truncated: rawContent.length > content.length,
      extractor,
      extractorError: extractorError || undefined,
    };
    const formatMs = Date.now() - formatStart;

    this.presentCache.set(documentId, { maxChars, payload });

    return {
      ...payload,
      timing: {
        cache: "miss",
        totalMs: Date.now() - startedAt,
        importMs,
        parseMs,
        extractMs,
        formatMs,
      },
    };
  }

  async parseDuckDuckGoResults(
    html: string,
    options: { limit?: number } = {},
  ): Promise<Array<Record<string, unknown>>> {
    return await parseDuckDuckGoResults(html, options);
  }

  async discoverSearchResults(query: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return await discoverSearchResults(query, {
      ...options,
      searchEngine: options.searchEngine ?? this.config.searchEngine,
      searchEngineUrlTemplate: options.searchEngineUrlTemplate ?? this.config.searchEngineUrlTemplate,
    });
  }

  async tryFetchGitHubRepoContent(
    requestedUrl: string,
    maxCharacters: number,
  ): Promise<Record<string, unknown> | null> {
    return await tryFetchGitHubRepoContent(requestedUrl, maxCharacters, {
      log: (message) => this.log(message),
    });
  }

  async fetchContent(url: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const queryType = "fetch";
    this.recordOperationStart(queryType, { countAsQuery: false });
    let failed = false;

    try {
      const maxCharacters = clampInteger(options.maxCharacters, 3000, {
        min: 500,
        max: 200000,
      });
      const noCache = toBool(options.noCache, false);
      const requestedUrl = normalizeUrl(url);

      const githubResult = await this.tryFetchGitHubRepoContent(requestedUrl, maxCharacters);
      if (githubResult) {
        return githubResult;
      }

      const browseResult = await this.browse(requestedUrl, { bypassCache: noCache });
      const documentId = String(browseResult.documentId || "");
      if (!documentId) {
        throw new Error("browse() returned no documentId");
      }

      const presentResult = await this.present(documentId, maxCharacters);

      const browseTiming = (browseResult.timing as Record<string, unknown> | undefined) || {};
      const presentTiming = (presentResult.timing as Record<string, unknown> | undefined) || {};

      const browseCache = String(browseTiming.cache || (browseResult.fromCache ? "hit" : "miss"));
      const presentCache = String(presentTiming.cache || "miss");

      return {
        url: String(presentResult.url || ""),
        requestedUrl,
        title: String(presentResult.title || ""),
        author: String(presentResult.author || "Unknown"),
        published: String(presentResult.published || "Unknown"),
        wordCount: Number(presentResult.wordCount || 0),
        content: String(presentResult.content || ""),
        truncated: Boolean(presentResult.truncated),
        documentId,
        status: Number(browseResult.status || 0),
        cache: {
          browse: browseCache,
          present: presentCache,
        },
        timing: {
          totalMs: Date.now() - startedAt,
          browseMs: (browseTiming.totalMs as number | null) || null,
          presentMs: (presentTiming.totalMs as number | null) || null,
        },
      };
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.recordOperationEnd(queryType, startedAt, failed, { countAsQuery: false });
    }
  }

  async webSearch(query: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw new Error("query is required");

    const type = normalizeEnum(options.type, ["auto", "fast"], "auto");
    const livecrawl = normalizeEnum(options.livecrawl, ["fallback", "preferred"], "fallback");

    const numResults = clampInteger(options.numResults, 8, { min: 1, max: 20 });
    const contextMaxCharacters = clampInteger(options.contextMaxCharacters, 10000, {
      min: 1000,
      max: 200000,
    });
    const textMaxCharacters = clampInteger(
      options.textMaxCharacters,
      Math.max(1500, Math.floor(contextMaxCharacters / Math.max(1, numResults))),
      { min: 500, max: 50000 },
    );

    const discovery = await this.discoverSearchResults(normalizedQuery, {
      ...options,
      numResults: Math.max(numResults * 3, numResults + 8),
      type,
      livecrawl,
    });

    const discovered = Array.isArray(discovery.results) ? discovery.results : [];
    const selected = discovered.slice(0, numResults) as Array<Record<string, unknown>>;
    const results: Array<Record<string, unknown>> = [];

    for (const result of selected) {
      try {
        const content = await this.fetchContent(String(result.url || ""), {
          maxCharacters: textMaxCharacters,
          noCache: toBool(options.noCache, false),
        });

        const contentRecord = content as Record<string, unknown>;

        results.push({
          rank: result.rank,
          url: contentRecord.url,
          title: contentRecord.title || result.title,
          snippet: result.snippet,
          author: contentRecord.author,
          published: contentRecord.published,
          content: contentRecord.content,
          wordCount: contentRecord.wordCount,
          status: contentRecord.status,
          cache: contentRecord.cache,
        });
      } catch (error) {
        results.push({
          rank: result.rank,
          url: result.url,
          title: result.title,
          snippet: result.snippet,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const context = buildContext(results, contextMaxCharacters);

    return {
      query: normalizedQuery,
      type,
      livecrawl,
      context,
      results,
      searchUrl: discovery.searchUrl,
      discoveredResults: discovered.length,
      durationMs: Date.now() - startedAt,
    };
  }

  async webSearchAdvanced(options: Record<string, unknown> = {}): Promise<WebSearchLikeResult> {
    const query = String(options.query || "").trim();
    if (!query) throw new Error("query is required");

    const type = normalizeEnum(options.type, ["auto", "fast", "neural"], "auto");
    const livecrawl = normalizeEnum(options.livecrawl, ["never", "fallback", "always", "preferred"], "fallback");

    const numResults = clampInteger(options.numResults, 10, { min: 1, max: 20 });
    const textMaxCharacters = clampInteger(options.textMaxCharacters, 3500, {
      min: 500,
      max: 50000,
    });
    const contextMaxCharacters = clampInteger(options.contextMaxCharacters, 14000, {
      min: 1000,
      max: 200000,
    });

    const base = (await this.webSearch(query, {
      ...options,
      numResults,
      type: type === "neural" ? "auto" : type,
      livecrawl: livecrawl === "always" ? "preferred" : livecrawl,
      textMaxCharacters,
      contextMaxCharacters,
    })) as WebSearchLikeResult;

    const startDate = parseIsoDate(options.startPublishedDate);
    const endDate = parseIsoDate(options.endPublishedDate);

    const baseResults = Array.isArray(base.results) ? base.results : [];

    let filteredResults = baseResults;
    if (startDate || endDate) {
      filteredResults = filteredResults.filter((result) => {
        const publishedDate = parseIsoDate(result.published);
        if (!publishedDate) return true;
        if (startDate && publishedDate < startDate) return false;
        if (endDate && publishedDate > endDate) return false;
        return true;
      });
    }

    filteredResults = filteredResults.slice(0, numResults).map((result, index) => ({
      ...result,
      rank: index + 1,
    }));

    return {
      query,
      type,
      livecrawl,
      category: options.category || null,
      context: buildContext(filteredResults, contextMaxCharacters),
      results: filteredResults,
      searchUrl: base.searchUrl,
      discoveredResults: base.discoveredResults,
      filtersApplied: {
        includeDomains: parseStringList(options.includeDomains)
          .map((value) => normalizeDomainFilter(value))
          .filter(Boolean),
        excludeDomains: parseStringList(options.excludeDomains)
          .map((value) => normalizeDomainFilter(value))
          .filter(Boolean),
        includeText: parseStringList(options.includeText),
        excludeText: parseStringList(options.excludeText),
        startPublishedDate: options.startPublishedDate || null,
        endPublishedDate: options.endPublishedDate || null,
      },
      durationMs: base.durationMs,
    };
  }

  async getCodeContext(query: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery) throw new Error("query is required");

    const tokensNum = clampInteger(options.tokensNum, 5000, { min: 1000, max: 50000 });
    const contextMaxCharacters = clampInteger(options.contextMaxCharacters, tokensNum * 4, {
      min: 4000,
      max: 200000,
    });

    const includeDomains = Array.from(
      new Set([
        ...parseStringList(options.includeDomains),
        "github.com",
        "stackoverflow.com",
        "developer.mozilla.org",
        "docs.python.org",
        "npmjs.com",
      ]),
    );

    let search = await this.webSearchAdvanced({
      query: normalizedQuery,
      numResults: clampInteger(options.numResults, 8, { min: 1, max: 12 }),
      type: normalizeEnum(options.type, ["auto", "fast", "neural"], "fast"),
      includeDomains,
      contextMaxCharacters,
      textMaxCharacters: clampInteger(options.textMaxCharacters, 5000, { min: 1000, max: 50000 }),
      livecrawl: normalizeEnum(options.livecrawl, ["never", "fallback", "always", "preferred"], "fallback"),
    });

    if (!Array.isArray(search.results) || search.results.length === 0) {
      search = (await this.webSearch(`${normalizedQuery} github stackoverflow documentation`, {
        numResults: clampInteger(options.numResults, 6, { min: 1, max: 12 }),
        type: "fast",
        livecrawl: normalizeEnum(options.livecrawl, ["fallback", "preferred"], "fallback"),
        contextMaxCharacters,
        textMaxCharacters: clampInteger(options.textMaxCharacters, 5000, { min: 1000, max: 50000 }),
      })) as WebSearchLikeResult;
    }

    return {
      query: normalizedQuery,
      tokensNum,
      response: search.context,
      results: search.results,
      durationMs: search.durationMs,
    };
  }

  async companyResearch(companyName: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const normalizedCompany = String(companyName || "").trim();
    if (!normalizedCompany) throw new Error("companyName is required");

    const numResults = clampInteger(options.numResults, 3, { min: 1, max: 10 });

    const contextMaxCharacters = clampInteger(options.contextMaxCharacters, 14000, {
      min: 4000,
      max: 200000,
    });

    let search = await this.webSearchAdvanced({
      query: `${normalizedCompany} company`,
      category: "company",
      numResults,
      type: normalizeEnum(options.type, ["auto", "fast", "neural"], "auto"),
      contextMaxCharacters,
      textMaxCharacters: clampInteger(options.textMaxCharacters, 7000, {
        min: 1000,
        max: 50000,
      }),
      livecrawl: normalizeEnum(options.livecrawl, ["never", "fallback", "always", "preferred"], "fallback"),
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      includeText: options.includeText,
      excludeText: options.excludeText,
    });

    if (!Array.isArray(search.results) || search.results.length === 0) {
      search = (await this.webSearch(`${normalizedCompany} official website products services latest news`, {
        numResults,
        type: "auto",
        livecrawl: "fallback",
        contextMaxCharacters,
        textMaxCharacters: clampInteger(options.textMaxCharacters, 7000, {
          min: 1000,
          max: 50000,
        }),
      })) as WebSearchLikeResult;
    }

    return {
      companyName: normalizedCompany,
      query: search.query,
      context: search.context,
      results: search.results,
      durationMs: search.durationMs,
    };
  }

  async findSimilar(url: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const normalizedUrl = normalizeUrl(url);
    const numResults = clampInteger(options.numResults, 5, { min: 1, max: 12 });

    const seedHost = getHostname(normalizedUrl);

    let seedContent: Record<string, unknown> | null = null;
    try {
      seedContent = (await this.fetchContent(normalizedUrl, {
        maxCharacters: clampInteger(options.seedMaxCharacters, 1200, { min: 500, max: 6000 }),
        noCache: toBool(options.noCache, false),
      })) as Record<string, unknown>;
    } catch {
      // best effort only
    }

    const seedTitle = String(seedContent?.title || seedHost || normalizedUrl);
    const keywordTerms = extractTopTerms(seedTitle, 4);
    const query = ["alternatives to", seedTitle, ...keywordTerms].join(" ").trim();

    const extraExcludeDomains = parseStringList(options.excludeDomains)
      .map((value) => normalizeDomainFilter(value))
      .filter(Boolean);

    const discovery = await this.discoverSearchResults(query, {
      numResults: Math.max(numResults * 2, numResults + 4),
      type: normalizeEnum(options.type, ["auto", "fast", "neural"], "auto"),
      includeDomains: options.includeDomains,
      excludeDomains: [seedHost, ...extraExcludeDomains],
      includeText: options.includeText,
      excludeText: options.excludeText,
      category: options.category,
    });

    const discoveryResults = Array.isArray(discovery.results) ? discovery.results : [];

    const similarResults = discoveryResults
      .filter((result) => !domainMatches(getHostname(result.url), [seedHost]))
      .slice(0, numResults)
      .map((result, index) => ({
        rank: index + 1,
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        domain: result.domain,
      }));

    const context = truncateText(
      similarResults
        .map((result) =>
          [
            `TITLE: ${result.title || result.url}`,
            `URL: ${result.url}`,
            result.snippet ? `SNIPPET: ${result.snippet}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n---\n\n"),
      clampInteger(options.contextMaxCharacters, 12000, {
        min: 2000,
        max: 200000,
      }),
    );

    return {
      url: normalizedUrl,
      query,
      results: similarResults,
      context,
      durationMs: Date.now() - startedAt,
    };
  }

  pruneExpiredUrlCache(): void {
    const now = Date.now();

    for (const [url, entry] of this.urlCache.entries()) {
      if (entry.expiresAt <= now || !this.documents.has(entry.documentId)) {
        this.urlCache.delete(url);
      }
    }
  }

  getCacheEntries(limit = 20): Array<Record<string, unknown>> {
    this.pruneExpiredUrlCache();

    const now = Date.now();
    const normalizedLimit = Math.max(1, Math.floor(limit || 20));

    const entries: Array<Record<string, unknown>> = [];

    for (const [url, entry] of this.urlCache.entries()) {
      const doc = this.documents.get(entry.documentId);
      if (!doc) continue;

      const fetchedAt = toFiniteNonNegativeNumber(doc.fetchedAt || now);
      const expiresAt = toFiniteNonNegativeNumber(entry.expiresAt || now);

      entries.push({
        url,
        finalUrl: String(doc.finalUrl || doc.url || url),
        title: String(doc.title || "").trim(),
        contentType: String(doc.contentType || "text/html"),
        documentId: entry.documentId,
        fetchedAt: new Date(fetchedAt || now).toISOString(),
        expiresAt: new Date(expiresAt || now).toISOString(),
        ageMs: Math.max(0, now - (fetchedAt || now)),
        ttlMs: Math.max(0, expiresAt - now),
        bytes: Buffer.byteLength(String(doc.html || ""), "utf8"),
      });
    }

    entries.sort((left, right) => Number(left.ttlMs || 0) - Number(right.ttlMs || 0));
    return entries.slice(0, normalizedLimit);
  }

  getTokenUsageSummary(): Record<string, unknown> {
    const queries = Math.max(1, this.metrics.queries);

    return {
      input: this.metrics.tokenInput,
      output: this.metrics.tokenOutput,
      cacheRead: this.metrics.tokenCacheRead,
      cacheWrite: this.metrics.tokenCacheWrite,
      total: this.metrics.tokenTotal,
      avgPerQuery: Math.round(this.metrics.tokenTotal / queries),
      cost: {
        input: this.metrics.costInput,
        output: this.metrics.costOutput,
        cacheRead: this.metrics.costCacheRead,
        cacheWrite: this.metrics.costCacheWrite,
        total: this.metrics.costTotal,
      },
    };
  }

  getHealth(options: { includeCacheEntries?: boolean; cacheEntriesLimit?: number } = {}): Record<string, unknown> {
    this.pruneExpiredUrlCache();

    const totalCacheLookups = this.metrics.cacheHits + this.metrics.cacheMisses;
    const cacheHitRate = totalCacheLookups > 0 ? this.metrics.cacheHits / totalCacheLookups : 0;

    const health: Record<string, unknown> = {
      model: this.model?.id || "uninitialized",
      llmApi: this.config.llmApi,
      llmBaseUrl: this.config.llmBaseUrl,
      searchEngine: this.config.searchEngine,
      searchEngineUrlTemplate: this.config.searchEngineUrlTemplate,
      cdpUrl: this.config.lightpandaCdpUrl,
      lightpandaAutoStart: this.config.lightpandaAutoStart,
      lightpandaManaged: this.lightpandaManaged,
      lightpandaManagedPid: this.lightpandaProcess?.pid || null,
      documentsCached: this.documents.size,
      urlCacheEntries: this.urlCache.size,
      deepResearchTasks: this.deepResearchTasks.size,
      researchMaxPages: this.config.researchMaxPages,
      researchMaxHops: this.config.researchMaxHops,
      researchSameDomainOnly: this.config.researchSameDomainOnly,
      browseLinkTimeoutMs: this.config.browseLinkTimeoutMs,
      queryTimeoutMs: this.config.queryTimeoutMs,
      cacheTtlMs: this.config.cacheTtlMs,
      maxHtmlChars: this.config.maxHtmlChars,
      maxMarkdownChars: this.config.maxMarkdownChars,
      operationConcurrency: this.config.operationConcurrency,
      browseConcurrency: this.config.browseConcurrency,
      operationSlotsActive: this.operationLimiter.active,
      operationSlotsPending: this.operationLimiter.pending,
      browseSlotsActive: this.browseLimiter.active,
      browseSlotsPending: this.browseLimiter.pending,
      toolExecutionMode: this.config.toolExecutionMode,
      queries: this.metrics.queries,
      activeQueries: this.metrics.activeQueries,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      cacheHitRate,
      queriesByType: { ...this.metrics.queriesByType },
      errorsByType: { ...this.metrics.errorsByType },
      durationSumByType: { ...this.metrics.durationSumByType },
      durationCountByType: { ...this.metrics.durationCountByType },
      tokens: this.getTokenUsageSummary(),
      uptimeSec: Math.floor((Date.now() - this.metrics.startedAt) / 1000),
    };

    if (options.includeCacheEntries) {
      health.cacheEntries = this.getCacheEntries(options.cacheEntriesLimit);
    }

    return health;
  }

  createTools(plan: ResearchPlan): AgentTool[] {
    const uniqueBrowsedUrls = new Set<string>();
    const successfulBrowseByUrl = new Map<string, Record<string, unknown>>();
    const failedUrls = new Set<string>();
    const hostFailures = new Map<string, number>();

    const browseTool: AgentTool = {
      name: "browse",
      label: "Browse",
      description:
        "Open a URL in Lightpanda and cache raw HTML internally. Returns a documentId. Pass that documentId to present(). This query has a fixed maximum page budget.",
      parameters: Type.Object({
        url: Type.String({ description: "Full URL to browse" }),
      }),
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const toolParams = params as Record<string, unknown>;
        const normalizedUrl = normalizeUrl(toolParams.url);
        const hostname = getHostname(normalizedUrl);

        if (plan.sameDomainOnly && !isHostAllowed(hostname, plan.seedHosts)) {
          throw new Error(`Blocked by same-domain policy. Allowed domains: ${Array.from(plan.seedHosts).join(", ")}`);
        }

        if (
          plan.policy?.includeDomains?.length &&
          !domainMatches(hostname, plan.policy.includeDomains) &&
          !isDiscoveryDomain(hostname)
        ) {
          throw new Error(
            `Blocked by includeDomains policy. Allowed domains: ${plan.policy.includeDomains.join(", ")}`,
          );
        }

        if (plan.policy?.excludeDomains?.length && domainMatches(hostname, plan.policy.excludeDomains)) {
          throw new Error(
            `Blocked by excludeDomains policy. Excluded domains: ${plan.policy.excludeDomains.join(", ")}`,
          );
        }

        const existing = successfulBrowseByUrl.get(normalizedUrl);
        if (existing) {
          const text = [
            `DOCUMENT_ID: ${String(existing.documentId || "")}`,
            `URL: ${String(existing.url || normalizedUrl)}`,
            `FINAL_URL: ${String(existing.finalUrl || existing.url || normalizedUrl)}`,
            `STATUS: ${String(existing.status || "")}`,
            `TITLE: ${String(existing.title || "")}`,
            `BYTES: ${String(existing.bytes || "")}`,
            "FROM_CACHE: true",
            "REUSED_IN_QUERY: true",
            `PAGES_USED: ${uniqueBrowsedUrls.size}/${plan.maxPages}`,
            "NOTE: URL already browsed in this query. Reusing existing documentId.",
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              ...existing,
              fromCache: true,
              reusedInQuery: true,
              pagesUsed: uniqueBrowsedUrls.size,
              maxPages: plan.maxPages,
            },
          };
        }

        if (failedUrls.has(normalizedUrl)) {
          throw new Error(`URL previously failed in this query and is skipped: ${normalizedUrl}`);
        }

        const hostFailureCount = hostFailures.get(hostname) || 0;
        if (hostFailureCount >= 2) {
          throw new Error(
            `Host failure circuit open for ${hostname} (failures=${hostFailureCount}). Skipping for this query.`,
          );
        }

        const isNewUrl = !uniqueBrowsedUrls.has(normalizedUrl);
        if (isNewUrl && uniqueBrowsedUrls.size >= plan.maxPages) {
          throw new Error(`Browse page budget exhausted (${plan.maxPages} pages).`);
        }

        let result: Record<string, unknown>;
        try {
          result = await this.browse(normalizedUrl, { abortSignal: signal });
        } catch (error) {
          failedUrls.add(normalizedUrl);
          hostFailures.set(hostname, hostFailureCount + 1);
          throw error;
        }

        uniqueBrowsedUrls.add(normalizedUrl);
        successfulBrowseByUrl.set(normalizedUrl, result);
        failedUrls.delete(normalizedUrl);
        hostFailures.set(hostname, 0);

        const text = [
          `DOCUMENT_ID: ${result.documentId}`,
          `URL: ${result.url}`,
          `FINAL_URL: ${result.finalUrl}`,
          `STATUS: ${result.status}`,
          `TITLE: ${String(result.title || "")}`,
          `BYTES: ${result.bytes}`,
          `FROM_CACHE: ${result.fromCache}`,
          `PAGES_USED: ${uniqueBrowsedUrls.size}/${plan.maxPages}`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            ...result,
            pagesUsed: uniqueBrowsedUrls.size,
            maxPages: plan.maxPages,
          },
        };
      },
    };

    const presentTool: AgentTool = {
      name: "present",
      label: "Present",
      description: "Extract clean markdown from a browsed document. Input is a documentId returned by browse().",
      parameters: Type.Object({
        documentId: Type.String({ description: "Document id returned from browse()" }),
        maxChars: Type.Optional(
          Type.Integer({
            description: "Maximum markdown characters to return",
            minimum: 1000,
            maximum: 200000,
          }),
        ),
      }),
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        throwIfAborted(signal, "present aborted");

        const toolParams = params as Record<string, unknown>;

        const requestedMaxChars =
          toolParams.maxChars === undefined
            ? undefined
            : clampInteger(toolParams.maxChars, this.config.maxMarkdownChars, {
                min: 1000,
                max: 200000,
              });

        const effectiveMaxChars = Math.max(
          requestedMaxChars ?? this.config.maxMarkdownChars,
          this.config.maxMarkdownChars,
        );

        const result = await this.present(String(toolParams.documentId || ""), effectiveMaxChars);
        const policy = plan.policy || {};

        const haystack = `${result.title}\n${result.content}`.toLowerCase();

        if (isChallengeLikeContent(result.title, result.content)) {
          const modeLabel = policy.mode ? `${policy.mode} mode` : "current mode";
          throw new Error(`Filtered challenge/interstitial page in ${modeLabel}.`);
        }

        if (policy.includeText?.length) {
          const missing = policy.includeText.filter((term) => !haystack.includes(term));
          if (missing.length > 0) {
            throw new Error(`Filtered by includeText policy. Missing terms: ${missing.join(", ")}`);
          }
        }

        if (policy.excludeText?.length) {
          const matched = policy.excludeText.filter((term) => haystack.includes(term));
          if (matched.length > 0) {
            throw new Error(`Filtered by excludeText policy. Matched terms: ${matched.join(", ")}`);
          }
        }

        const publishedDate = parseIsoDate(result.published);
        if (policy.startDate && publishedDate && publishedDate < policy.startDate) {
          throw new Error(`Filtered by startPublishedDate policy: ${policy.startPublishedDate}`);
        }
        if (policy.endDate && publishedDate && publishedDate > policy.endDate) {
          throw new Error(`Filtered by endPublishedDate policy: ${policy.endPublishedDate}`);
        }

        const text = [
          `TITLE: ${result.title}`,
          `URL: ${result.url}`,
          `AUTHOR: ${result.author}`,
          `PUBLISHED: ${result.published}`,
          `WORD_COUNT: ${result.wordCount}`,
          "",
          "CONTENT_MARKDOWN:",
          String(result.content || ""),
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: result,
        };
      },
    };

    return [browseTool, presentTool];
  }

  async enqueueOperation<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.operationLimiter.acquire(signal, "operation aborted before execution");

    try {
      throwIfAborted(signal, "operation aborted before execution");
      return await operation();
    } finally {
      release();
    }
  }

  async enqueueBrowse<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.browseLimiter.acquire(signal, "browse aborted before execution");

    try {
      throwIfAborted(signal, "browse aborted before execution");
      return await operation();
    } finally {
      release();
    }
  }

  async enqueueQuery(query: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const abortSignal = asAbortSignal(options.abortSignal);
    return await this.enqueueOperation(() => this.runQuery(query, options), abortSignal);
  }

  private deriveQueryType(options: Record<string, unknown>): string {
    const policy = options.researchPolicy as Record<string, unknown> | undefined;
    const mode = policy ? String(policy.mode || "").toLowerCase() : "";
    if (mode === "deep") return "deep_research";
    if (mode === "code" || mode === "company" || mode === "similar") return mode;
    return "search";
  }

  private recordOperationStart(opType: string, options: { countAsQuery?: boolean } = {}): void {
    if (options.countAsQuery !== false) {
      this.metrics.queries += 1;
      this.metrics.activeQueries += 1;
    }
    this.metrics.queriesByType[opType] = (this.metrics.queriesByType[opType] || 0) + 1;
  }

  private recordOperationEnd(
    opType: string,
    startedAt: number,
    failed: boolean,
    options: { countAsQuery?: boolean } = {},
  ): void {
    const durationMs = Date.now() - startedAt;
    this.metrics.durationSumByType[opType] = (this.metrics.durationSumByType[opType] || 0) + durationMs;
    this.metrics.durationCountByType[opType] = (this.metrics.durationCountByType[opType] || 0) + 1;
    if (failed) {
      this.metrics.errorsByType[opType] = (this.metrics.errorsByType[opType] || 0) + 1;
    }
    if (options.countAsQuery !== false) {
      this.metrics.activeQueries = Math.max(0, this.metrics.activeQueries - 1);
    }
  }

  async runQuery(query: string, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const externalAbortSignal = asAbortSignal(options.abortSignal);
    throwIfAborted(externalAbortSignal, "request aborted by client");

    await this.init();
    if (!this.model) {
      throw new Error("model failed to initialize");
    }

    const queryType = this.deriveQueryType(options);
    this.recordOperationStart(queryType);

    const startedAt = Date.now();
    let failed = false;

    try {
      const toolsUsed: Array<Record<string, unknown>> = [];
      const toolCallStarts = new Map<string, { startedAt: number; args: Record<string, unknown>; toolName: string }>();
      const toolProfiles: Array<Record<string, unknown>> = [];

      const turns: Array<Record<string, unknown>> = [];
      let currentTurnStart: number | null = null;
      let turnCounter = 0;

      const assistantMessages: Array<Record<string, unknown>> = [];
      let currentAssistantStart: number | null = null;
      let assistantCounter = 0;
      let firstAssistantTokenMs: number | null = null;

      const onProgress =
        typeof options.onProgress === "function"
          ? (options.onProgress as (payload: Record<string, unknown>) => void)
          : null;
      const emitProgress = (payload: Record<string, unknown>) => {
        if (!onProgress) return;
        try {
          onProgress({ ...payload, timestamp: Date.now() });
        } catch {
          // ignore progress sink errors
        }
      };

      const researchPlan = this.deriveResearchPlan(query, options);

      const queryTimeoutMs = clampInteger(options.queryTimeoutMs, this.config.queryTimeoutMs, {
        min: 1000,
        max: 30 * 60 * 1000,
      });

      const thinkingLevel = normalizeThinkingLevel(options.thinkingLevel, "off");
      const isDeep = researchPlan.policy.mode === "deep";

      emitProgress({
        type: "query_start",
        query,
        researchPlan: {
          maxPages: researchPlan.maxPages,
          maxHops: researchPlan.maxHops,
          sameDomainOnly: researchPlan.sameDomainOnly,
          seedUrls: researchPlan.seedUrls,
          policy: researchPlan.policy,
        },
        queryTimeoutMs,
        thinkingLevel,
      });

      const systemPrompt = this.buildSystemPrompt(researchPlan);

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model: this.model,
          thinkingLevel,
          tools: this.createTools(researchPlan),
          messages: [],
        },
        getApiKey: () => resolveRuntimeApiKey(normalizeLlmApi(this.config.llmApi), this.config.llmApiKey),
        toolExecution: this.config.toolExecutionMode,
      });

      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        if (event.type === "turn_start") {
          turnCounter += 1;
          currentTurnStart = Date.now();
          emitProgress({ type: "turn_start", turn: turnCounter });
        }

        if (event.type === "turn_end") {
          const endedAt = Date.now();
          const durationMs = currentTurnStart ? endedAt - currentTurnStart : null;
          const toolResultsCount = Array.isArray(event.toolResults) ? event.toolResults.length : 0;

          turns.push({
            turn: turnCounter,
            durationMs,
            toolResults: toolResultsCount,
          });

          emitProgress({
            type: "turn_end",
            turn: turnCounter,
            durationMs,
            toolResults: toolResultsCount,
          });

          currentTurnStart = null;
        }

        if (event.type === "message_start" && event.message?.role === "assistant") {
          assistantCounter += 1;
          currentAssistantStart = Date.now();
        }

        if (
          event.type === "message_update" &&
          event.message?.role === "assistant" &&
          event.assistantMessageEvent?.type === "text_delta"
        ) {
          if (firstAssistantTokenMs === null) {
            firstAssistantTokenMs = Date.now() - startedAt;
            emitProgress({ type: "first_token", latencyMs: firstAssistantTokenMs });
          }

          const delta = String(event.assistantMessageEvent.delta || "");
          if (delta) {
            emitProgress({
              type: "assistant_delta",
              turn: turnCounter,
              message: assistantCounter,
              delta,
            });
          }
        }

        if (event.type === "message_end" && event.message?.role === "assistant") {
          const endedAt = Date.now();
          const durationMs = currentAssistantStart ? endedAt - currentAssistantStart : null;
          assistantMessages.push({
            message: assistantCounter,
            durationMs,
          });
          currentAssistantStart = null;
        }

        if (event.type === "tool_execution_start") {
          toolCallStarts.set(event.toolCallId, {
            startedAt: Date.now(),
            args: event.args,
            toolName: event.toolName,
          });

          emitProgress({
            type: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          });
        }

        if (event.type === "tool_execution_end") {
          const start = toolCallStarts.get(event.toolCallId);
          const durationMs = start ? Date.now() - start.startedAt : null;
          const details = (event.result?.details ?? null) as Record<string, unknown> | null;
          const errorMessage = event.isError ? extractTextContent(event.result?.content) : "";
          toolCallStarts.delete(event.toolCallId);

          toolsUsed.push({
            toolName: event.toolName,
            isError: event.isError,
            durationMs,
            details,
            errorMessage,
          });

          const cacheFlag = details?.fromCache;
          const timingCache = (details?.timing as Record<string, unknown> | undefined)?.cache;

          const profileEntry = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            durationMs,
            url: details?.url || details?.finalUrl || start?.args?.url || null,
            documentId: details?.documentId || start?.args?.documentId || null,
            title: details?.title || null,
            cache: cacheFlag === true ? "hit" : cacheFlag === false ? "miss" : timingCache || "unknown",
            pagesUsed: typeof details?.pagesUsed === "number" ? details.pagesUsed : undefined,
            maxPages: typeof details?.maxPages === "number" ? details.maxPages : undefined,
            timing: details?.timing || null,
            errorMessage,
          };

          toolProfiles.push(profileEntry);

          emitProgress({
            type: "tool_end",
            ...profileEntry,
          });
        }
      });

      const rawFollowUpPrompts = options.followUpPrompts;
      const followUpPrompts = Array.isArray(rawFollowUpPrompts)
        ? rawFollowUpPrompts.map((value) => String(value || "").trim()).filter(Boolean)
        : typeof rawFollowUpPrompts === "string"
          ? [rawFollowUpPrompts.trim()].filter(Boolean)
          : [];

      let abortedByTimeout = false;
      let abortedByClient = false;

      const onClientAbort = () => {
        abortedByClient = true;
        agent.abort();
      };

      const awaitPromptWithAbort = async (promptPromise: Promise<void>): Promise<void> => {
        if (!externalAbortSignal) {
          await promptPromise;
          return;
        }

        throwIfAborted(externalAbortSignal, "request aborted by client");

        let onAbort: (() => void) | null = null;
        const abortPromise = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("request aborted by client"));
          externalAbortSignal.addEventListener("abort", onAbort, { once: true });
        });

        // If abort wins the race, promptPromise may reject later. Keep it handled.
        void promptPromise.catch(() => {});

        try {
          await Promise.race([promptPromise, abortPromise]);
        } finally {
          if (onAbort) {
            externalAbortSignal.removeEventListener("abort", onAbort);
          }
        }
      };

      if (externalAbortSignal) {
        externalAbortSignal.addEventListener("abort", onClientAbort, { once: true });
      }

      const timeout = setTimeout(() => {
        abortedByTimeout = true;
        agent.abort();
      }, queryTimeoutMs);

      try {
        throwIfAborted(externalAbortSignal, "request aborted by client");
        await awaitPromptWithAbort(agent.prompt(query));

        for (const followUpPrompt of followUpPrompts) {
          throwIfAborted(externalAbortSignal, "request aborted by client");
          await awaitPromptWithAbort(agent.prompt(followUpPrompt));
        }
      } finally {
        clearTimeout(timeout);
        if (externalAbortSignal) {
          externalAbortSignal.removeEventListener("abort", onClientAbort);
        }
        unsubscribe();
      }

      const assistantMessage = [...(agent.state.messages as unknown as Array<Record<string, unknown>>)]
        .reverse()
        .find((message) => message?.role === "assistant");

      if (!assistantMessage) {
        if (abortedByClient || externalAbortSignal?.aborted) {
          throw new Error("request aborted by client");
        }

        if (abortedByTimeout) {
          throw new Error(`query timed out after ${queryTimeoutMs}ms`);
        }

        throw new Error("model request failed: no assistant response returned");
      }

      const usageRecord =
        ((assistantMessage.usage as Record<string, unknown> | undefined) || ({} as Record<string, unknown>)) ?? {};
      const usageCostRecord =
        ((usageRecord.cost as Record<string, unknown> | undefined) || ({} as Record<string, unknown>)) ?? {};

      const usageSummary = {
        input: toFiniteNonNegativeNumber(usageRecord.input),
        output: toFiniteNonNegativeNumber(usageRecord.output),
        cacheRead: toFiniteNonNegativeNumber(usageRecord.cacheRead),
        cacheWrite: toFiniteNonNegativeNumber(usageRecord.cacheWrite),
        total: toFiniteNonNegativeNumber(usageRecord.totalTokens),
        cost: {
          input: toFiniteNonNegativeNumber(usageCostRecord.input),
          output: toFiniteNonNegativeNumber(usageCostRecord.output),
          cacheRead: toFiniteNonNegativeNumber(usageCostRecord.cacheRead),
          cacheWrite: toFiniteNonNegativeNumber(usageCostRecord.cacheWrite),
          total: toFiniteNonNegativeNumber(usageCostRecord.total),
        },
      };

      this.metrics.tokenInput += usageSummary.input;
      this.metrics.tokenOutput += usageSummary.output;
      this.metrics.tokenCacheRead += usageSummary.cacheRead;
      this.metrics.tokenCacheWrite += usageSummary.cacheWrite;
      this.metrics.tokenTotal += usageSummary.total;
      this.metrics.costInput += usageSummary.cost.input;
      this.metrics.costOutput += usageSummary.cost.output;
      this.metrics.costCacheRead += usageSummary.cost.cacheRead;
      this.metrics.costCacheWrite += usageSummary.cost.cacheWrite;
      this.metrics.costTotal += usageSummary.cost.total;

      const stopReason = String(assistantMessage.stopReason || "")
        .trim()
        .toLowerCase();
      const modelError = String(assistantMessage.errorMessage || "").trim();
      if (stopReason === "error" || stopReason === "aborted") {
        if (abortedByClient || externalAbortSignal?.aborted) {
          throw new Error("request aborted by client");
        }

        if (abortedByTimeout) {
          throw new Error(`query timed out after ${queryTimeoutMs}ms`);
        }

        throw new Error(modelError ? `model request failed: ${modelError}` : "model request failed");
      }

      const synthesizedAnswer = extractAssistantText(assistantMessage);
      if (!synthesizedAnswer.trim() && toolsUsed.length === 0) {
        const reason = modelError || stopReason || "empty assistant response and no tool activity";
        throw new Error(`model request failed: ${reason}`);
      }

      const findings = collectResultFindings(toolsUsed);

      if (!isDeep && toolsUsed.length === 0) {
        const assistantSnippet = synthesizedAnswer.replace(/\s+/g, " ").trim().slice(0, 180);
        const reason = modelError || assistantSnippet || stopReason || "assistant produced no tool calls";
        throw new Error(
          `model request failed: no tool calls executed (${reason}). Ensure model endpoint is reachable and supports tool calling.`,
        );
      }

      let answer: string;
      let citations: string[];
      let findingsForResult: Array<Record<string, unknown>>;

      if (isDeep) {
        answer = synthesizedAnswer;
        citations = collectResultCitations(answer, toolProfiles);
        findingsForResult = findings;
      } else {
        // Search mode: model selects URLs, code fills content from findings
        const explicitNone = isExplicitNoneCollateAnswer(synthesizedAnswer);
        const modelUrls = explicitNone ? [] : extractCitationUrls(synthesizedAnswer);

        let effectiveFindings: Array<Record<string, unknown>>;

        if (explicitNone) {
          effectiveFindings = [];
        } else if (modelUrls.length > 0) {
          const selectedKeys = new Set<string>();
          for (const url of modelUrls) {
            try {
              selectedKeys.add(normalizeUrlForDedupe(normalizeUrl(url)));
            } catch {
              // ignore malformed URL in model output
            }
          }
          effectiveFindings = findings
            .filter((finding) => {
              try {
                const key = normalizeUrlForDedupe(normalizeUrl(String(finding.url || "")));
                return selectedKeys.has(key);
              } catch {
                return false;
              }
            })
            .slice(0, 6);
        } else {
          // Fallback: model output had no URLs, use all findings
          effectiveFindings = findings.slice(0, 6);
        }

        if (!explicitNone && effectiveFindings.length === 0 && findings.length > 0) {
          // Model returned URLs we could not normalize/map; avoid empty output when evidence exists.
          effectiveFindings = findings.slice(0, 6);
        }

        answer = explicitNone ? "" : buildCollatedAnswer(effectiveFindings, toolsUsed);
        citations = normalizeUniqueUrls(effectiveFindings.map((finding) => String(finding.url || "")).filter(Boolean));
        findingsForResult = effectiveFindings;
      }

      const durationMs = Date.now() - startedAt;

      const byTool: Record<
        string,
        {
          count: number;
          errors: number;
          durationSumMs: number;
          durationAvgMs: number;
          cacheHits: number;
          cacheMisses: number;
        }
      > = {};

      for (const tool of toolProfiles) {
        const key = String(tool.toolName || "unknown");
        if (!byTool[key]) {
          byTool[key] = {
            count: 0,
            errors: 0,
            durationSumMs: 0,
            durationAvgMs: 0,
            cacheHits: 0,
            cacheMisses: 0,
          };
        }

        byTool[key].count += 1;
        if (tool.isError) byTool[key].errors += 1;
        if (typeof tool.durationMs === "number") {
          byTool[key].durationSumMs += tool.durationMs;
        }
        if (tool.cache === "hit") byTool[key].cacheHits += 1;
        if (tool.cache === "miss") byTool[key].cacheMisses += 1;
      }

      for (const key of Object.keys(byTool)) {
        byTool[key].durationAvgMs =
          byTool[key].count > 0 ? Number((byTool[key].durationSumMs / byTool[key].count).toFixed(2)) : 0;
      }

      const assistantDurationSumMs = assistantMessages.reduce(
        (sum, msg) => sum + (typeof msg.durationMs === "number" ? msg.durationMs : 0),
        0,
      );
      const toolDurationSumMs = toolProfiles.reduce(
        (sum, tool) => sum + (typeof tool.durationMs === "number" ? tool.durationMs : 0),
        0,
      );

      const profile = {
        totalMs: durationMs,
        firstAssistantTokenMs,
        turns,
        assistantMessages,
        tools: toolProfiles,
        summary: {
          turnCount: turns.length,
          assistantMessageCount: assistantMessages.length,
          toolCallCount: toolProfiles.length,
          toolErrorCount: toolProfiles.filter((tool) => tool.isError).length,
          followUpPromptCount: followUpPrompts.length,
          queryTimeoutMs,
          thinkingLevel,
          assistantDurationSumMs,
          toolDurationSumMs,
          note: "toolDurationSumMs may exceed totalMs because tool calls can run in parallel.",
        },
        byTool,
      };

      const result = {
        query,
        answer,
        findings: findingsForResult,
        citations,
        toolsUsed,
        usage: usageSummary,
        profile,
        researchPlan: {
          maxPages: researchPlan.maxPages,
          maxHops: researchPlan.maxHops,
          sameDomainOnly: researchPlan.sameDomainOnly,
          seedUrls: researchPlan.seedUrls,
          policy: researchPlan.policy,
        },
        durationMs,
        model: this.model?.id,
        createdAt: new Date().toISOString(),
      };

      emitProgress({
        type: "query_end",
        durationMs,
        citationsCount: citations.length,
        toolCalls: toolProfiles.length,
        toolErrors: profile.summary.toolErrorCount,
      });

      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.recordOperationEnd(queryType, startedAt, failed);
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }

    if (this.lightpandaProcess && this.config.lightpandaAutoStop) {
      this.log("stopping managed Lightpanda process");
      await new Promise<void>((resolve) => {
        const processHandle = this.lightpandaProcess;
        if (!processHandle) return resolve();

        const done = () => resolve();
        processHandle.once("exit", done);

        try {
          processHandle.kill("SIGTERM");
        } catch {
          processHandle.removeListener("exit", done);
          resolve();
        }

        setTimeout(() => {
          if (this.lightpandaProcess) {
            try {
              processHandle.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 800);
      });

      this.lightpandaProcess = null;
      this.lightpandaManaged = false;
    }
  }

  evictOldDeepResearchTasks(maxTasks = 100): void {
    evictOldDeepResearchTasks(this.deepResearchTasks, maxTasks);
  }

  composeDeepResearchReport(instructions: string, effort: string, searchResult: WebSearchLikeResult): string {
    return composeDeepResearchReport(instructions, resolveDeepEffort(effort), searchResult);
  }

  async deepResearchStart(
    instructions: string,
    options: Record<string, unknown> = {},
  ): Promise<DeepResearchStartResult> {
    const normalizedInstructions = String(instructions ?? "").trim();
    if (!normalizedInstructions) throw new Error("instructions is required");

    const effort = resolveDeepEffort(options.effort);

    const task = createDeepResearchTask(normalizedInstructions, effort);

    this.deepResearchTasks.set(task.researchId, task);
    this.evictOldDeepResearchTasks();

    void (async () => {
      const startedAt = Date.now();
      task.status = "running";
      task.startedAt = new Date().toISOString();

      try {
        const profile = getDeepEffortProfile(effort);
        const customInstruction = buildDeepCustomInstruction(effort, profile);
        const followUpPrompts = buildDeepFollowUpPrompts(effort, profile);

        const queryResult = await this.enqueueQuery(normalizedInstructions, {
          researchPolicy: {
            mode: "deep",
            type: "auto",
            livecrawl: "fallback",
            numResults: profile.numResults,
            maxHops: profile.maxHops,
            customInstruction,
          },
          thinkingLevel: profile.thinkingLevel,
          queryTimeoutMs: profile.queryTimeoutMs,
          followUpPrompts,
        });

        task.status = "completed";
        task.completedAt = new Date().toISOString();
        task.durationMs = Date.now() - startedAt;
        task.report = String(queryResult.answer || "No report generated");
        task.citations = Array.isArray(queryResult.citations)
          ? queryResult.citations.map((url) => String(url || "")).filter(Boolean)
          : [];
      } catch (error) {
        task.status = "failed";
        task.completedAt = new Date().toISOString();
        task.durationMs = Date.now() - startedAt;
        task.error = error instanceof Error ? error.message : String(error);
      }
    })();

    return {
      success: true,
      researchId: task.researchId,
      effort,
      status: "pending",
      message: `Research started. Call yagami deep check ${task.researchId}`,
    };
  }

  async deepResearchCheck(researchId: string): Promise<DeepResearchCheckResult> {
    const id = String(researchId ?? "").trim();
    if (!id) throw new Error("researchId is required");

    const task = this.deepResearchTasks.get(id);
    if (!task) {
      throw new Error(`Unknown researchId: ${id}`);
    }

    if (task.status === "completed") {
      return {
        success: true,
        status: "completed",
        report: task.report || "No report generated",
        citations: task.citations || [],
        costDollars: task.costDollars || 0,
        durationMs: task.durationMs || undefined,
        effort: task.effort,
      };
    }

    if (task.status === "running" || task.status === "pending") {
      return {
        status: task.status,
        message: "Research in progress. Call yagami deep check again with the same researchId.",
        effort: task.effort,
      };
    }

    return {
      success: false,
      status: "failed",
      error: task.error || "Research failed",
      effort: task.effort,
    };
  }
}

// TS-native engine module re-exports.
export { sanitizeUrlCandidate, normalizeUrl, normalizeUniqueUrls } from "./engine/url-utils.js";

export {
  clampInteger,
  normalizeEnum,
  normalizeCountryCode,
  getCompanyCountryProfile,
  toArray,
  parseStringList,
  parseUrlList,
  toBool,
  normalizeWhitespace,
  decodeHtmlEntities,
  stripHtml,
  normalizeDomainFilter,
  domainMatches,
  isDiscoveryDomain,
  isValidPublicHostname,
  parseIsoDate,
  isChallengeLikeContent,
  extractTopTerms,
  unwrapDuckDuckGoHref,
  isTrackingOrAdUrl,
  categoryProfile,
  truncateText,
  countWords,
  extractAssistantText,
  extractTextContent,
  buildContext,
  getHostname,
  isHostAllowed,
  extractSeedUrls,
  extractCitationUrls,
  normalizePotentialUrls,
} from "./engine/helpers.js";

export { normalizeResearchPolicy, deriveResearchPlan, buildSystemPrompt } from "./engine/policy.js";

export {
  resolveDeepEffort,
  getDeepEffortProfile,
  buildDeepCustomInstruction,
  buildDeepFollowUpPrompts,
  createDeepResearchTask,
  evictOldDeepResearchTasks,
  composeDeepResearchReport,
  extractDeepResearchCitations,
} from "./engine/deep-research.js";

export {
  URL_REGEX,
  DEEP_EFFORT_LEVELS,
  CODE_PREFERRED_DOMAINS,
  COMPANY_PREFERRED_DOMAINS,
  COMPANY_COUNTRY_ALIASES,
  COMPANY_COUNTRY_PROFILES,
} from "./engine/constants.js";
