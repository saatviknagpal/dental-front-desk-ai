// Runtime configuration from environment variables (.env / .env.local).
// Read lazily so tests and evals can override process.env before use.

import { currentPractice } from "./practice";

export type ProviderName = "openai" | "gemini" | "deepseek" | "anthropic" | "custom";

const PROVIDER_DEFAULTS: Record<ProviderName, { baseURL: string; model: string }> = {
  openai: { baseURL: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  gemini: { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.6-flash" },
  deepseek: { baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
  anthropic: { baseURL: "", model: "claude-sonnet-5-5" },
  custom: { baseURL: "", model: "" },
};

export function llmConfig(override?: ProviderName) {
  const main = (process.env.LLM_PROVIDER || "openai").trim().toLowerCase() as ProviderName;
  const provider = override ?? main;
  const isMain = provider === main;
  const defaults = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.custom;
  return {
    provider,
    apiKey: (process.env[`${provider.toUpperCase()}_API_KEY`] || (isMain ? process.env.LLM_API_KEY : "") || "").trim(),
    model: (isMain && process.env.LLM_MODEL?.trim()) || defaults.model,
    fallbackModel: isMain ? (process.env.LLM_FALLBACK_MODEL || "").trim() : "",
    baseURL: (isMain && process.env.LLM_BASE_URL?.trim()) || defaults.baseURL,
  };
}

export function practiceTimezone(): string {
  return currentPractice().timezone;
}

export function staffWebhookUrl(practiceSlug: string): string {
  try {
    const own = JSON.parse(process.env.STAFF_WEBHOOKS || "{}")[practiceSlug];
    if (typeof own === "string" && own.trim()) return own.trim();
  } catch {
  }
  return (process.env.STAFF_WEBHOOK_URL || "").trim();
}

export function appUrl(): string {
  return (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
}

export function demoResetAllowed(): boolean {
  return (process.env.ALLOW_DEMO_RESET || "true").toLowerCase() === "true";
}
