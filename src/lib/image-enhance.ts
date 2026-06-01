import { settingValue, buildModelChain, parseLlmError, unwrapProviderError } from "./llm";
import { imageExtensionFromMime, saveImageBuffer, extractImageCandidate, persistImageReference, resolveImageBytes } from "./images";
import { getConfig } from "../db/schema";

export type ImageEnhanceResult = {
  imageUrl: string;
  prompt: string;
};

export const imageEnhanceConfig = () => {
  const dbOrEnv = (key: string, envKey1: string, envKey2 = "") =>
    settingValue(key, envKey1, "") || (envKey2 ? (process.env[envKey2] || "").trim() : "");
  const primaryModel = dbOrEnv("image_model", "QWEN_IMAGE_MODEL", "IMAGE_ENHANCE_MODEL");
  const fallbackRaw = dbOrEnv("image_fallback_models", "QWEN_IMAGE_FALLBACK_MODELS", "IMAGE_ENHANCE_FALLBACK_MODELS");
  const models = buildModelChain(primaryModel, fallbackRaw);
  return {
    baseUrl: dbOrEnv("image_base_url", "QWEN_IMAGE_BASE_URL", "IMAGE_ENHANCE_BASE_URL"),
    endpoint: dbOrEnv("image_endpoint", "QWEN_IMAGE_ENDPOINT", "IMAGE_ENHANCE_ENDPOINT"),
    route: dbOrEnv("image_route", "QWEN_IMAGE_ROUTE", "IMAGE_ENHANCE_ROUTE"),
    apiKey: dbOrEnv("image_api_key", "QWEN_IMAGE_API_KEY", "IMAGE_ENHANCE_API_KEY"),
    model: models[0] || primaryModel,
    models,
    prompt: settingValue("catalog_image_prompt", "QWEN_IMAGE_PROMPT", "Transforma esta imagen en una fotografía profesional para catálogo ecommerce: producto centrado y completo, fondo blanco puro, iluminación de estudio suave, sombras naturales discretas, alta nitidez, colores fieles al producto, sin texto, sin marcas de agua, sin manos, sin props y sin elementos extra. Conserva la forma y detalles reales del objeto. Resultado limpio, realista y listo para catálogo."),
    timeoutMs: Number.parseInt(settingValue("image_timeout_ms", "QWEN_IMAGE_TIMEOUT_MS", "120000"), 10),
  };
};

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export const resolveImageEnhanceEndpoint = (config: ReturnType<typeof imageEnhanceConfig>) => {
  if (config.baseUrl) {
    const base = config.baseUrl.replace(/\/+$/, "");
    if (config.route) return joinUrl(base, config.route);
    if (/\/v1$/i.test(base)) return joinUrl(base, "/images/edits");
    return joinUrl(base, "/v1/images/edits");
  }
  if (!config.endpoint) return "";
  if (config.route) return joinUrl(config.endpoint, config.route);
  if (/\/v1\/?$/i.test(config.endpoint)) return joinUrl(config.endpoint, "/images/edits");
  return config.endpoint;
};

