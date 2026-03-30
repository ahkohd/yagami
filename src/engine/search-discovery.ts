import {
  categoryProfile,
  clampInteger,
  domainMatches,
  getHostname,
  isTrackingOrAdUrl,
  isValidPublicHostname,
  normalizeDomainFilter,
  normalizeWhitespace,
  parseStringList,
  stripHtml,
  unwrapDuckDuckGoHref,
} from "./helpers.js";
import { normalizeUrl } from "./url-utils.js";
import type { SearchEnginePreset } from "../types/config.js";
import { tavily } from "@tavily/core";

const SEARCH_ENGINE_PRESETS: Readonly<Record<Exclude<SearchEnginePreset, "custom" | "tavily">, string>> = {
  duckduckgo: "https://duckduckgo.com/html/?q={query}",
  bing: "https://www.bing.com/search?q={query}",
  google: "https://www.google.com/search?q={query}",
  brave: "https://search.brave.com/search?q={query}",
};

function normalizeSearchEngine(value: unknown, fallback: SearchEnginePreset = "duckduckgo"): SearchEnginePreset {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "duckduckgo") return "duckduckgo";
  if (normalized === "bing") return "bing";
  if (normalized === "google") return "google";
  if (normalized === "brave") return "brave";
  if (normalized === "tavily") return "tavily";
  if (normalized === "custom") return "custom";

  return fallback;
}

export function resolveSearchEngineTemplate(
  engine: SearchEnginePreset,
  customTemplate: unknown,
): { engine: SearchEnginePreset; template: string } {
  const normalizedTemplate = String(customTemplate ?? "").trim();

  if (normalizedTemplate) {
    return {
      engine: "custom",
      template: normalizedTemplate,
    };
  }

  if (engine === "tavily") {
    return {
      engine: "tavily",
      template: "",
    };
  }

  if (engine !== "custom") {
    return {
      engine,
      template: SEARCH_ENGINE_PRESETS[engine],
    };
  }

  return {
    engine: "duckduckgo",
    template: SEARCH_ENGINE_PRESETS.duckduckgo,
  };
}

function buildSearchUrlFromTemplate(template: string, query: string): string {
  const encodedQuery = encodeURIComponent(query);

  if (template.includes("{query}")) {
    return template.replace(/\{query\}/g, encodedQuery);
  }

  if (template.includes("%s")) {
    return template.replace(/%s/g, encodedQuery);
  }

  try {
    const url = new URL(template);
    url.searchParams.set("q", query);
    return url.toString();
  } catch {
    return `${template}${encodedQuery}`;
  }
}

