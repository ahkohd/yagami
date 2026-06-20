import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { countWords, truncateText } from "./helpers.js";
import { normalizeUrl } from "./url-utils.js";

const execFileAsync = promisify(execFile);
const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";
const GITHUB_USER_AGENT = "Yagami/0.1 (+https://github.com/ahkohd/yagami)";

let ghCliAvailablePromise: Promise<boolean> | null = null;
let ghAuthAvailablePromise: Promise<boolean> | null = null;

interface GitHubRepoReference {
  owner: string;
  repo: string;
  repoUrl: string;
}

interface GitHubFileReference extends GitHubRepoReference {
  branch: string;
  path: string;
  fileUrl: string;
  rawUrl: string;
}

interface GitHubTreeReference extends GitHubRepoReference {
  branch: string;
  path: string;
  treeUrl: string;
}

type GitHubApiSource = "gh" | "http";

interface GitHubApiResponse {
  payload: unknown;
  source: GitHubApiSource;
  durationMs: number;
  status: number;
}

interface GitHubTextResponse {
  text: string;
  durationMs: number;
  status: number;
}

interface GitHubTimingAccumulator {
  ghMs: number;
  httpMs: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseInputUrl(input: string): URL | null {
  let normalizedInput: string;
  try {
    normalizedInput = normalizeUrl(input);
  } catch {
    return null;
  }

  try {
    return new URL(normalizedInput);
  } catch {
    return null;
  }
}

function isGitHubHtmlHost(hostname: string): boolean {
  const host = String(hostname || "")
    .trim()
    .toLowerCase();
  return host === "github.com" || host === "www.github.com";
}

function isGitHubRawHost(hostname: string): boolean {
  return (
    String(hostname || "")
      .trim()
      .toLowerCase() === "raw.githubusercontent.com"
  );
}

function stripGitSuffix(value: string): string {
  return String(value || "")
    .replace(/\.git$/i, "")
    .trim();
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodePath(value: string): string {
  return value.split("/").map(decodePathSegment).join("/");
}

function encodeEndpointComponent(value: string): string {
  return encodeURIComponent(decodePathSegment(value));
}

function buildRepoReference(owner: string, repo: string): GitHubRepoReference | null {
  const normalizedOwner = String(owner || "").trim();
  const normalizedRepo = stripGitSuffix(repo);
  if (!normalizedOwner || !normalizedRepo) return null;

  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    repoUrl: `https://github.com/${normalizedOwner}/${normalizedRepo}`,
  };
}

function parseGitHubRepoReference(input: string): GitHubRepoReference | null {
  const url = parseInputUrl(input);
  if (!url || !isGitHubHtmlHost(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;

  return buildRepoReference(parts[0] || "", parts[1] || "");
}

function parseGitHubFileReference(input: string): GitHubFileReference | null {
  const url = parseInputUrl(input);
  if (!url) return null;

  if (isGitHubHtmlHost(url.hostname)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 5 || parts[2] !== "blob") return null;

    const repoRef = buildRepoReference(parts[0] || "", parts[1] || "");
    const branch = String(parts[3] || "").trim();
    const path = parts.slice(4).join("/").trim();
    if (!repoRef || !branch || !path) return null;

    return {
      ...repoRef,
      branch,
      path,
      fileUrl: `https://github.com/${repoRef.owner}/${repoRef.repo}/blob/${branch}/${path}`,
      rawUrl: `${GITHUB_RAW_BASE_URL}/${repoRef.owner}/${repoRef.repo}/${branch}/${path}`,
    };
  }

  if (isGitHubRawHost(url.hostname)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;

    const repoRef = buildRepoReference(parts[0] || "", parts[1] || "");
    const branch = String(parts[2] || "").trim();
    const path = parts.slice(3).join("/").trim();
    if (!repoRef || !branch || !path) return null;

    return {
      ...repoRef,
      branch,
      path,
      fileUrl: `https://github.com/${repoRef.owner}/${repoRef.repo}/blob/${branch}/${path}`,
      rawUrl: `${GITHUB_RAW_BASE_URL}/${repoRef.owner}/${repoRef.repo}/${branch}/${path}`,
    };
  }

  return null;
}

function parseGitHubTreeReference(input: string): GitHubTreeReference | null {
  const url = parseInputUrl(input);
  if (!url || !isGitHubHtmlHost(url.hostname)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || parts[2] !== "tree") return null;

  const repoRef = buildRepoReference(parts[0] || "", parts[1] || "");
  const branch = String(parts[3] || "").trim();
  const path = parts.slice(4).join("/").trim();
  if (!repoRef || !branch) return null;

  return {
    ...repoRef,
    branch,
    path,
    treeUrl: `https://github.com/${repoRef.owner}/${repoRef.repo}/tree/${branch}${path ? `/${path}` : ""}`,
  };
}

function decodeBase64ToUtf8(rawValue: unknown): string {
  const encoded = String(rawValue ?? "")
    .replace(/\s+/g, "")
    .trim();

  if (!encoded) return "";

  try {
    return Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function getGitHubToken(): string {
  return String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
}

function buildGitHubHeaders(accept = "application/vnd.github+json"): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "user-agent": GITHUB_USER_AGENT,
  };

  const token = getGitHubToken();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return headers;
}

async function hasGhCli(): Promise<boolean> {
  if (!ghCliAvailablePromise) {
    ghCliAvailablePromise = execFileAsync("gh", ["--version"], {
      timeout: 2000,
      windowsHide: true,
    })
      .then(() => true)
      .catch(() => false);
  }

  return await ghCliAvailablePromise;
}

async function hasAuthenticatedGhCli(): Promise<boolean> {
  if (getGitHubToken()) return true;

  if (!ghAuthAvailablePromise) {
    ghAuthAvailablePromise = execFileAsync("gh", ["auth", "status"], {
      timeout: 2500,
      windowsHide: true,
    })
      .then(() => true)
      .catch(() => false);
  }

  return await ghAuthAvailablePromise;
}

async function canUseGhApi(): Promise<boolean> {
  if (!(await hasGhCli())) return false;
  return await hasAuthenticatedGhCli();
}

async function runGhApi(endpoint: string, timeoutMs = 12000): Promise<unknown> {
  const { stdout } = await execFileAsync("gh", ["api", endpoint], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  const raw = String(stdout || "").trim();
  if (!raw) return null;

  return JSON.parse(raw) as unknown;
}

async function fetchGitHubApi(endpoint: string, timeoutMs = 12000): Promise<GitHubApiResponse> {
  const apiPath = endpoint.replace(/^\/+/, "");
  const url = `${GITHUB_API_BASE_URL}/${apiPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: buildGitHubHeaders(),
      signal: controller.signal,
    });
    const raw = await response.text();
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const detail = raw.trim() ? `: ${raw.trim().slice(0, 240)}` : "";
      throw new Error(`GitHub API request failed (${response.status} ${response.statusText}) for ${url}${detail}`);
    }

    return {
      payload: raw.trim() ? (JSON.parse(raw) as unknown) : null,
      source: "http",
      durationMs,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runGitHubApi(endpoint: string, timeoutMs = 12000): Promise<GitHubApiResponse> {
  if (await canUseGhApi()) {
    const startedAt = Date.now();
    try {
      return {
        payload: await runGhApi(endpoint, timeoutMs),
        source: "gh",
        durationMs: Date.now() - startedAt,
        status: 200,
      };
    } catch {
      // Fall through to HTTP. Public repos must work without gh auth.
    }
  }

  return await fetchGitHubApi(endpoint, timeoutMs);
}

async function fetchGitHubRawText(url: string, timeoutMs = 12000): Promise<GitHubTextResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      headers: buildGitHubHeaders("text/plain, application/octet-stream;q=0.9, */*;q=0.8"),
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      throw new Error(`GitHub raw request failed (${response.status} ${response.statusText}) for ${url}`);
    }

    return {
      text,
      durationMs,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function recordGitHubApiTiming(response: GitHubApiResponse, timing: GitHubTimingAccumulator): void {
  if (response.source === "gh") {
    timing.ghMs += response.durationMs;
  } else {
    timing.httpMs += response.durationMs;
  }
}

function timingValue(value: number): number | null {
  return value > 0 ? value : null;
}

function baseRepoEndpoint(repoRef: GitHubRepoReference): string {
  return `repos/${encodeEndpointComponent(repoRef.owner)}/${encodeEndpointComponent(repoRef.repo)}`;
}

function topLevelEntryName(entry: unknown): string {
  const parsed = asObject(entry);
  if (!parsed) return "";

  const name = String(parsed.name || "").trim();
  if (!name) return "";

  const type = String(parsed.type || "").trim();
  if (type === "dir") return `${name}/`;
  if (type === "symlink") return `${name}@`;
  if (type === "submodule") return `${name} (submodule)`;
  return name;
}

async function fetchGitHubFileContent(
  fileRef: GitHubFileReference,
  requestedUrl: string,
  maxCharacters: number,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const response = await fetchGitHubRawText(fileRef.rawUrl);
  const displayPath = decodePath(fileRef.path);
  const rawContent = response.text.trimEnd();
  const content = truncateText(rawContent, maxCharacters, "YAGAMI_MAX_MARKDOWN_CHARS");
  const durationMs = Date.now() - startedAt;

  return {
    url: fileRef.rawUrl,
    requestedUrl,
    title: `${fileRef.owner}/${fileRef.repo}: ${displayPath}`,
    author: fileRef.owner,
    published: "Unknown",
    wordCount: countWords(content),
    content,
    truncated: content.length < rawContent.length,
    documentId: `gh-${randomUUID()}`,
    status: response.status,
    cache: {
      browse: "github-api",
      present: "github-api",
    },
    timing: {
      totalMs: durationMs,
      browseMs: null,
      presentMs: null,
      ghMs: null,
      httpMs: response.durationMs,
    },
  };
}

async function fetchGitHubTreeContent(
  treeRef: GitHubTreeReference,
  requestedUrl: string,
  maxCharacters: number,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const apiTiming: GitHubTimingAccumulator = { ghMs: 0, httpMs: 0 };
  const baseEndpoint = baseRepoEndpoint(treeRef);
  const treeResult = await runGitHubApi(
    `${baseEndpoint}/git/trees/${encodeEndpointComponent(treeRef.branch)}?recursive=1`,
  );
  recordGitHubApiTiming(treeResult, apiTiming);

  const treePayload = asObject(treeResult.payload);
  const entries = Array.isArray(treePayload?.tree) ? treePayload.tree : [];
  const filterPath = decodePath(treeRef.path).replace(/^\/+|\/+$/g, "");
  const treeLines = entries
    .map((entry) => {
      const parsed = asObject(entry);
      if (!parsed) return "";

      const rawPath = String(parsed.path || "").trim();
      if (!rawPath) return "";

      const displayPath = decodePath(rawPath);
      if (filterPath && displayPath !== filterPath && !displayPath.startsWith(`${filterPath}/`)) return "";

      const type = String(parsed.type || "").trim();
      const sizeRaw = Number(parsed.size || 0);
      const suffix = type === "tree" ? "/" : "";
      const size = type === "blob" && Number.isFinite(sizeRaw) && sizeRaw > 0 ? ` (${Math.trunc(sizeRaw)} bytes)` : "";
      return `- ${displayPath}${suffix}${size}`;
    })
    .filter(Boolean)
    .slice(0, 1000);

  const lines: string[] = [`# ${treeRef.owner}/${treeRef.repo} tree`];
  lines.push("", `Repository: ${treeRef.repoUrl}`);
  if (requestedUrl !== treeRef.treeUrl) {
    lines.push(`Requested URL: ${requestedUrl}`);
  }
  lines.push(`Branch: ${decodePathSegment(treeRef.branch)}`);
  if (filterPath) {
    lines.push(`Path: ${filterPath}`);
  }

  if (treeLines.length > 0) {
    lines.push("", "Files:", ...treeLines);
  } else {
    lines.push("", "Files: none found");
  }

  const rawContent = lines.join("\n").trim();
  const content = truncateText(rawContent, maxCharacters, "YAGAMI_MAX_MARKDOWN_CHARS");
  const durationMs = Date.now() - startedAt;

  return {
    url: treeRef.treeUrl,
    requestedUrl,
    title: `${treeRef.owner}/${treeRef.repo} tree`,
    author: treeRef.owner,
    published: "Unknown",
    wordCount: countWords(content),
    content,
    truncated: content.length < rawContent.length,
    documentId: `gh-${randomUUID()}`,
    status: treeResult.status,
    cache: {
      browse: "github-api",
      present: "github-api",
    },
    timing: {
      totalMs: durationMs,
      browseMs: null,
      presentMs: null,
      ghMs: timingValue(apiTiming.ghMs),
      httpMs: timingValue(apiTiming.httpMs),
    },
  };
}

async function fetchGitHubRepoContent(
  repoRef: GitHubRepoReference,
  requestedUrl: string,
  maxCharacters: number,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const apiTiming: GitHubTimingAccumulator = { ghMs: 0, httpMs: 0 };
  const baseEndpoint = baseRepoEndpoint(repoRef);

  const repoResult = await runGitHubApi(baseEndpoint);
  recordGitHubApiTiming(repoResult, apiTiming);

  const repoPayload = asObject(repoResult.payload);
  if (!repoPayload) {
    throw new Error(`GitHub API returned empty repo payload for ${repoRef.owner}/${repoRef.repo}`);
  }

  const repoUrl = String(repoPayload.html_url || repoRef.repoUrl).trim() || repoRef.repoUrl;
  const repoName = String(repoPayload.full_name || `${repoRef.owner}/${repoRef.repo}`).trim();
  const description = String(repoPayload.description || "").trim();
  const defaultBranch = String(repoPayload.default_branch || "").trim();
  const language = String(repoPayload.language || "").trim();
  const homepage = String(repoPayload.homepage || "").trim();
  const pushedAt = String(repoPayload.pushed_at || "").trim();
  const updatedAt = String(repoPayload.updated_at || "").trim();
  const starsRaw = Number(repoPayload.stargazers_count || 0);
  const forksRaw = Number(repoPayload.forks_count || 0);
  const openIssuesRaw = Number(repoPayload.open_issues_count || 0);
  const stars = Number.isFinite(starsRaw) ? Math.max(0, Math.trunc(starsRaw)) : 0;
  const forks = Number.isFinite(forksRaw) ? Math.max(0, Math.trunc(forksRaw)) : 0;
  const openIssues = Number.isFinite(openIssuesRaw) ? Math.max(0, Math.trunc(openIssuesRaw)) : 0;

  const licensePayload = asObject(repoPayload.license);
  const license = String(licensePayload?.spdx_id || licensePayload?.name || "").trim();

  const topics = Array.isArray(repoPayload.topics)
    ? repoPayload.topics
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  let readmeName = "";
  let readmeContent = "";
  try {
    const readmeResult = await runGitHubApi(`${baseEndpoint}/readme`);
    recordGitHubApiTiming(readmeResult, apiTiming);
    const readmePayload = asObject(readmeResult.payload);
    if (readmePayload) {
      readmeName = String(readmePayload.name || "README").trim() || "README";
      readmeContent = decodeBase64ToUtf8(readmePayload.content).trim();
    }
  } catch {
    // README can be missing; continue with metadata-only output.
  }

  let topLevelEntries: string[] = [];
  try {
    const contentsResult = await runGitHubApi(`${baseEndpoint}/contents`);
    recordGitHubApiTiming(contentsResult, apiTiming);
    if (Array.isArray(contentsResult.payload)) {
      topLevelEntries = contentsResult.payload.map(topLevelEntryName).filter(Boolean).slice(0, 30);
    }
  } catch {
    // Top-level listing is optional.
  }

  const lines: string[] = [`# ${repoName}`];
  if (description) {
    lines.push("", description);
  }

  lines.push("", `Repository: ${repoUrl}`);
  if (requestedUrl !== repoUrl) {
    lines.push(`Requested URL: ${requestedUrl}`);
  }

  if (defaultBranch) {
    lines.push(`Default branch: ${defaultBranch}`);
  }

  lines.push(`Stars: ${stars}`);
  lines.push(`Forks: ${forks}`);
  lines.push(`Open issues: ${openIssues}`);

  if (language) {
    lines.push(`Primary language: ${language}`);
  }
  if (license) {
    lines.push(`License: ${license}`);
  }
  if (homepage) {
    lines.push(`Homepage: ${homepage}`);
  }
  if (updatedAt) {
    lines.push(`Updated at: ${updatedAt}`);
  }
  if (pushedAt) {
    lines.push(`Pushed at: ${pushedAt}`);
  }
  if (topics.length > 0) {
    lines.push(`Topics: ${topics.join(", ")}`);
  }

  if (topLevelEntries.length > 0) {
    lines.push("", "Top-level files:");
    lines.push(...topLevelEntries.map((entry) => `- ${entry}`));
  }

  if (readmeContent) {
    lines.push("", `## ${readmeName || "README"}`, "", readmeContent);
  }

  const rawContent = lines.join("\n").trim();
  const content = truncateText(rawContent, maxCharacters, "YAGAMI_MAX_MARKDOWN_CHARS");
  const truncated = content.length < rawContent.length;
  const durationMs = Date.now() - startedAt;

  return {
    url: repoUrl,
    requestedUrl,
    title: repoName,
    author: repoRef.owner,
    published: pushedAt || updatedAt || "Unknown",
    wordCount: countWords(content),
    content,
    truncated,
    documentId: `gh-${randomUUID()}`,
    status: repoResult.status,
    cache: {
      browse: "github-api",
      present: "github-api",
    },
    timing: {
      totalMs: durationMs,
      browseMs: null,
      presentMs: null,
      ghMs: timingValue(apiTiming.ghMs),
      httpMs: timingValue(apiTiming.httpMs),
    },
  };
}

export async function tryFetchGitHubRepoContent(
  requestedUrl: string,
  maxCharacters: number,
  options: { log?: (message: string) => void } = {},
): Promise<Record<string, unknown> | null> {
  const fileRef = parseGitHubFileReference(requestedUrl);
  const treeRef = fileRef ? null : parseGitHubTreeReference(requestedUrl);
  const repoRef = fileRef || treeRef || parseGitHubRepoReference(requestedUrl);
  if (!repoRef) return null;

  try {
    if (fileRef) {
      return await fetchGitHubFileContent(fileRef, requestedUrl, maxCharacters);
    }

    if (treeRef) {
      return await fetchGitHubTreeContent(treeRef, requestedUrl, maxCharacters);
    }

    return await fetchGitHubRepoContent(repoRef, requestedUrl, maxCharacters);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log?.(
      `GitHub fetch failed for ${repoRef.owner}/${repoRef.repo}; falling back to browser fetch (${message.slice(0, 220)})`,
    );
    return null;
  }
}