export const enhanceImageForCatalog = async (imageUrl: string): Promise<ImageEnhanceResult> => {
  const config = imageEnhanceConfig();
  const endpoint = resolveImageEnhanceEndpoint(config);
  if (!endpoint) throw new Error("QWEN_IMAGE_ENDPOINT o QWEN_IMAGE_BASE_URL no está configurado en el entorno.");
  if (!imageUrl.trim()) throw new Error("Primero selecciona, pega o sube una imagen para mejorar.");

  const dbConfig = getConfig();
  const prompt = (dbConfig.catalog_image_prompt || "").trim() || config.prompt;

  const { bytes: imageBytes, mime: imageMime } = await resolveImageBytes(imageUrl);
  const imageFilename = `product.${imageExtensionFromMime(imageMime)}`;

  const modelChain = config.models.length > 0 ? config.models : [""];
  const attempts: { model: string; error: string }[] = [];

  for (const model of modelChain) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000);
    try {
      console.log("[Qwen image/enhance] request", {
        endpoint,
        model: model || "provider-default",
        hasApiKey: Boolean(config.apiKey),
        imageBytes: imageBytes.length,
        imageMime,
      });

      const form = new FormData();
      form.append("image", new Blob([imageBytes], { type: imageMime }), imageFilename);
      form.append("prompt", prompt);
      if (model) form.append("model", model);

      const headers: Record<string, string> = {};
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: form,
      });

      const contentType = response.headers.get("content-type") || "";
      if (contentType.startsWith("image/")) {
        if (!response.ok) throw new Error(`El endpoint de mejora respondió con HTTP ${response.status}`);
        if (attempts.length > 0) console.log(`[Qwen image/enhance] modelo "${model}" tuvo éxito tras ${attempts.length} fallback(s)`);
        return { imageUrl: saveImageBuffer(await response.arrayBuffer(), contentType, "enhanced"), prompt };
      }

      const rawPayload = await response.text();
      console.log("[Qwen image/enhance] response", { model, status: response.status, ok: response.ok, contentType, bodyLength: rawPayload.length, bodyPreview: rawPayload.slice(0, 180) });
      if (!response.ok) throw new Error(parseLlmError(rawPayload) || rawPayload.slice(0, 240) || `HTTP ${response.status}`);
      if (/text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(rawPayload) || /^\s*<html/i.test(rawPayload)) {
        throw new Error(`El endpoint respondió HTML, no una imagen. Estás llamando una ruta de UI o base URL. Usa QWEN_IMAGE_BASE_URL=https://aiapibun.duckdns.org con QWEN_IMAGE_ROUTE=/v1/images/edits, o QWEN_IMAGE_ENDPOINT=${joinUrl(endpoint, endpoint.endsWith("/v1") ? "/images/edits" : "")}.`);
      }

      let candidate = "";
      try { candidate = extractImageCandidate(JSON.parse(rawPayload)); }
      catch { candidate = extractImageCandidate(rawPayload); }
      if (!candidate) throw new Error("El proveedor respondió 200 pero sin URL de imagen.");

      if (attempts.length > 0) console.log(`[Qwen image/enhance] modelo "${model}" tuvo éxito tras ${attempts.length} fallback(s)`);
      return { imageUrl: await persistImageReference(candidate), prompt };
    } catch (error) {
      let errMsg: string;
      if (error instanceof DOMException && error.name === "AbortError") errMsg = "timeout";
      else errMsg = error instanceof Error ? error.message : String(error);
      attempts.push({ model: model || "provider-default", error: errMsg });
      console.warn(`[Qwen image/enhance] modelo "${model || "provider-default"}" falló: ${errMsg}. Intentando siguiente.`);
    } finally {
      clearTimeout(timeout);
    }
  }

  const summary = attempts.map((a) => `${a.model}: ${a.error}`).join(" | ");
  throw new Error(`Todos los modelos fallaron. ${summary}`);
};

// Provider presenta flakiness: a veces responde 500 rápido, otras 200 con imagen tras ~30s.
const DESIGN_RETRY_DELAYS_MS = [2000, 2500];

const looksLikeTextOutputError = (reason: string) =>
  /image_url_missing|failed to extract image url|no image in response/i.test(reason);

