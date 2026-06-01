import { db } from "../db/schema";

export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
  error?: { message?: string };
};

export const settingValue = (key: string, envKey: string, fallback = "") => {
  const dbValue = (db.query<{ value: string }, [string]>(`SELECT value FROM config WHERE key = ?`).get(key)?.value || "").trim();
  if (dbValue) return dbValue;
  const envValue = (process.env[envKey] || "").trim();
  if (envValue) return envValue;
  return fallback;
};

export const parseFallbackModels = (raw: string): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(/[\r\n,]+/)) {
    const m = piece.trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
};

export const buildModelChain = (primary: string, fallbackRaw: string): string[] => {
  const fallbacks = parseFallbackModels(fallbackRaw);
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (m: string) => {
    const v = m.trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    chain.push(v);
  };
  push(primary);
  for (const f of fallbacks) push(f);
  return chain;
};

export const llmConfig = () => {
  const primary = settingValue("llm_model", "LLM_MODEL", "gpt-4o-mini");
  const fallbackRaw = settingValue("llm_fallback_models", "LLM_FALLBACK_MODELS", "");
  const models = buildModelChain(primary, fallbackRaw);
  return {
    baseUrl: settingValue("llm_base_url", "LLM_BASE_URL", "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: settingValue("llm_api_key", "LLM_API_KEY", ""),
    model: models[0] || primary,
    models,
    temperature: Number.parseFloat(settingValue("llm_temperature", "LLM_TEMPERATURE", "0.7")),
    maxWords: Number.parseInt(settingValue("llm_description_max_words", "LLM_DESCRIPTION_MAX_WORDS", "45"), 10),
  };
};

export const trimToWordLimit = (value: string, maxWords: number) => {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!Number.isFinite(maxWords) || maxWords < 10 || words.length <= maxWords) return value.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[,.!?;:]+$/, "")}...`;
};

export const parseLlmContent = (rawPayload: string) => {
  if (rawPayload.trimStart().startsWith("data:")) {
    return rawPayload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]")
      .map((line) => {
        try {
          const payload = JSON.parse(line) as ChatCompletionResponse;
          return payload.choices?.map((choice) => choice.delta?.content || choice.message?.content || "").join("") || "";
        } catch {
          return "";
        }
      })
      .join("")
      .trim();
  }
  try {
    const payload = JSON.parse(rawPayload) as ChatCompletionResponse;
    return payload.choices?.map((choice) => choice.message?.content || choice.delta?.content || "").join("").trim() || "";
  } catch {
    return "";
  }
};

export const parseLlmError = (rawPayload: string) => {
  try {
    const payload = JSON.parse(rawPayload) as ChatCompletionResponse;
    return payload.error?.message || "";
  } catch {
    return "";
  }
};

export const unwrapProviderError = (rawPayload: string): string => {
  let text = rawPayload.trim();
  for (let i = 0; i < 4; i++) {
    let obj: unknown;
    try { obj = JSON.parse(text); }
    catch { return text.slice(0, 240); }
    const message = (obj as { error?: { message?: unknown }; message?: unknown })?.error?.message
      ?? (obj as { message?: unknown })?.message;
    if (typeof message !== "string" || !message) return text.slice(0, 240);
    const candidate = message.trim();
    if (candidate.startsWith("{") || candidate.startsWith("[")) {
      text = candidate;
      continue;
    }
    return candidate;
  }
  return text.slice(0, 240);
};