export async function parseDuckDuckGoResults(
  html: string,
  options: { limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const limit = options.limit ?? 40;
  const { parseHTML } = (await import("linkedom")) as unknown as {
    parseHTML: (raw: string) => { document: unknown };
  };

  const { document } = parseHTML(html || "") as { document: Record<string, unknown> };

  const results: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const resultNodes = Array.from(
    ((document.querySelectorAll as (selector: string) => unknown[])?.call(document, ".result") || []) as unknown[],
  ) as Array<Record<string, unknown>>;

  for (const node of resultNodes) {
    const querySelector = node.querySelector as ((selector: string) => Record<string, unknown> | null) | undefined;
    if (!querySelector) continue;

    const link =
      querySelector.call(node, "a.result__a") ||
      querySelector.call(node, "h2 a") ||
      querySelector.call(node, "a[href]");

    if (!link) continue;

    const getAttribute = link.getAttribute as ((name: string) => string | null) | undefined;
    const href = unwrapDuckDuckGoHref((getAttribute?.call(link, "href") || "") as string);
    let normalized: string;
    try {
      normalized = normalizeUrl(href);
    } catch {
      continue;
    }

    const hostname = getHostname(normalized);
    if (!isValidPublicHostname(hostname)) continue;
    if (isTrackingOrAdUrl(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const textContent = link.textContent as string | undefined;
    const innerHTML = link.innerHTML as string | undefined;
    const title = normalizeWhitespace(textContent || stripHtml(innerHTML || ""));

    const snippetNode =
      querySelector.call(node, ".result__snippet") ||
      querySelector.call(node, ".result-snippet") ||
      querySelector.call(node, ".result__extras");
    const snippet = normalizeWhitespace(String(snippetNode?.textContent || ""));

    results.push({
      rank: results.length + 1,
      url: normalized,
      title,
      snippet,
      domain: hostname,
    });

    if (results.length >= limit) break;
  }

  if (results.length > 0) {
    return results;
  }

  const fallback: Array<Record<string, unknown>> = [];
  const seenFallback = new Set<string>();
  const regex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  const htmlInput = html || "";
  let match: RegExpExecArray | null = regex.exec(htmlInput);
  while (match !== null) {
    const href = unwrapDuckDuckGoHref(match[1]);
    let normalized: string;
    try {
      normalized = normalizeUrl(href);
    } catch {
      match = regex.exec(htmlInput);
      continue;
    }

    const hostname = getHostname(normalized);
    if (!isValidPublicHostname(hostname)) {
      match = regex.exec(htmlInput);
      continue;
    }
    if (isTrackingOrAdUrl(normalized)) {
      match = regex.exec(htmlInput);
      continue;
    }
    if (seenFallback.has(normalized)) {
      match = regex.exec(htmlInput);
      continue;
    }
    seenFallback.add(normalized);

    const title = stripHtml(match[2]);
    if (!title) {
      match = regex.exec(htmlInput);
      continue;
    }

    fallback.push({
      rank: fallback.length + 1,
      url: normalized,
      title,
      snippet: "",
      domain: hostname,
    });

    if (fallback.length >= limit) break;
    match = regex.exec(htmlInput);
  }

  return fallback;
}

async function tavilySearch(
  query: string,
  options: {
    apiKey: string;
    maxResults: number;
    includeDomains?: string[];
    excludeDomains?: string[];
  },
): Promise<Array<Record<string, unknown>>> {
  const client = tavily({ apiKey: options.apiKey });
  const response = await client.search(query, {
    maxResults: Math.min(options.maxResults, 20),
    searchDepth: "basic",
    ...(options.includeDomains && options.includeDomains.length > 0
      ? { includeDomains: options.includeDomains }
      : {}),
    ...(options.excludeDomains && options.excludeDomains.length > 0
      ? { excludeDomains: options.excludeDomains }
      : {}),
  });

  return (response.results || []).map(
    (result: { url?: string; title?: string; content?: string }, index: number) => {
      const url = String(result.url || "");
      const hostname = getHostname(url);
      return {
        rank: index + 1,
        url,
        title: String(result.title || ""),
        snippet: String(result.content || ""),
        domain: hostname,
      };
    },
  );
}

export async function discoverSearchResults(
  query: string,
  options: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();

  const numResults = clampInteger(options.numResults, 12, { min: 1, max: 100 });
  const category = String(options.category || "")
    .trim()
    .toLowerCase();

  const includeDomains = parseStringList(options.includeDomains)
    .map((value) => normalizeDomainFilter(value))
    .filter(Boolean);
  const excludeDomains = parseStringList(options.excludeDomains)
    .map((value) => normalizeDomainFilter(value))
    .filter(Boolean);

  const includeText = parseStringList(options.includeText).map((value) => value.toLowerCase());
  const excludeText = parseStringList(options.excludeText).map((value) => value.toLowerCase());

  const profile = categoryProfile(category);

  const mergedIncludeDomains = Array.from(
    new Set([...includeDomains, ...profile.includeDomains.map((value) => normalizeDomainFilter(value))]),
  ).filter(Boolean);

  const mergedIncludeText = Array.from(
    new Set([...includeText, ...profile.includeText.map((value) => value.toLowerCase())]),
  ).filter(Boolean);

  const queryHint = String(profile.queryHint || "").trim();
  const effectiveQuery = queryHint ? `${query} ${queryHint}` : query;

  const requestedEngine = normalizeSearchEngine(options.searchEngine, "duckduckgo");

  if (requestedEngine === "tavily") {
    const tavilyApiKey = String(options.tavilyApiKey || "").trim();
    if (!tavilyApiKey) {
      throw new Error("TAVILY_API_KEY is required when searchEngine is set to 'tavily'.");
    }

    let results = await tavilySearch(effectiveQuery, {
      apiKey: tavilyApiKey,
      maxResults: Math.max(numResults * 2, 20),
      includeDomains: mergedIncludeDomains.length > 0 ? mergedIncludeDomains : undefined,
      excludeDomains: excludeDomains.length > 0 ? excludeDomains : undefined,
    });

    if (category === "pdf") {
      results = results.filter((result) =>
        String(result.url || "")
          .toLowerCase()
          .includes(".pdf"),
      );
    }

    if (mergedIncludeText.length > 0) {
      results = results.filter((result) => {
        const haystack = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
        return mergedIncludeText.every((term) => haystack.includes(term));
      });
    }

    if (excludeText.length > 0) {
      results = results.filter((result) => {
        const haystack = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
        return excludeText.every((term) => !haystack.includes(term));
      });
    }

    results = results.slice(0, numResults).map((result, index) => ({ ...result, rank: index + 1 }));

    return {
      query,
      effectiveQuery,
      category: category || null,
      searchEngine: "tavily",
      searchEngineRequested: "tavily",
      searchUrlTemplate: null,
      searchUrl: null,
      results,
      durationMs: Date.now() - startedAt,
      filters: {
        includeDomains: mergedIncludeDomains,
        excludeDomains,
        includeText: mergedIncludeText,
        excludeText,
      },
    };
  }
  const requestedSearch = resolveSearchEngineTemplate(requestedEngine, options.searchEngineUrlTemplate);
  const fallbackSearch =
    requestedSearch.engine === "duckduckgo"
      ? null
      : {
          engine: "duckduckgo" as const,
          template: SEARCH_ENGINE_PRESETS.duckduckgo,
        };

  const attempts = fallbackSearch ? [requestedSearch, fallbackSearch] : [requestedSearch];

  let activeSearch = requestedSearch;
  let searchUrl = "";
  let results: Array<Record<string, unknown>> = [];
  let lastError: unknown = null;

  for (const attempt of attempts) {
    const candidateSearchUrl = buildSearchUrlFromTemplate(attempt.template, effectiveQuery);

    try {
      const response = await fetch(candidateSearchUrl, {
        method: "GET",
        headers: {
          "user-agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "accept-language": "en-US,en;q=0.9",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Search discovery failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
      }

      const html = await response.text();
      const parsedResults = await parseDuckDuckGoResults(html, { limit: Math.max(numResults * 4, 24) });
      const minAcceptableResults = Math.max(1, Math.min(2, numResults));

      if (parsedResults.length < minAcceptableResults && attempt.engine !== "duckduckgo" && fallbackSearch) {
        continue;
      }

      activeSearch = attempt;
      searchUrl = candidateSearchUrl;
      results = parsedResults;
      break;
    } catch (error) {
      lastError = error;

      if (attempt.engine !== "duckduckgo" && fallbackSearch) {
        continue;
      }

      throw error;
    }
  }

  if (!searchUrl) {
    if (lastError instanceof Error) throw lastError;
    if (lastError !== null && lastError !== undefined) throw new Error(String(lastError));
    throw new Error("Search discovery failed: no search URL could be resolved.");
  }

  if (category === "pdf") {
    results = results.filter((result) =>
      String(result.url || "")
        .toLowerCase()
        .includes(".pdf"),
    );
  }

  if (mergedIncludeDomains.length > 0) {
    results = results.filter((result) => domainMatches(String(result.domain || ""), mergedIncludeDomains));
  }

  if (excludeDomains.length > 0) {
    results = results.filter((result) => !domainMatches(String(result.domain || ""), excludeDomains));
  }

  if (mergedIncludeText.length > 0) {
    results = results.filter((result) => {
      const haystack = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
      return mergedIncludeText.every((term) => haystack.includes(term));
    });
  }

  if (excludeText.length > 0) {
    results = results.filter((result) => {
      const haystack = `${result.title || ""} ${result.snippet || ""} ${result.url || ""}`.toLowerCase();
      return excludeText.every((term) => !haystack.includes(term));
    });
  }

  results = results.slice(0, numResults).map((result, index) => ({ ...result, rank: index + 1 }));

  return {
    query,
    effectiveQuery,
    category: category || null,
    searchEngine: activeSearch.engine,
    searchEngineRequested: requestedSearch.engine,
    searchUrlTemplate: activeSearch.template,
    searchUrl,
    results,
    durationMs: Date.now() - startedAt,
    filters: {
      includeDomains: mergedIncludeDomains,
      excludeDomains,
      includeText: mergedIncludeText,
      excludeText,
    },
  };
}
