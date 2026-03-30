export type ThemeName = "ansi" | "none";

export type ThemeTokenName = "domain" | "title" | "duration" | "error" | "dim" | "cyan" | "bold";

export type ToolExecutionMode = "sequential" | "parallel";

export type LlmApi = "openai-completions" | "anthropic-messages";

export type SearchEnginePreset = "duckduckgo" | "bing" | "google" | "brave" | "tavily" | "custom";

export interface RuntimeConfig {
  runtimeDir: string;
  configFile: string;
  host: string;
  port: number;
  daemonUrl: string;

  pidFile: string;
  logFile: string;

  llmApi: LlmApi;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;

  searchEngine: SearchEnginePreset;
  searchEngineUrlTemplate: string;
  tavilyApiKey: string;

  lightpandaCdpUrl: string;
  lightpandaHost: string;
  lightpandaPort: number;
  lightpandaAutoStart: boolean;
  lightpandaAutoStop: boolean;

  browseLinkTimeoutMs: number;
  queryTimeoutMs: number;

  cacheTtlMs: number;
  maxHtmlChars: number;
  maxMarkdownChars: number;
  maxDocuments: number;

  operationConcurrency: number;
  browseConcurrency: number;

  researchMaxPages: number;
  researchMaxHops: number;
  researchSameDomainOnly: boolean;

  toolExecutionMode: ToolExecutionMode;
  theme: ThemeName;
  themeTokens: Record<string, string>;
}