export const callImageEditProvider = async (args: {
  prompt: string;
  image: string;
  intent?: string;
  options?: Record<string, unknown>;
  source: string;
  logTag: string;
  filePrefix: string;
}): Promise<ImageEnhanceResult> => {
  const config = imageEnhanceConfig();
  const endpoint = resolveImageEnhanceEndpoint(config);
  if (!endpoint) throw new Error("QWEN_IMAGE_ENDPOINT o QWEN_IMAGE_BASE_URL no está configurado en el entorno.");

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const modelChain = config.models.length > 0 ? config.models : [""];
  const totalAttempts = DESIGN_RETRY_DELAYS_MS.length + 1;
  const imageSizeKb = Math.round(args.image.length / 1024);

  const tryOneModel = async (model: string): Promise<ImageEnhanceResult> => {
    const requestBody: Record<string, unknown> = {
      model: model || undefined,
      prompt: args.prompt,
      image: args.image,
      imageUrl: args.image,
      image_url: args.image,
      response_format: "url",
      source: args.source,
    };
    if (args.intent) requestBody.intent = args.intent;
    if (args.options) requestBody.options = args.options;
    const body = JSON.stringify(requestBody);

    console.log(`[${args.logTag}] preparing`, {
      endpoint,
      model: model || "provider-default",
      hasApiKey: Boolean(config.apiKey),
      promptLength: args.prompt.length,
      promptHead: args.prompt.slice(0, 120),
      promptTail: args.prompt.length > 120 ? "…" + args.prompt.slice(-120) : "",
      imageSizeKb,
      imageSource: args.image.startsWith("data:image/") ? "uploaded-file" : "url",
      totalBodyKb: Math.round(body.length / 1024),
      intent: args.intent || null,
    });

    let lastReason = "";

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000);
      let retriable = false;
      let attemptError: Error | null = null;

      try {
        console.log(`[${args.logTag}] request (model="${model || "provider-default"}", attempt ${attempt}/${totalAttempts})`);

        const response = await fetch(endpoint, { method: "POST", headers, signal: controller.signal, body });
        const contentType = response.headers.get("content-type") || "";

        if (contentType.startsWith("image/")) {
          if (!response.ok) {
            retriable = response.status >= 500;
            attemptError = new Error(`HTTP ${response.status} con un binario de imagen.`);
          } else {
            return { imageUrl: saveImageBuffer(await response.arrayBuffer(), contentType, args.filePrefix), prompt: args.prompt };
          }
        } else {
          const rawPayload = await response.text();
          console.log(`[${args.logTag}] response`, {
            model: model || "provider-default",
            attempt,
            status: response.status,
            ok: response.ok,
            contentType,
            bodyLength: rawPayload.length,
            body: response.ok ? rawPayload.slice(0, 200) : rawPayload.slice(0, 1500),
          });

          if (!response.ok) {
            retriable = response.status >= 500;
            attemptError = new Error(unwrapProviderError(rawPayload) || `HTTP ${response.status}`);
          } else {
            let candidate = "";
            try { candidate = extractImageCandidate(JSON.parse(rawPayload)); }
            catch { candidate = extractImageCandidate(rawPayload); }

            if (candidate) {
              return { imageUrl: await persistImageReference(candidate), prompt: args.prompt };
            }
            retriable = true;
            attemptError = new Error("El proveedor respondió 200 pero sin URL de imagen.");
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new Error("timeout");
        }
        retriable = true;
        attemptError = error instanceof Error ? error : new Error(String(error));
      } finally {
        clearTimeout(timeout);
      }

      lastReason = attemptError?.message || "Error desconocido";

      if (!retriable || attempt === totalAttempts) {
        const exhaustedSuffix = attempt > 1 ? ` tras ${attempt} intentos` : "";
        throw new Error(`${lastReason}${exhaustedSuffix}`);
      }

      console.log(`[${args.logTag}] retrying`, { model: model || "provider-default", attempt, nextDelayMs: DESIGN_RETRY_DELAYS_MS[attempt - 1], reason: lastReason });
      await new Promise(resolve => setTimeout(resolve, DESIGN_RETRY_DELAYS_MS[attempt - 1]));
    }

    throw new Error(`No respondió tras ${totalAttempts} intentos: ${lastReason}`);
  };

  const allAttempts: { model: string; error: string }[] = [];
  for (const model of modelChain) {
    try {
      const result = await tryOneModel(model);
      if (allAttempts.length > 0) console.log(`[${args.logTag}] modelo "${model || "provider-default"}" tuvo éxito tras ${allAttempts.length} fallback(s)`);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      allAttempts.push({ model: model || "provider-default", error: msg });
      console.warn(`[${args.logTag}] modelo "${model || "provider-default"}" agotó retries: ${msg}. Intentando siguiente.`);
    }
  }

  const summary = allAttempts.map((a) => `${a.model}: ${a.error}`).join(" | ");
  const firstReason = allAttempts[0]?.error || "";
  const hint = looksLikeTextOutputError(firstReason)
    ? " El modelo probablemente devolvió texto/código en vez de imagen. Quita palabras como \"svg\", \"código\", \"html\" del prompt y pídele explícitamente una imagen rasterizada (PNG)."
    : " Intenta de nuevo en unos segundos o prueba con otra imagen.";
  throw new Error(`El proveedor de IA falló en ${modelChain.length} modelo(s): ${summary}.${hint}`);
};
