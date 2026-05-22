import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, getConfig, updateConfig, getProducts, getProduct, getDefaultPriceTiers, getProductPriceTiers, replaceDefaultPriceTiers, replaceProductPriceTiers, getQuotes, getQuote, getQuoteItemsWithProducts, updateQuoteStatus, getPrinters, createPrinter, deletePrinter, getFilaments, createFilament, deleteFilament, updateQuotePaymentProof, updateQuoteScheduler, getQuoteFilaments, replaceQuoteFilaments, subtractFilamentStock, type PriceTier, type QuoteItemWithProduct, type Quote, type Printer, type Filament, type QuoteFilamentWithDetails } from "../db/schema";
import { join } from "path";
import * as fs from "fs";

// Middleware for admin auth (moved from app.ts to avoid circular dependency)
export const requireAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  // Very basic auth check for prototype
  if (session === "authenticated") {
    await next();
  } else {
    return c.redirect("/admin/login");
  }
};

const adminRoutes = new Hono();

const formString = (value: unknown) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return formString(value[0]);
  return "";
};
const formStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : ""));
  if (typeof value === "string") return [value];
  return [];
};
const formFile = (value: unknown): File | null => {
  if (value instanceof File && value.size > 0) return value;
  if (Array.isArray(value)) return value.map(formFile).find(Boolean) || null;
  return null;
};
const safeFilename = (name: string) => name.replace(/[^a-zA-Z0-9.-]/g, "_");
const isFontFile = (file: File) => /\.(woff2?|ttf|otf)$/i.test(file.name);
const saveUpload = async (file: File, folder: string, prefix: string) => {
  const uploadDir = join(process.cwd(), "data", "uploads", folder);
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${safeFilename(file.name)}`;
  const uploadPath = join(uploadDir, filename);
  const buffer = await file.arrayBuffer();
  fs.writeFileSync(uploadPath, Buffer.from(buffer));
  return `/uploads/${folder}/${filename}`;
};
const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => htmlEntities[char] || char);
const configValue = (config: Record<string, string>, key: string, fallback = "") => escapeHtml(config[key] || fallback);
const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";
const money = (value: number) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(value || 0);
const plainMoney = (value: number) => new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);
const volumeText = (min: number | null, max: number | null) => {
  if (!min) return "Sin rango";
  return max ? `${min} a ${max} piezas` : `${min} o más piezas`;
};
const renderStatusBadge = (status: string) => {
  if (status === "despachado") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-green-100 text-green-800 border border-green-200">Despachada</span>`;
  }
  if (status === "produccion") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-200">En Producción</span>`;
  }
  if (status === "finalizado") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-purple-100 text-purple-800 border border-purple-200">Finalizada</span>`;
  }
  if (status === "spam") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800 border border-red-200">Spam</span>`;
  }
  return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-yellow-100 text-yellow-800 border border-yellow-200">No despachada</span>`;
};
const quoteFolio = (quote: Pick<Quote, "id">) => `COT-${String(quote.id).padStart(3, "0")}`;
const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-MX");
};

type MakerWorldDraft = {
  sourceUrl: string;
  name: string;
  description: string;
  images: string[];
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string }, delta?: { content?: string } }>;
  error?: { message?: string };
};

type ImageEnhanceResult = {
  imageUrl: string;
  prompt: string;
};

const stripTags = (value: string) => value
  .replace(/<script[\s\S]*?<\/script>/gi, " ")
  .replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ");

const decodeEntities = (value: string) => value
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&#x27;/g, "'");

const cleanText = (value: unknown) => decodeEntities(stripTags(String(value ?? ""))).replace(/\s+/g, " ").trim();

const metaContent = (html: string, key: string) => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapedKey}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapedKey}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return decodeEntities(match).trim();
  }
  return "";
};

const tagText = (html: string, tag: string) => cleanText(html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))?.[1] || "");

const uniqueImages = (values: unknown[]) => {
  const seen = new Set<string>();
  const images: string[] = [];
  const add = (value: unknown) => {
    const url = String(value ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    images.push(url);
  };
  values.forEach(add);
  return images.slice(0, 12);
};

const collectImageCandidates = (value: unknown, output: unknown[] = []) => {
  if (!value || output.length > 80) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && /\.(png|jpe?g|webp)(\?|$)/i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageCandidates(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectImageCandidates(item, output);
  }
  return output;
};

const normalizeMakerWorldUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  if (!url.hostname.endsWith("makerworld.com")) throw new Error("El link debe ser de makerworld.com");
  if (!url.pathname.startsWith("/es/") && /^\/(en|zh|de|fr|it|ja|sv|pt|ko)\//.test(url.pathname)) {
    url.pathname = url.pathname.replace(/^\/[a-z]{2}\//, "/es/");
  }
  return url.toString();
};

const scrapeMakerWorld = async (rawUrl: string): Promise<MakerWorldDraft> => {
  const sourceUrl = normalizeMakerWorldUrl(rawUrl);
  const response = await fetch(sourceUrl, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Catalog Importer" } });
  if (!response.ok) throw new Error(`MakerWorld respondió con HTTP ${response.status}`);
  const html = await response.text();
  const nextRaw = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let design: Record<string, any> | undefined;
  if (nextRaw) {
    try {
      const nextData = JSON.parse(decodeEntities(nextRaw));
      design = nextData?.props?.pageProps?.design;
    } catch {
      design = undefined;
    }
  }
  const title = cleanText(design?.title || metaContent(html, "og:title") || tagText(html, "title")).replace(/ - Free 3D Print Model - MakerWorld$/i, "");
  const description = cleanText(design?.summary || metaContent(html, "description") || metaContent(html, "og:description"));
  const images = uniqueImages([
    design?.coverUrl,
    ...(collectImageCandidates(design) || []),
    metaContent(html, "og:image"),
    ...Array.from(html.matchAll(/https:\/\/makerworld\.bblmw\.com[^"'<>\s]+\.(?:png|jpe?g|webp)(?:\?[^"'<>\s]*)?/gi)).map((match) => match[0]),
  ]);
  return { sourceUrl, name: title || "Producto MakerWorld", description, images };
};

const llmConfig = () => ({
  baseUrl: (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  apiKey: process.env.LLM_API_KEY || "",
  model: process.env.LLM_MODEL || "gpt-4o-mini",
  temperature: Number.parseFloat(process.env.LLM_TEMPERATURE || "0.7"),
  maxWords: Number.parseInt(process.env.LLM_DESCRIPTION_MAX_WORDS || "45", 10),
});

const trimToWordLimit = (value: string, maxWords: number) => {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!Number.isFinite(maxWords) || maxWords < 10 || words.length <= maxWords) return value.trim();
  return `${words.slice(0, maxWords).join(" ").replace(/[,.!?;:]+$/, "")}...`;
};

const parseLlmContent = (rawPayload: string) => {
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

const parseLlmError = (rawPayload: string) => {
  try {
    const payload = JSON.parse(rawPayload) as ChatCompletionResponse;
    return payload.error?.message || "";
  } catch {
    return "";
  }
};

const adaptDescriptionForCatalog = async (name: string, description: string, imageUrl = "") => {
  const config = llmConfig();
  if (!config.apiKey) throw new Error("LLM_API_KEY no está configurada en el entorno.");
  if (!description.trim()) throw new Error("Primero necesitas una descripción base para adaptarla.");
  const hasImage = /^https?:\/\//i.test(imageUrl) || imageUrl.startsWith("data:image/");

  console.log("[LLM description/adapt] request", {
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
    hasApiKey: Boolean(config.apiKey),
    maxWords: config.maxWords,
    hasImage,
    imageSource: imageUrl.startsWith("data:image/") ? "uploaded-file" : hasImage ? "url" : "none",
    nameLength: name.length,
    descriptionLength: description.length,
  });

  const userText = `Producto: ${name || "Producto de impresión 3D"}\n\nDescripción original:\n${description}\n\nReescribe la descripción para una tarjeta de producto de catálogo. Debe caber debajo de la imagen, antes de la tabla de precios. Máximo ${config.maxWords} palabras. Usa un solo párrafo corto, comercial y descriptivo. Invita a comprar sin sonar exagerado. Mantente fiel a la información original. ${hasImage ? "Usa la imagen solo para complementar detalles visuales evidentes, como forma, estilo o apariencia; no inventes medidas, materiales ni funciones que no se puedan confirmar." : ""} Devuelve solo el texto final.`;

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
      messages: [
        {
          role: "system",
          content: "Eres un copywriter experto en catálogos de productos de impresión 3D. Escribes en español claro, comercial y profesional. Tu trabajo es convertir descripciones técnicas o informales en microdescripciones de catálogo atractivas y orientadas a venta. No inventes materiales, medidas, licencias, compatibilidades ni usos no presentes en el texto original. No uses markdown.",
        },
        {
          role: "user",
          content: hasImage ? [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: imageUrl } },
          ] : userText,
        },
      ],
    }),
  });

  const rawPayload = await response.text();
  console.log("[LLM description/adapt] response", {
    status: response.status,
    ok: response.ok,
    body: rawPayload,
  });

  if (!response.ok) throw new Error(parseLlmError(rawPayload) || `El LLM respondió con HTTP ${response.status}`);
  const content = parseLlmContent(rawPayload);
  if (!content) throw new Error("El LLM no devolvió una descripción válida.");
  return trimToWordLimit(content, config.maxWords);
};

const imageEnhanceConfig = () => ({
  baseUrl: (process.env.QWEN_IMAGE_BASE_URL || process.env.IMAGE_ENHANCE_BASE_URL || "").trim(),
  endpoint: (process.env.QWEN_IMAGE_ENDPOINT || process.env.IMAGE_ENHANCE_ENDPOINT || "").trim(),
  route: (process.env.QWEN_IMAGE_ROUTE || process.env.IMAGE_ENHANCE_ROUTE || "").trim(),
  apiKey: process.env.QWEN_IMAGE_API_KEY || process.env.IMAGE_ENHANCE_API_KEY || "",
  model: (process.env.QWEN_IMAGE_MODEL || process.env.IMAGE_ENHANCE_MODEL || "").trim(),
  prompt: (process.env.QWEN_IMAGE_PROMPT || "").trim() || "Transforma esta imagen en una fotografía profesional para catálogo ecommerce: producto centrado y completo, fondo blanco puro, iluminación de estudio suave, sombras naturales discretas, alta nitidez, colores fieles al producto, sin texto, sin marcas de agua, sin manos, sin props y sin elementos extra. Conserva la forma y detalles reales del objeto. Resultado limpio, realista y listo para catálogo.",
  timeoutMs: Number.parseInt(process.env.QWEN_IMAGE_TIMEOUT_MS || "120000", 10),
});

const joinUrl = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

const resolveImageEnhanceEndpoint = (config: ReturnType<typeof imageEnhanceConfig>) => {
  if (config.baseUrl) return joinUrl(config.baseUrl, config.route || "/v1/images/edits");
  if (!config.endpoint) return "";
  if (config.route) return joinUrl(config.endpoint, config.route);
  if (/\/v1\/?$/i.test(config.endpoint)) return joinUrl(config.endpoint, "/images/edits");
  return config.endpoint;
};

const imageExtensionFromMime = (mime: string) => {
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "png";
};

const saveImageBuffer = (buffer: ArrayBuffer | Uint8Array, mime = "image/png", prefix = "enhanced") => {
  const uploadDir = join(process.cwd(), "data", "uploads", "products");
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}.${imageExtensionFromMime(mime)}`;
  const uploadPath = join(uploadDir, filename);
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(new Uint8Array(buffer)) : Buffer.from(buffer);
  fs.writeFileSync(uploadPath, bytes);
  return `/uploads/products/${filename}`;
};

const dataImageToBuffer = (value: string) => {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  return { mime: match[1] || "image/png", buffer: Buffer.from(match[2] || "", "base64") };
};

const looksLikeBase64Image = (value: string) => value.length > 200 && /^[a-z0-9+/=\s]+$/i.test(value);

const persistImageReference = async (value: string) => {
  const candidate = value.trim();
  const dataImage = dataImageToBuffer(candidate);
  if (dataImage) return saveImageBuffer(dataImage.buffer, dataImage.mime, "enhanced");

  if (/^https?:\/\//i.test(candidate)) {
    try {
      const response = await fetch(candidate, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Image Enhancer" } });
      const mime = response.headers.get("content-type") || "";
      if (response.ok && mime.startsWith("image/")) {
        return saveImageBuffer(await response.arrayBuffer(), mime, "enhanced");
      }
    } catch {
      // If the generated URL cannot be downloaded, keep the provider URL.
    }
    return candidate;
  }

  if (looksLikeBase64Image(candidate)) {
    return saveImageBuffer(Buffer.from(candidate.replace(/\s+/g, ""), "base64"), "image/png", "enhanced");
  }

  throw new Error("El endpoint de mejora no devolvió una imagen válida.");
};

const extractImageCandidate = (payload: unknown): string => {
  const preferredKeys = new Set(["imageurl", "image_url", "outputurl", "output_url", "url", "image", "result", "b64_json", "base64"]);

  const walk = (value: unknown, key = ""): string => {
    if (typeof value === "string") {
      const text = value.trim();
      const normalizedKey = key.toLowerCase();
      if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return text;
      if ((normalizedKey.includes("image") || normalizedKey.includes("base64") || normalizedKey.includes("b64")) && looksLikeBase64Image(text)) return text;
      return "";
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, key);
        if (found) return found;
      }
      return "";
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [entryKey, entryValue] of entries) {
        if (preferredKeys.has(entryKey.toLowerCase())) {
          const found = walk(entryValue, entryKey);
          if (found) return found;
        }
      }
      for (const [entryKey, entryValue] of entries) {
        const found = walk(entryValue, entryKey);
        if (found) return found;
      }
    }
    return "";
  };

  return walk(payload);
};

const urlToDataUrl = async (url: string): Promise<string> => {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Image Enhancer" } });
  if (!res.ok) throw new Error(`No se pudo descargar la imagen: HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
};

const enhanceImageForCatalog = async (imageUrl: string): Promise<ImageEnhanceResult> => {
  const config = imageEnhanceConfig();
  const endpoint = resolveImageEnhanceEndpoint(config);
  if (!endpoint) throw new Error("QWEN_IMAGE_ENDPOINT o QWEN_IMAGE_BASE_URL no está configurado en el entorno.");
  if (!imageUrl.trim()) throw new Error("Primero selecciona, pega o sube una imagen para mejorar.");

  // Convert HTTP URLs to base64 data URLs to avoid filename-related OSS signature issues on the provider side
  let resolvedImage = imageUrl;
  if (/^https?:\/\//i.test(imageUrl)) {
    try {
      resolvedImage = await urlToDataUrl(imageUrl);
    } catch (e) {
      console.warn("[Qwen image/enhance] Could not convert URL to data URL, sending raw URL:", e);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000);

  try {
    console.log("[Qwen image/enhance] request", {
      endpoint,
      model: config.model || "provider-default",
      hasApiKey: Boolean(config.apiKey),
      imageSource: resolvedImage.startsWith("data:image/") ? "uploaded-file" : "url",
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model || undefined,
        prompt: config.prompt,
        image: resolvedImage,
        imageUrl: resolvedImage,
        image_url: resolvedImage,
        response_format: "url",
        source: "pixkey3d-makerworld",
        intent: "catalog-product-photo-white-background",
        options: {
          background: "white",
          noText: true,
          style: "studio product photography",
          preserveProduct: true,
        },
      }),
    });

    const contentType = response.headers.get("content-type") || "";
    if (contentType.startsWith("image/")) {
      if (!response.ok) throw new Error(`El endpoint de mejora respondió con HTTP ${response.status}`);
      return { imageUrl: saveImageBuffer(await response.arrayBuffer(), contentType, "enhanced"), prompt: config.prompt };
    }

    const rawPayload = await response.text();
    console.log("[Qwen image/enhance] response", { status: response.status, ok: response.ok, contentType, bodyLength: rawPayload.length, bodyPreview: rawPayload.slice(0, 180) });
    if (!response.ok) throw new Error(parseLlmError(rawPayload) || rawPayload.slice(0, 240) || `El endpoint de mejora respondió con HTTP ${response.status}`);
    if (/text\/html/i.test(contentType) || /^\s*<!doctype html/i.test(rawPayload) || /^\s*<html/i.test(rawPayload)) {
      throw new Error(`El endpoint respondió HTML, no una imagen. Estás llamando una ruta de UI o base URL. Usa QWEN_IMAGE_BASE_URL=https://aiapibun.duckdns.org con QWEN_IMAGE_ROUTE=/v1/images/edits, o QWEN_IMAGE_ENDPOINT=${joinUrl(endpoint, endpoint.endsWith("/v1") ? "/images/edits" : "")}.`);
    }

    let candidate = "";
    try {
      candidate = extractImageCandidate(JSON.parse(rawPayload));
    } catch {
      candidate = extractImageCandidate(rawPayload);
    }

    return { imageUrl: await persistImageReference(candidate), prompt: config.prompt };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("El endpoint de mejora tardó demasiado en responder.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

const bodyValues = (body: Record<string, unknown>, key: string) => {
  const value = body[key];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
};

const parsePriceTiers = (body: Record<string, unknown>): Omit<PriceTier, "id">[] => {
  const mins = bodyValues(body, "tier_min");
  const maxes = bodyValues(body, "tier_max");
  const prices = bodyValues(body, "tier_price");
  const deliveries = bodyValues(body, "tier_delivery");
  return mins.map((min, index) => {
    const minVolume = Number.parseInt(formString(min), 10);
    const maxRaw = formString(maxes[index]);
    const maxVolume = maxRaw ? Number.parseInt(maxRaw, 10) : null;
    const price = Number.parseFloat(formString(prices[index]));
    const deliveryTime = formString(deliveries[index]);
    if (!Number.isFinite(minVolume) || !Number.isFinite(price)) return null;
    return { min_volume: minVolume, max_volume: Number.isFinite(maxVolume) ? maxVolume : null, price, delivery_time: deliveryTime };
  }).filter((tier): tier is Omit<PriceTier, "id"> => Boolean(tier)).sort((a, b) => a.min_volume - b.min_volume);
};

const renderPriceTierRows = (tiers: Omit<PriceTier, "id">[]) => tiers.map((tier) => `
  <tr>
    <td><input type="number" name="tier_min" min="1" required value="${tier.min_volume}" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="number" name="tier_max" min="1" value="${tier.max_volume ?? ""}" placeholder="Sin límite" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="number" name="tier_price" min="0" step="0.01" required value="${tier.price}" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="text" name="tier_delivery" value="${escapeHtml(tier.delivery_time)}" class="w-full px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><button type="button" class="remove-tier text-red-600 hover:text-red-800">Quitar</button></td>
  </tr>
`).join("");

const renderPricingEditor = (tiers: Omit<PriceTier, "id">[]) => `
  <div class="border border-gray-200 rounded-lg overflow-hidden" data-pricing-editor>
    <table class="min-w-full divide-y divide-gray-200" id="price-tiers-table">
      <thead class="bg-gray-50">
        <tr>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Mínimo</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Máximo</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Precio</th>
          <th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Entrega</th>
          <th class="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">${renderPriceTierRows(tiers)}</tbody>
    </table>
  </div>
  <button type="button" id="add-tier" class="mt-3 bg-gray-200 text-gray-800 px-3 py-2 rounded-md hover:bg-gray-300 text-sm" data-pricing-add-tier>+ Agregar rango</button>
  <script>
    (() => {
      const table = document.querySelector('#price-tiers-table tbody');
      const add = document.getElementById('add-tier');
      const syncPricingEditors = () => {
        document.querySelectorAll('form').forEach((form) => {
          const useDefault = form.querySelector('input[name="use_default_pricing"]');
          const editor = form.querySelector('[data-pricing-editor]');
          const addButton = form.querySelector('[data-pricing-add-tier]');
          if (!(useDefault instanceof HTMLInputElement) || !editor) return;
          const disabled = useDefault.checked;
          editor.querySelectorAll('input, button').forEach((control) => {
            if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) control.disabled = disabled;
          });
          if (addButton instanceof HTMLButtonElement) addButton.disabled = disabled;
          editor.classList.toggle('opacity-50', disabled);
          editor.classList.toggle('pointer-events-none', disabled);
        });
      };
      add?.addEventListener('click', () => {
        const row = document.createElement('tr');
        row.innerHTML = '<td><input type="number" name="tier_min" min="1" required class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="number" name="tier_max" min="1" placeholder="Sin límite" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="number" name="tier_price" min="0" step="0.01" required class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="text" name="tier_delivery" class="w-full px-2 py-1 border border-gray-300 rounded-md"></td><td><button type="button" class="remove-tier text-red-600 hover:text-red-800">Quitar</button></td>';
        table?.appendChild(row);
        syncPricingEditors();
      });
      table?.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.classList.contains('remove-tier')) {
          event.target.closest('tr')?.remove();
        }
      });
      document.addEventListener('change', (event) => {
        if (event.target instanceof HTMLInputElement && event.target.name === 'use_default_pricing') syncPricingEditors();
      });
      syncPricingEditors();
    })();
  </script>
`;

const renderDescriptionField = (value = "", rows = 3) => `
  <div>
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <label class="block text-sm font-medium text-gray-700">Descripción</label>
      <button type="button" data-ai-description class="self-start sm:self-auto bg-purple-600 text-white px-3 py-2 rounded-md hover:bg-purple-700 text-sm font-medium">
        Adaptar a catálogo con IA
      </button>
    </div>
    <textarea name="description" rows="${rows}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${escapeHtml(value)}</textarea>
    <label class="mt-2 flex items-center gap-2 text-xs text-gray-600">
      <input type="checkbox" data-ai-include-image class="rounded border-gray-300">
      Agregar imagen a la petición para complementar la descripción
    </label>
    <p data-ai-description-status class="text-xs text-gray-500 mt-1">Convierte la descripción en una microdescripción comercial pensada para caber en la tarjeta del catálogo.</p>
  </div>
`;

const descriptionAiScript = `
  <script>
    (() => {
      const fileToDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(new Error('No se pudo leer la imagen seleccionada.')));
        reader.readAsDataURL(file);
      });

      const selectedImageUrl = async (form) => {
        const includeImage = form?.querySelector('[data-ai-include-image]');
        if (!(includeImage instanceof HTMLInputElement) || !includeImage.checked) return '';
        const fileInput = form.querySelector('input[name="image_file"]');
        if (fileInput instanceof HTMLInputElement && fileInput.files?.[0]) {
          return await fileToDataUrl(fileInput.files[0]);
        }
        const imageUrl = form.querySelector('input[name="image_url"]');
        if (imageUrl instanceof HTMLInputElement && imageUrl.value.trim()) return imageUrl.value.trim();
        const selectedMakerWorldImage = form.querySelector('input[name="selected_image"]:checked');
        if (selectedMakerWorldImage instanceof HTMLInputElement && selectedMakerWorldImage.value.trim()) return selectedMakerWorldImage.value.trim();
        return '';
      };

      const selectedImageForEnhancement = async (form) => {
        const fileInput = form?.querySelector('input[name="image_file"]');
        if (fileInput instanceof HTMLInputElement && fileInput.files?.[0]) {
          return await fileToDataUrl(fileInput.files[0]);
        }
        const selectedMakerWorldImage = form?.querySelector('input[name="selected_image"]:checked');
        if (selectedMakerWorldImage instanceof HTMLInputElement && selectedMakerWorldImage.value.trim()) return selectedMakerWorldImage.value.trim();
        const imageUrl = form?.querySelector('input[name="image_url"]');
        if (imageUrl instanceof HTMLInputElement && imageUrl.value.trim()) return imageUrl.value.trim();
        return '';
      };

      const showEnhancedImage = (form, imageUrl) => {
        const preview = form?.querySelector('[data-enhanced-image-preview]');
        const img = preview?.querySelector('img');
        const link = preview?.querySelector('[data-enhanced-image-link]');
        if (img instanceof HTMLImageElement) img.src = imageUrl;
        if (link instanceof HTMLAnchorElement) link.href = imageUrl;
        preview?.classList.remove('hidden');
      };

      document.addEventListener('click', async (event) => {
        const button = event.target instanceof HTMLElement ? event.target.closest('[data-ai-description]') : null;
        if (!(button instanceof HTMLButtonElement)) return;
        const form = button.closest('form');
        const description = form?.querySelector('textarea[name="description"]');
        const name = form?.querySelector('input[name="name"]');
        const status = form?.querySelector('[data-ai-description-status]');
        if (!(description instanceof HTMLTextAreaElement)) return;
        const previousText = button.textContent;
        button.disabled = true;
        button.textContent = 'Adaptando...';
        if (status) status.textContent = 'Generando texto de catálogo con IA...';
        try {
          const response = await fetch('/admin/description/adapt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name: name instanceof HTMLInputElement ? name.value : '',
              description: description.value,
              imageUrl: await selectedImageUrl(form),
            }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'No se pudo adaptar la descripción.');
          description.value = payload.description || description.value;
          if (status) status.textContent = 'Descripción adaptada. Revisa el texto antes de guardar.';
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : 'No se pudo adaptar la descripción.';
        } finally {
          button.disabled = false;
          button.textContent = previousText;
        }
      });

      document.addEventListener('click', async (event) => {
        const button = event.target instanceof HTMLElement ? event.target.closest('[data-enhance-image]') : null;
        if (!(button instanceof HTMLButtonElement)) return;
        const form = button.closest('form');
        const status = form?.querySelector('[data-image-enhance-status]');
        const imageUrlInput = form?.querySelector('input[name="image_url"]');
        const fileInput = form?.querySelector('input[name="image_file"]');
        const selectedMakerWorldImage = form?.querySelector('input[name="selected_image"]:checked');
        const previousText = button.textContent;
        button.disabled = true;
        button.textContent = 'Mejorando...';
        if (status) status.textContent = selectedMakerWorldImage instanceof HTMLInputElement
          ? 'Enviando la imagen marcada de MakerWorld para crear foto de catálogo con fondo blanco...'
          : 'Enviando imagen para crear foto de catálogo con fondo blanco...';
        try {
          const response = await fetch('/admin/image/enhance', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ imageUrl: await selectedImageForEnhancement(form) }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'No se pudo mejorar la imagen.');
          if (imageUrlInput instanceof HTMLInputElement) imageUrlInput.value = payload.imageUrl || '';
          if (fileInput instanceof HTMLInputElement) fileInput.value = '';
          if (selectedMakerWorldImage instanceof HTMLInputElement) selectedMakerWorldImage.checked = false;
          showEnhancedImage(form, payload.imageUrl || '');
          if (status) status.textContent = 'Imagen mejorada lista y seleccionada como imagen final. Al guardar el producto se usará este resultado.';
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : 'No se pudo mejorar la imagen.';
        } finally {
          button.disabled = false;
          button.textContent = previousText;
        }
      });
    })();
  </script>
`;

const AdminLayout = (title: string, content: string) => `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 font-sans min-h-screen">
    <nav class="bg-blue-800 text-white shadow-md">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center">
                    <a href="/admin" class="font-bold text-xl tracking-tight">PIXKEY3D Admin</a>
                    <div class="ml-10 flex items-baseline space-x-4">
                        <a href="/admin/config" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Configuración</a>
                        <a href="/admin/products" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Productos</a>
                        <a href="/admin/quotes" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Cotizaciones</a>
                        <a href="/admin/production" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Producción</a>
                        <a href="/admin/production-settings" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Ajustes Prod</a>
                        <a href="/admin/makerworld" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">MakerWorld</a>
                        <a href="/" target="_blank" class="px-3 py-2 rounded-md text-sm font-medium text-blue-200 hover:text-white hover:bg-blue-700">Ver Catálogo ↗</a>
                    </div>
                </div>
                <div>
                    <form action="/admin/logout" method="post" class="inline">
                        <button type="submit" class="text-sm font-medium text-blue-200 hover:text-white">Cerrar Sesión</button>
                    </form>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        ${content}
    </main>
${descriptionAiScript}
</body>
</html>
`;

adminRoutes.get("/login", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login - Admin</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
        <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
            <h1 class="text-2xl font-bold mb-6 text-center text-gray-800">Administración</h1>
            <form action="/admin/login" method="post" class="space-y-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Usuario</label>
                    <input type="text" name="username" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Contraseña</label>
                    <input type="password" name="password" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                <button type="submit" class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                    Ingresar
                </button>
            </form>
        </div>
    </body>
    </html>
  `);
});

adminRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const validUsername = process.env.ADMIN_USERNAME || "Frxn5J";
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validPassword) {
    return c.text("ADMIN_PASSWORD no está configurado en el entorno.", 500);
  }

  if (body.username === validUsername && body.password === validPassword) {
    setCookie(c, "admin_session", "authenticated", {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 // 1 day
    });
    return c.redirect("/admin");
  }

  return c.redirect("/admin/login?error=1");
});

adminRoutes.post("/logout", (c) => {
  deleteCookie(c, "admin_session");
  return c.redirect("/admin/login");
});

// Protect all routes below
adminRoutes.use("/*", requireAuth);

adminRoutes.get("/", (c) => {
  return c.redirect("/admin/products");
});

adminRoutes.get("/quotes", (c) => {
  const currentStatus = c.req.query("status") || "todos";
  const quotes = getQuotes(100);

  const filteredQuotes = currentStatus === "todos"
    ? quotes
    : quotes.filter((q) => {
        if (currentStatus === "despachado") return q.status === "despachado";
        if (currentStatus === "no_despachado") return q.status === "new" || q.status === "no_despachado";
        if (currentStatus === "produccion") return q.status === "produccion";
        if (currentStatus === "finalizado") return q.status === "finalizado";
        if (currentStatus === "spam") return q.status === "spam";
        return true;
      });

  const rows = filteredQuotes.map((quote) => {
    const items = getQuoteItemsWithProducts(quote.id);
    const itemsHtml = items.map((item: QuoteItemWithProduct) => `
      <li>
        <span class="font-medium">${escapeHtml(item.product_name)}</span>:
        ${item.quantity} piezas × ${money(item.unit_price)} = ${money(item.subtotal)}
      </li>
    `).join("");
    return `
      <tr class="align-top">
        <td class="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">${escapeHtml(quoteFolio(quote))}</td>
        <td class="px-4 py-3 text-sm text-gray-700">
          <div class="font-medium text-gray-900">${escapeHtml(quote.customer_name)}</div>
          <div class="text-gray-500">CP ${escapeHtml(quote.postal_code)}</div>
          <div class="text-gray-500">${formatDate(quote.created_at)}</div>
        </td>
        <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
          ${renderStatusBadge(quote.status)}
        </td>
        <td class="px-4 py-3 text-sm text-gray-700 font-medium">${quote.total_pieces}</td>
        <td class="px-4 py-3 text-sm text-gray-700">
          <div>Subtotal: ${money(quote.subtotal)}</div>
          <div>Envío: ${quote.shipping_cost > 0 ? money(quote.shipping_cost) : "Gratis"}</div>
          <div class="font-semibold text-gray-900">Total: ${money(quote.grand_total)}</div>
        </td>
        <td class="px-4 py-3 text-sm text-gray-700">
          <ul class="list-disc pl-4 space-y-0.5 text-xs text-gray-600">${itemsHtml || '<li class="text-gray-500">Sin productos.</li>'}</ul>
        </td>
        <td class="px-4 py-3 text-right whitespace-nowrap text-sm font-medium">
          <a href="/admin/quotes/${quote.id}" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md text-xs font-semibold inline-block transition-colors">
            Ver detalles y PDF
          </a>
        </td>
      </tr>
    `;
  }).join("");

  return c.html(AdminLayout("Cotizaciones", `
    <div class="bg-white shadow rounded-lg overflow-hidden p-6">
      <div class="border-b border-gray-200 pb-4 mb-6">
        <h2 class="text-2xl font-bold text-gray-800">Cotizaciones guardadas</h2>
        <p class="text-sm text-gray-500 mt-1">Se guardan automáticamente cuando el cliente inicia la cotización desde el catálogo interactivo.</p>
      </div>

      <div class="flex border-b border-gray-200 mb-6 bg-gray-50 p-1.5 rounded-lg gap-1.5 max-w-xl">
        <a href="/admin/quotes?status=todos" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'todos' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">Todas</a>
        <a href="/admin/quotes?status=no_despachado" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'no_despachado' ? 'bg-yellow-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">No despachadas</a>
        <a href="/admin/quotes?status=despachado" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'despachado' ? 'bg-green-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">Despachadas</a>
        <a href="/admin/quotes?status=produccion" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'produccion' ? 'bg-blue-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">En Producción</a>
        <a href="/admin/quotes?status=finalizado" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'finalizado' ? 'bg-purple-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">Finalizadas</a>
        <a href="/admin/quotes?status=spam" class="px-4 py-2 text-xs font-bold rounded-md transition-all ${currentStatus === 'spam' ? 'bg-red-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">Spam</a>
      </div>

      <div class="overflow-x-auto border rounded-lg">
        <table class="min-w-full divide-y divide-gray-200">
          <thead class="bg-gray-50">
            <tr>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Folio</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Cliente</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Estado</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Piezas</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Totales</th>
              <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Productos</th>
              <th class="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody class="bg-white divide-y divide-gray-200">
            ${rows || '<tr><td colspan="7" class="px-6 py-10 text-center text-gray-500">No se encontraron cotizaciones con este estado.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `));
});

adminRoutes.post("/description/adapt", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const description = await adaptDescriptionForCatalog(formString(body.name), formString(body.description), formString(body.imageUrl));
    return c.json({ description });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "No se pudo adaptar la descripción." }, 400);
  }
});

adminRoutes.post("/image/enhance", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await enhanceImageForCatalog(formString(body.imageUrl));
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "No se pudo mejorar la imagen." }, 400);
  }
});

const renderMakerWorldForm = (draft?: MakerWorldDraft, error = "") => {
  const defaultTiers = getDefaultPriceTiers();
  return AdminLayout("Importar MakerWorld", `
    <div class="bg-white shadow rounded-lg p-6 space-y-6">
      <div>
        <h2 class="text-xl font-bold text-gray-800">Importar desde MakerWorld</h2>
        <p class="text-sm text-gray-500 mt-1">Pega un link de MakerWorld. El sistema intenta traer nombre, descripción en español e imágenes; TODO queda editable antes de mandar al catálogo.</p>
      </div>
      ${error ? `<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">${escapeHtml(error)}</div>` : ""}
      <form action="/admin/makerworld" method="post" class="flex flex-col sm:flex-row gap-3">
        <input type="url" name="makerworld_url" required value="${escapeHtml(draft?.sourceUrl || "")}" placeholder="https://makerworld.com/es/models/..." class="flex-1 px-3 py-2 border border-gray-300 rounded-md">
        <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Analizar link</button>
      </form>
      ${draft ? `
      <form action="/admin/makerworld/save" method="post" enctype="multipart/form-data" class="space-y-6 border-t pt-6">
        <input type="hidden" name="source_url" value="${escapeHtml(draft.sourceUrl)}">
        <div>
          <label class="block text-sm font-medium text-gray-700">Nombre del llavero / producto *</label>
          <input type="text" name="name" required value="${escapeHtml(draft.name)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
        </div>
        ${renderDescriptionField(draft.description, 5)}
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Elige imagen de MakerWorld</label>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            ${draft.images.map((image, index) => `
              <label class="border rounded-lg p-2 cursor-pointer hover:border-blue-500">
                <input type="radio" name="selected_image" value="${escapeHtml(image)}" ${index === 0 ? "checked" : ""} class="mb-2">
                <img src="${escapeHtml(image)}" class="h-36 w-full object-contain bg-gray-50 rounded" loading="lazy">
              </label>
            `).join("")}
            ${draft.images.length === 0 ? '<p class="text-sm text-gray-500">No se encontraron imágenes. Sube una manualmente abajo.</p>' : ""}
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">O pega/sube otra imagen</label>
          <input type="text" name="image_url" placeholder="URL de imagen alternativa..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
          <input type="file" name="image_file" accept="image/*" class="block w-full text-sm text-gray-500">
          <p class="text-xs text-gray-500 mt-1">Al guardar se usa la URL de este campo si existe. El botón de mejora pondrá aquí la imagen final automáticamente.</p>
        </div>
        <div class="rounded-lg border border-purple-200 bg-purple-50 p-4">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 class="text-sm font-semibold text-purple-900">Foto para catálogo</h3>
              <p data-image-enhance-status class="text-xs text-purple-700 mt-1">Mejora la imagen seleccionada para fondo blanco, estilo estudio y sin texto.</p>
            </div>
            <button type="button" data-enhance-image class="self-start sm:self-auto bg-purple-600 text-white px-4 py-2 rounded-md hover:bg-purple-700 text-sm font-medium">
              Mejorar imagen
            </button>
          </div>
          <div data-enhanced-image-preview class="hidden mt-4">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
              <p class="text-xs font-medium text-purple-900">Resultado mejorado seleccionado como imagen final</p>
              <a data-enhanced-image-link href="#" target="_blank" class="text-xs font-medium text-purple-700 underline">Abrir resultado</a>
            </div>
            <img src="" alt="Imagen mejorada para catálogo" class="max-h-56 w-full object-contain rounded-md border border-purple-200 bg-white p-2">
            <p class="text-xs text-purple-700 mt-2">No tienes que seleccionar nada más: esta imagen ya quedó en el campo de URL y se usará al presionar “Agregar al catálogo”.</p>
          </div>
        </div>
        <div class="border border-orange-200 bg-orange-50 rounded-lg p-4">
          <h3 class="text-sm font-bold text-orange-900 mb-3">🖨 Datos de Impresión (para planificador de producción)</h3>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label class="block text-xs font-bold text-gray-700">Filamento por pieza (gramos)</label>
              <input type="number" name="filament_grams" min="0" step="0.1" value="0" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              <p class="text-xs text-gray-500 mt-1">Cuántos gramos consume al imprimir una pieza.</p>
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Tiempo de impresión por pieza (minutos)</label>
              <input type="number" name="print_time_mins" min="0" step="1" value="0" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              <p class="text-xs text-gray-500 mt-1">Tiempo estimado de impresora ocupada por pieza.</p>
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Costos extra por pieza ($ MXN)</label>
              <input type="number" name="extra_costs" min="0" step="0.01" value="0.00" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              <p class="text-xs text-gray-500 mt-1">Suma de insumos adicionales: NFC, argolla, etc.</p>
            </div>
          </div>
        </div>
        <div>
          <label class="flex items-start gap-3 text-sm">
            <input type="checkbox" name="use_default_pricing" value="1" checked class="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded">
            <span><strong>Usar tabla global de precios</strong><br><span class="text-gray-500">Desmarca para guardar precios custom para este producto.</span></span>
          </label>
        </div>
        <div>
          <h3 class="text-lg font-semibold mb-3">Rangos de precios custom</h3>
          <p class="text-sm text-gray-500 mb-3">Si “Usar tabla global” está marcado, esta tabla se desactiva y no bloquea el guardado. Desmárcalo para editar precios personalizados.</p>
          ${renderPricingEditor(defaultTiers)}
        </div>
        <div class="flex justify-end gap-3 pt-4 border-t">
          <a href="/admin/products" class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300">Cancelar</a>
          <button type="submit" class="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700">Agregar al catálogo</button>
        </div>
      </form>` : ""}
    </div>
  `);
};

adminRoutes.get("/makerworld", (c) => c.html(renderMakerWorldForm()));

adminRoutes.post("/makerworld", async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  try {
    const draft = await scrapeMakerWorld(formString(body.makerworld_url));
    return c.html(renderMakerWorldForm(draft));
  } catch (error) {
    return c.html(renderMakerWorldForm(undefined, error instanceof Error ? error.message : "No se pudo analizar el link de MakerWorld"), 400);
  }
});

adminRoutes.post("/makerworld/save", async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  let imageUrl = formString(body.image_url) || formString(body.selected_image);
  const file = formFile(body.image_file);
  if (file) imageUrl = await saveUpload(file, "products", "prod");
  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;
  const result = db.query(`
    INSERT INTO products (name, description, image_url, makerworld_url, filament_grams, print_time_mins, extra_costs, use_default_pricing, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.source_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing) as {id: number};
  if (!useDefaultPricing) replaceProductPriceTiers(result.id, parsePriceTiers(body));
  return c.redirect(`/admin/products/${result.id}/edit`);
});

adminRoutes.get("/config", (c) => {
  const config = getConfig();
  const tiers = getDefaultPriceTiers();

  return c.html(AdminLayout("Configuración", `
    <div class="bg-white shadow rounded-lg p-6 mb-6">
        <h2 class="text-xl font-bold mb-4">Configuración General</h2>
        <p class="text-sm text-gray-500 mb-6">Edita los datos del catálogo y usa la vista previa para probar CSS personalizado antes de guardar.</p>
        <form action="/admin/config" method="post" enctype="multipart/form-data" class="space-y-6">
            <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start mb-8">
                <div class="border border-gray-200 rounded-lg bg-gray-50 p-4">
                    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">Vista previa del documento</h3>
                            <p class="text-xs text-gray-500">Muestra el catálogo guardado. El CSS personalizado se aplica en vivo mientras escribes.</p>
                        </div>
                        <div class="flex flex-wrap gap-2">
                            <button type="button" id="preview-desktop" class="px-3 py-2 text-xs font-medium rounded-md bg-white border border-gray-300 hover:bg-gray-100">Desktop</button>
                            <button type="button" id="preview-mobile" class="px-3 py-2 text-xs font-medium rounded-md bg-white border border-gray-300 hover:bg-gray-100">Móvil</button>
                            <button type="button" id="preview-refresh" class="px-3 py-2 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">Recargar</button>
                        </div>
                    </div>
                    <div id="preview-frame-shell" class="mx-auto w-full overflow-hidden rounded-lg border border-gray-300 bg-white shadow-inner" style="height: 720px; max-width: 100%;">
                        <iframe id="catalog-preview" src="/imprimir?embed=1" class="h-full w-full bg-white" title="Vista previa del catálogo"></iframe>
                    </div>
                </div>

                <div class="border border-gray-200 rounded-lg bg-gray-50 p-4 xl:sticky xl:top-6">
                    <label for="custom-css-editor" class="block text-sm font-semibold text-gray-900">CSS Personalizado de la Vista Previa</label>
                    <p class="text-xs text-gray-500 mt-1 mb-3">Este CSS se aplica en vivo al documento de la izquierda y se guarda como parte del tema.</p>
                    <textarea id="custom-css-editor" name="custom_css" rows="26" class="block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm leading-5" placeholder="/* Escribe aquí tus estilos para el catálogo */">${configValue(config, "custom_css")}</textarea>
                    <p class="text-xs text-gray-500 mt-3">Ejemplo: <code>.cover-section { background: #fff; }</code> o <code>.theme-card { border-radius: 32px; }</code></p>
                </div>
            </div>

            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Nombre de la Empresa</label>
                    <input type="text" name="company_name" value="${configValue(config, "company_name")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Subtítulo de Portada</label>
                    <input type="text" name="cover_subtitle" value="${configValue(config, "cover_subtitle", "Catálogo de Productos")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Título de Sección Productos</label>
                    <input type="text" name="products_title" value="${configValue(config, "products_title", "Nuestros Productos")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">WhatsApp para Cotizaciones</label>
                    <input type="text" name="quote_whatsapp_number" value="${configValue(config, "quote_whatsapp_number", "4961266304")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 4961266304">
                    <p class="text-xs text-gray-500 mt-1">Usa solo números. Si son 10 dígitos de México, el sistema agrega 52 para el link de WhatsApp.</p>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Paquetería para Cotización</label>
                    <input type="text" name="shipping_provider" value="${configValue(config, "shipping_provider", "Estafeta")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: Estafeta">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Costo de Envío Estimado</label>
                    <input type="number" name="shipping_price" min="0" step="0.01" value="${configValue(config, "shipping_price", "150")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="150">
                    <p class="text-xs text-gray-500 mt-1">Se suma al total cuando no aplica envío gratis.</p>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Envío Gratis desde Piezas</label>
                    <input type="number" name="free_shipping_min_pieces" min="0" step="1" value="${configValue(config, "free_shipping_min_pieces", "501")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="501">
                    <p class="text-xs text-gray-500 mt-1">Con 0 o vacío se desactiva. Con 501, el envío es gratis desde 501 piezas.</p>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Logo (URL o subir archivo)</label>
                    <input type="text" name="company_logo_url" value="${configValue(config, "company_logo")}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                    <input type="file" name="company_logo_file" accept="image/*" class="block w-full text-sm text-gray-500">
                </div>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Bienvenida (acepta HTML)</label>
                <textarea name="welcome_text" rows="8" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "welcome_text")}</textarea>
                <p class="text-xs text-gray-500 mt-1">Puedes usar etiquetas como &lt;h2&gt;, &lt;p&gt;, &lt;strong&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;a&gt;, &lt;table&gt; e &lt;img&gt;. Si escribes texto plano, se conservan los saltos de línea.</p>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Contacto / Pie de página (acepta HTML)</label>
                <textarea name="contact_text" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "contact_text")}</textarea>
                <p class="text-xs text-gray-500 mt-1">Este contenido se inserta como HTML en la última página del catálogo.</p>
            </div>

            <div>
                <h3 class="text-lg font-semibold mb-3">Tabla Global de Precios por Volumen</h3>
                <p class="text-sm text-gray-500 mb-3">Estos rangos se usan en productos que tengan marcada la opción de precios globales.</p>
                ${renderPricingEditor(tiers)}
            </div>

            <hr class="my-6">
            <h3 class="text-lg font-semibold mb-4">Personalización Visual (Tema)</h3>

            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Primario</label>
                    <input type="color" name="color_primary" value="${configValue(config, "color_primary", "#ef4444")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Secundario</label>
                    <input type="color" name="color_secondary" value="${configValue(config, "color_secondary", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Acento</label>
                    <input type="color" name="color_accent" value="${configValue(config, "color_accent", "#f87171")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Fondos y Textos de Secciones</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Portada</label>
                    <input type="color" name="bg_cover" value="${configValue(config, "bg_cover", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Portada</label>
                    <input type="color" name="color_cover_text" value="${configValue(config, "color_cover_text", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Bienvenida</label>
                    <input type="color" name="bg_welcome" value="${configValue(config, "bg_welcome", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Productos</label>
                    <input type="color" name="bg_products" value="${configValue(config, "bg_products", "#f9fafb")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Contacto</label>
                    <input type="color" name="bg_contact" value="${configValue(config, "bg_contact", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Contacto</label>
                    <input type="color" name="color_contact_text" value="${configValue(config, "color_contact_text", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Tarjetas</label>
                    <input type="color" name="bg_card" value="${configValue(config, "bg_card", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Borde Tarjetas</label>
                    <input type="color" name="color_card_border" value="${configValue(config, "color_card_border", "#e5e7eb")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Encabezado Tabla</label>
                    <input type="color" name="bg_table_header" value="${configValue(config, "bg_table_header", "#f3f4f6")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Encabezado Tabla</label>
                    <input type="color" name="color_table_header_text" value="${configValue(config, "color_table_header_text", "#4b5563")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Tipografía y Colores Generales</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Principal</label>
                    <input type="color" name="color_body_text" value="${configValue(config, "color_body_text", "#374151")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Encabezados</label>
                    <input type="color" name="color_heading_text" value="${configValue(config, "color_heading_text", "#111827")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Secundario (Muted)</label>
                    <input type="color" name="color_muted_text" value="${configValue(config, "color_muted_text", "#6b7280")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 mt-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fuente Principal (Body)</label>
                    <input type="text" name="font_body" value="${configValue(config, "font_body", defaultFontFamily)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 'Central Bold', Arial, sans-serif">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fuente Encabezados</label>
                    <input type="text" name="font_heading" value="${configValue(config, "font_heading", defaultFontFamily)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 'Central Bold', Arial, sans-serif">
                </div>
            </div>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 mt-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Archivo de Fuente Principal</label>
                    ${config.font_body_file ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${configValue(config, "font_body_file")}" target="_blank" class="text-blue-600 underline">${configValue(config, "font_body_file")}</a></p>` : '<p class="text-xs text-gray-500 mt-1">Sin archivo subido. Se usará el nombre de fuente escrito arriba.</p>'}
                    <input type="file" name="font_body_file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" class="mt-2 block w-full text-sm text-gray-500">
                    <label class="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox" name="remove_font_body_file" value="1" class="rounded border-gray-300">
                        Quitar fuente subida del texto principal
                    </label>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Archivo de Fuente Encabezados</label>
                    ${config.font_heading_file ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${configValue(config, "font_heading_file")}" target="_blank" class="text-blue-600 underline">${configValue(config, "font_heading_file")}</a></p>` : '<p class="text-xs text-gray-500 mt-1">Sin archivo subido. Se usará el nombre de fuente escrito arriba.</p>'}
                    <input type="file" name="font_heading_file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" class="mt-2 block w-full text-sm text-gray-500">
                    <label class="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox" name="remove_font_heading_file" value="1" class="rounded border-gray-300">
                        Quitar fuente subida de encabezados
                    </label>
                </div>
            </div>
            <p class="text-xs text-gray-500 mt-2">Formatos permitidos: .woff, .woff2, .ttf y .otf. Si subes un archivo, se usa primero; el campo de texto queda como respaldo.</p>

            <h4 class="text-md font-semibold mt-6 mb-2">Estilos Visuales</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Redondeo General (Bordes)</label>
                    <input type="text" name="border_radius" value="${configValue(config, "border_radius", "0.5rem")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 0.5rem o 8px">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Redondeo de Botones</label>
                    <input type="text" name="button_radius" value="${configValue(config, "button_radius", "0.5rem")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 9999px para píldora">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Sombra de Tarjetas</label>
                    <input type="text" name="card_shadow" value="${configValue(config, "card_shadow", "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Estilo de Tarjeta</label>
                    <select name="card_style" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="flat" ${config.card_style === 'flat' ? 'selected' : ''}>Plana (Sombra)</option>
                        <option value="bordered" ${config.card_style === 'bordered' ? 'selected' : ''}>Con Borde</option>
                        <option value="minimal" ${config.card_style === 'minimal' ? 'selected' : ''}>Minimalista</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Densidad del Diseño</label>
                    <select name="layout_density" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="comfortable" ${config.layout_density === 'comfortable' ? 'selected' : ''}>Cómoda</option>
                        <option value="compact" ${config.layout_density === 'compact' ? 'selected' : ''}>Compacta</option>
                        <option value="spacious" ${config.layout_density === 'spacious' ? 'selected' : ''}>Amplia</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Ajuste de Imagen Producto</label>
                    <select name="product_image_fit" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="cover" ${config.product_image_fit === 'cover' ? 'selected' : ''}>Cubrir</option>
                        <option value="contain" ${config.product_image_fit === 'contain' ? 'selected' : ''}>Contener</option>
                    </select>
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Formas Decorativas (Portadas y Secciones)</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div class="flex items-center">
                    <input type="checkbox" name="decorative_shapes_enabled" id="decorative_shapes_enabled" value="1" ${config.decorative_shapes_enabled === '1' ? 'checked' : ''} class="h-4 w-4 text-blue-600 border-gray-300 rounded">
                    <label for="decorative_shapes_enabled" class="ml-2 block text-sm font-medium text-gray-700">Habilitar formas decorativas de fondo</label>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Tipo de Formas</label>
                    <select name="decorative_shape_style" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="organic" ${config.decorative_shape_style === 'organic' ? 'selected' : ''}>Orgánicas</option>
                        <option value="circles" ${config.decorative_shape_style === 'circles' ? 'selected' : ''}>Círculos</option>
                        <option value="diagonal" ${config.decorative_shape_style === 'diagonal' ? 'selected' : ''}>Diagonales</option>
                        <option value="dots" ${config.decorative_shape_style === 'dots' ? 'selected' : ''}>Puntos</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color de Formas (soporta rgba)</label>
                    <input type="text" name="decorative_shape_color" value="${configValue(config, "decorative_shape_color", "rgba(239, 68, 68, 0.1)")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: rgba(255,255,255,0.05)">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Opacidad de Formas</label>
                    <input type="text" name="decorative_shape_opacity" value="${configValue(config, "decorative_shape_opacity", "0.45")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="0 a 1">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Blur de Formas</label>
                    <input type="text" name="decorative_shape_blur" value="${configValue(config, "decorative_shape_blur", "0px")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 16px o 0px">
                </div>
            </div>

            <div class="pt-4 border-t">
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Configuración</button>
            </div>
        </form>
    </div>
    <script>
      (() => {
        const editor = document.getElementById('custom-css-editor');
        const frame = document.getElementById('catalog-preview');
        const shell = document.getElementById('preview-frame-shell');
        const refresh = document.getElementById('preview-refresh');
        const desktop = document.getElementById('preview-desktop');
        const mobile = document.getElementById('preview-mobile');

        const applyCss = () => {
          if (!editor || !frame || !frame.contentDocument) return;
          const doc = frame.contentDocument;
          let style = doc.getElementById('admin-live-custom-css');
          if (!style) {
            style = doc.createElement('style');
            style.id = 'admin-live-custom-css';
            doc.head.appendChild(style);
          }
          style.textContent = editor.value || '';
        };

        frame?.addEventListener('load', applyCss);
        editor?.addEventListener('input', applyCss);
        refresh?.addEventListener('click', () => {
          if (frame?.contentWindow) frame.contentWindow.location.reload();
        });
        desktop?.addEventListener('click', () => {
          if (!shell) return;
          shell.style.maxWidth = '100%';
          shell.style.height = '720px';
        });
        mobile?.addEventListener('click', () => {
          if (!shell) return;
          shell.style.maxWidth = '390px';
          shell.style.height = '720px';
        });
      })();
    </script>
  `));
});

adminRoutes.post("/config", async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  const currentConfig = getConfig();

  let logoUrl = formString(body.company_logo_url);
  let fontBodyFileUrl = body.remove_font_body_file === "1" ? "" : (currentConfig.font_body_file || "");
  let fontHeadingFileUrl = body.remove_font_heading_file === "1" ? "" : (currentConfig.font_heading_file || "");

  // Handle file upload
  const file = formFile(body.company_logo_file);
  if (file) {
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    logoUrl = `/uploads/${filename}`;
  }

  const fontBodyFile = formFile(body.font_body_file);
  if (fontBodyFile) {
    if (!isFontFile(fontBodyFile)) return c.text("Formato de fuente principal no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    fontBodyFileUrl = await saveUpload(fontBodyFile, "fonts", "body-font");
  }

  const fontHeadingFile = formFile(body.font_heading_file);
  if (fontHeadingFile) {
    if (!isFontFile(fontHeadingFile)) return c.text("Formato de fuente de encabezados no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    fontHeadingFileUrl = await saveUpload(fontHeadingFile, "fonts", "heading-font");
  }

  updateConfig({
    company_name: formString(body.company_name),
    company_logo: logoUrl,
    cover_subtitle: formString(body.cover_subtitle),
    products_title: formString(body.products_title),
    quote_whatsapp_number: formString(body.quote_whatsapp_number),
    shipping_provider: formString(body.shipping_provider) || "Estafeta",
    shipping_price: formString(body.shipping_price) || "0",
    free_shipping_min_pieces: formString(body.free_shipping_min_pieces) || "0",
    welcome_text: formString(body.welcome_text),
    contact_text: formString(body.contact_text),
    color_primary: formString(body.color_primary),
    color_secondary: formString(body.color_secondary),
    color_accent: formString(body.color_accent),
    bg_cover: formString(body.bg_cover),
    color_cover_text: formString(body.color_cover_text),
    bg_welcome: formString(body.bg_welcome),
    bg_products: formString(body.bg_products),
    bg_contact: formString(body.bg_contact),
    color_contact_text: formString(body.color_contact_text),
    bg_card: formString(body.bg_card),
    color_card_border: formString(body.color_card_border),
    bg_table_header: formString(body.bg_table_header),
    color_table_header_text: formString(body.color_table_header_text),
    color_body_text: formString(body.color_body_text),
    color_heading_text: formString(body.color_heading_text),
    color_muted_text: formString(body.color_muted_text),
    font_body: formString(body.font_body),
    font_heading: formString(body.font_heading),
    font_body_file: fontBodyFileUrl,
    font_heading_file: fontHeadingFileUrl,
    border_radius: formString(body.border_radius),
    button_radius: formString(body.button_radius),
    card_shadow: formString(body.card_shadow),
    card_style: formString(body.card_style),
    layout_density: formString(body.layout_density),
    product_image_fit: formString(body.product_image_fit),
    decorative_shapes_enabled: (body.decorative_shapes_enabled ? "1" : "0"),
    decorative_shape_style: formString(body.decorative_shape_style),
    decorative_shape_color: formString(body.decorative_shape_color),
    decorative_shape_opacity: formString(body.decorative_shape_opacity),
    decorative_shape_blur: formString(body.decorative_shape_blur),
    custom_css: formString(body.custom_css),
  });

  replaceDefaultPriceTiers(parsePriceTiers(body));

  return c.redirect("/admin/config");
});

adminRoutes.get("/products", (c) => {
  const products = getProducts();

  return c.html(AdminLayout("Productos", `
    <div class="bg-white shadow rounded-lg overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h2 class="text-xl font-bold text-gray-800">Catálogo de Productos</h2>
            <a href="/admin/products/new" class="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 text-sm font-medium">
                + Nuevo Producto
            </a>
        </div>

        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Imagen</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Nombre</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Precios</th>
                    <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
                </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
                ${products.map(p => `
                <tr>
                    <td class="px-6 py-4 whitespace-nowrap">
                        ${p.image_url
                            ? `<img src="${escapeHtml(p.image_url)}" class="h-10 w-10 rounded object-cover">`
                            : `<div class="h-10 w-10 rounded bg-gray-200"></div>`
                        }
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="text-sm font-medium text-gray-900">${escapeHtml(p.name)}</div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${p.use_default_pricing ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}">
                            ${p.use_default_pricing ? 'Globales' : 'Personalizados'}
                        </span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <a href="/admin/products/${p.id}/edit" class="text-indigo-600 hover:text-indigo-900 mr-3">Editar</a>
                        <form action="/admin/products/${p.id}/delete" method="post" class="inline" onsubmit="return confirm('¿Seguro que deseas eliminar este producto?');">
                            <button type="submit" class="text-red-600 hover:text-red-900">Eliminar</button>
                        </form>
                    </td>
                </tr>
                `).join('')}
                ${products.length === 0 ? '<tr><td colspan="4" class="px-6 py-10 text-center text-gray-500">No hay productos. Crea uno nuevo.</td></tr>' : ''}
            </tbody>
        </table>
    </div>
  `));
});

adminRoutes.get("/products/new", (c) => {
  const defaultTiers = getDefaultPriceTiers();
  return c.html(AdminLayout("Nuevo Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Agregar Nuevo Producto</h2>
        <form action="/admin/products/new" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Link de MakerWorld (Opcional)</label>
                <input type="url" name="makerworld_url" placeholder="https://makerworld.com/es/models/..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Filamento Requerido (Gramos)</label>
                    <input type="number" name="filament_grams" min="0" step="0.1" value="0" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Tiempo de Impresión (Minutos)</label>
                    <input type="number" name="print_time_mins" min="0" step="1" value="0" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Costos Extra (NFC, argolla, etc. $ MXN)</label>
                    <input type="number" name="extra_costs" min="0" step="0.01" value="0.00" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
            </div>

            ${renderDescriptionField("", 3)}

            <div>
                <label class="block text-sm font-medium text-gray-700">Imagen (URL o subir archivo)</label>
                <input type="text" name="image_url" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                <input type="file" name="image_file" accept="image/*" class="block w-full text-sm text-gray-500">
            </div>

            <div>
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="use_default_pricing" name="use_default_pricing" type="checkbox" checked value="1" class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="use_default_pricing" class="font-medium text-gray-700">Usar tabla de precios por volumen global</label>
                        <p class="text-gray-500">Si desmarcas esta opción, podrás definir precios específicos después de guardar.</p>
                    </div>
                </div>
            </div>

            <div>
                <h3 class="text-lg font-semibold mb-3">Rangos de precios custom</h3>
                <p class="text-sm text-gray-500 mb-3">Si “Usar tabla global” está marcado, esta tabla se desactiva y no bloquea el guardado. Desmárcalo para editar precios personalizados.</p>
                ${renderPricingEditor(defaultTiers)}
            </div>

            <div class="flex justify-end gap-3 pt-4 border-t">
                <a href="/admin/products" class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300">Cancelar</a>
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Producto</button>
            </div>
        </form>
    </div>
  `));
});

adminRoutes.post("/products/new", async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    const filename = `prod-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    imageUrl = `/uploads/${filename}`;
  }

  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;

  const result = db.query(`
    INSERT INTO products (name, description, image_url, makerworld_url, filament_grams, print_time_mins, extra_costs, use_default_pricing, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.makerworld_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing) as {id: number};

  if (!useDefaultPricing) replaceProductPriceTiers(result.id, parsePriceTiers(body));

  return c.redirect(useDefaultPricing ? "/admin/products" : `/admin/products/${result.id}/edit`);
});

adminRoutes.post("/products/:id/delete", (c) => {
  const id = c.req.param("id");
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  return c.redirect("/admin/products");
});

// Helper route to just serve edit form
adminRoutes.get("/products/:id/edit", (c) => {
  const id = parseInt(c.req.param("id"));
  const product = getProduct(id);
  if (!product) return c.notFound();
  const productTiers = getProductPriceTiers(id);
  const tiers = productTiers.length ? productTiers : getDefaultPriceTiers();

  return c.html(AdminLayout("Editar Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Editar Producto: ${escapeHtml(product.name)}</h2>
        <form action="/admin/products/${id}/edit" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" value="${escapeHtml(product.name)}" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Link de MakerWorld (Opcional)</label>
                <input type="url" name="makerworld_url" value="${escapeHtml(product.makerworld_url || '')}" placeholder="https://makerworld.com/es/models/..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Filamento Requerido (Gramos)</label>
                    <input type="number" name="filament_grams" min="0" step="0.1" value="${product.filament_grams || 0}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Tiempo de Impresión (Minutos)</label>
                    <input type="number" name="print_time_mins" min="0" step="1" value="${product.print_time_mins || 0}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Costos Extra (NFC, argolla, etc. $ MXN)</label>
                    <input type="number" name="extra_costs" min="0" step="0.01" value="${product.extra_costs || 0}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
            </div>

            ${renderDescriptionField(product.description || '', 3)}

            <div>
                <label class="block text-sm font-medium text-gray-700">Imagen actual</label>
                ${product.image_url ? `<img src="${escapeHtml(product.image_url)}" class="h-32 object-contain mb-2 border p-1 rounded">` : '<p class="text-sm text-gray-500 mb-2">Sin imagen</p>'}
                <input type="text" name="image_url" value="${escapeHtml(product.image_url || '')}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                <input type="file" name="image_file" accept="image/*" class="block w-full text-sm text-gray-500">
                <p class="text-xs text-gray-500 mt-1">Sube una nueva para reemplazar la actual.</p>
            </div>

            <div>
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="use_default_pricing" name="use_default_pricing" type="checkbox" value="1" ${product.use_default_pricing ? 'checked' : ''} class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="use_default_pricing" class="font-medium text-gray-700">Usar tabla de precios por volumen global</label>
                    </div>
                </div>
            </div>

            <div>
                <h3 class="text-lg font-semibold mb-3">Rangos de precios custom</h3>
                <p class="text-sm text-gray-500 mb-3">Si “Usar tabla global” está marcado, esta tabla se desactiva y no bloquea el guardado. Desmárcalo para editar precios personalizados.</p>
                ${renderPricingEditor(tiers)}
            </div>

            <div class="flex justify-end gap-3 pt-4 border-t">
                <a href="/admin/products" class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300">Cancelar</a>
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Cambios</button>
            </div>
        </form>
    </div>
  `));
});

adminRoutes.post("/products/:id/edit", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    const filename = `prod-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    imageUrl = `/uploads/${filename}`;
  }

  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;

  db.run(`
    UPDATE products SET name = ?, description = ?, image_url = ?, makerworld_url = ?, filament_grams = ?, print_time_mins = ?, extra_costs = ?, use_default_pricing = ? WHERE id = ?
  `, [formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.makerworld_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing, id]);

  replaceProductPriceTiers(id, useDefaultPricing ? [] : parsePriceTiers(body));

  return c.redirect("/admin/products");
});

adminRoutes.get("/quotes/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const quote = getQuote(id);
  if (!quote) return c.notFound();

  const config = getConfig();
  const items = getQuoteItemsWithProducts(id);

  const itemsRows = items.map((item) => {
    const makerworldHtml = item.product_makerworld_url
      ? `<a href="${escapeHtml(item.product_makerworld_url)}" target="_blank" class="text-blue-600 hover:underline font-semibold flex items-center gap-1">
          MakerWorld ↗
         </a>`
      : `<span class="text-gray-400 italic text-xs">Sin enlace</span>`;

    const imgHtml = item.product_image_url
      ? `<img src="${escapeHtml(item.product_image_url)}" class="h-12 w-12 rounded object-cover border bg-gray-50">`
      : `<div class="h-12 w-12 rounded bg-gray-100 flex items-center justify-center text-gray-400 text-xs border">Sin img</div>`;

    return `
      <tr>
        <td class="px-6 py-4 whitespace-nowrap">${imgHtml}</td>
        <td class="px-6 py-4 whitespace-nowrap">
          <div class="text-sm font-medium text-gray-900">${escapeHtml(item.product_name)}</div>
        </td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${item.quantity}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">${money(item.unit_price)}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-semibold">${money(item.subtotal)}</td>
        <td class="px-6 py-4 whitespace-nowrap text-sm">${makerworldHtml}</td>
      </tr>
    `;
  }).join("");

  const defaultDelivery = `10 días hábiles para el envío por ${quote.shipping_provider || 'paquetería'} despues del pago del anticipo`;

  return c.html(AdminLayout(`Detalle Cotización #${quote.id}`, `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <a href="/admin/quotes" class="bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-md text-sm font-semibold transition-colors">
          ← Volver a lista
        </a>
        <h1 class="text-2xl font-bold text-gray-800">Detalle de Cotización: ${escapeHtml(quoteFolio(quote))}</h1>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="md:col-span-1 space-y-6">
          <div class="bg-white shadow rounded-lg p-6 space-y-4">
            <h2 class="text-lg font-bold text-gray-800 border-b pb-2">Información del Cliente</h2>
            <div>
              <span class="text-xs text-gray-500 block uppercase font-semibold">Cliente</span>
              <span class="text-sm font-medium text-gray-900">${escapeHtml(quote.customer_name)}</span>
            </div>
            <div>
              <span class="text-xs text-gray-500 block uppercase font-semibold">Código Postal</span>
              <span class="text-sm font-medium text-gray-900">${escapeHtml(quote.postal_code)}</span>
            </div>
            <div>
              <span class="text-xs text-gray-500 block uppercase font-semibold">Fecha Emisión</span>
              <span class="text-sm font-medium text-gray-900">${formatDate(quote.created_at)}</span>
            </div>
            <div>
              <span class="text-xs text-gray-500 block uppercase font-semibold">WhatsApp</span>
              <span class="text-sm font-medium text-gray-900">
                <a href="https://wa.me/${escapeHtml(quote.whatsapp_number || '')}" target="_blank" class="text-green-600 hover:underline font-semibold flex items-center gap-1 mt-1">
                  ${escapeHtml(quote.whatsapp_number || '')} ↗
                </a>
              </span>
            </div>
          </div>

          <div class="bg-white shadow rounded-lg p-6 space-y-4">
            <h2 class="text-lg font-bold text-gray-800 border-b pb-2">Estado de la Cotización</h2>
            <div class="flex items-center gap-2 justify-between">
              <span class="text-xs text-gray-500 uppercase font-semibold">Estado actual:</span>
              ${renderStatusBadge(quote.status)}
            </div>
            <div class="pt-3 border-t">
              <span class="text-xs text-gray-500 block uppercase font-semibold mb-3">Cambiar estado</span>
              <form action="/admin/quotes/${quote.id}/status" method="post" class="flex flex-col gap-2">
                <button type="submit" name="status" value="despachado" class="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-3 rounded text-xs transition-colors flex items-center justify-center gap-1.5 shadow-sm">
                  ✓ Marcar como Despachada
                </button>
                <button type="submit" name="status" value="no_despachado" class="w-full bg-yellow-500 hover:bg-yellow-600 text-white font-bold py-2 px-3 rounded text-xs transition-colors flex items-center justify-center gap-1.5 shadow-sm">
                  ⚠ Marcar como No Despachada
                </button>
                <button type="submit" name="status" value="spam" class="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-3 rounded text-xs transition-colors flex items-center justify-center gap-1.5 shadow-sm">
                  ✕ Marcar como Spam
                </button>
              </form>
            </div>
          </div>
        </div>

        <div class="bg-white shadow rounded-lg overflow-hidden md:col-span-2">
          <div class="px-6 py-4 border-b border-gray-200">
            <h2 class="text-lg font-bold text-gray-800">Productos Cotizados</h2>
          </div>
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Imagen</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Producto</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Cant</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unitario</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Total</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">MakerWorld</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              ${itemsRows}
            </tbody>
          </table>
          <div class="bg-gray-50 px-6 py-4 border-t border-gray-200 flex flex-col items-end space-y-1">
            <div class="text-sm text-gray-600">Subtotal: <span class="font-medium text-gray-900">${money(quote.subtotal)}</span></div>
            <div class="text-sm text-gray-600">Envío (${escapeHtml(quote.shipping_provider)}): <span class="font-medium text-gray-900">${quote.shipping_cost > 0 ? money(quote.shipping_cost) : "Gratis"}</span></div>
            <div class="text-base font-bold text-gray-900 border-t pt-1 w-48 text-right">Total: <span>${money(quote.grand_total)}</span></div>
          </div>
        </div>
      </div>

      <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-lg font-bold text-gray-800 border-b pb-3 mb-6">Generador de Documento PDF de Cotización</h2>
        <form action="/admin/quotes/${quote.id}/pdf" method="get" target="_blank" class="space-y-6">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label class="block text-sm font-semibold text-gray-700">Nombre del Emisor</label>
              <input type="text" name="emisor" value="${escapeHtml(config.company_name || 'JOSÉ FRANCISCO CASTILLO MARMOLEJO')}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">RFC Emisor</label>
              <input type="text" name="emisor_rfc" value="CAMF020607T76" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Correo Emisor</label>
              <input type="email" name="emisor_correo" value="francisco.castillo@pixkey3d.com" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Teléfono Emisor</label>
              <input type="text" name="emisor_telefono" value="496 126 6304" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div class="md:col-span-2">
              <label class="block text-sm font-semibold text-gray-700">Dirección Emisor</label>
              <input type="text" name="emisor_direccion" value="Av. Cuauhtémoc 620 Tequis, De Tequisquiapan, 78250 San Luis Potosí, S.L.P." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
          </div>

          <hr class="my-4">
          <h3 class="text-md font-bold text-gray-800">Condiciones comerciales</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="md:col-span-2">
              <label class="block text-sm font-semibold text-gray-700">Condiciones de entrega</label>
              <input type="text" name="cond_entrega" value="${escapeHtml(defaultDelivery)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Condiciones de pago</label>
              <input type="text" name="cond_pago" value="50% de anticipo y 50% al envio" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Condiciones pago prioritario</label>
              <input type="text" name="cond_prioritario" value="Unica exhibición" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Forma de pago</label>
              <input type="text" name="forma_pago" value="Transferencia Bancaria" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Lugar de Expedición</label>
              <input type="text" name="lugar_expedicion" value="${escapeHtml(quote.postal_code || '78250')}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
          </div>

          <hr class="my-4">
          <div class="border rounded-md bg-gray-50 p-4 space-y-4">
            <div class="flex items-center">
              <input type="checkbox" id="has_cargo_extra" name="has_cargo_extra" value="1" class="h-4 w-4 text-blue-600 border-gray-300 rounded">
              <label for="has_cargo_extra" class="ml-2 block text-sm font-bold text-gray-700">¿Agregar cargo extra / Zona Extendida?</label>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-4" id="cargo_extra_fields">
              <div>
                <label class="block text-xs font-semibold text-gray-600">Clave Cargo Extra</label>
                <input type="text" name="cargo_extra_clave" value="E-002" class="mt-1 block w-full px-2 py-1 border border-gray-300 rounded-md text-sm">
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-600">Descripción Cargo Extra</label>
                <input type="text" name="cargo_extra_desc" value="Zona Extendida Estafeta" class="mt-1 block w-full px-2 py-1 border border-gray-300 rounded-md text-sm">
              </div>
              <div>
                <label class="block text-xs font-semibold text-gray-600">Importe ($ MXN)</label>
                <input type="number" name="cargo_extra_importe" min="0" step="0.01" value="100.00" class="mt-1 block w-full px-2 py-1 border border-gray-300 rounded-md text-sm">
              </div>
            </div>
          </div>

          <div class="flex justify-end pt-4 border-t">
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-md font-bold shadow-md transition-colors flex items-center gap-2">
              <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Generar Documento de Cotización
            </button>
          </div>
        </form>
      </div>
    </div>
    <script>
      (() => {
        const checkbox = document.getElementById('has_cargo_extra');
        const container = document.getElementById('cargo_extra_fields');
        const toggle = () => {
          if (!checkbox || !container) return;
          const inputs = container.querySelectorAll('input');
          inputs.forEach(input => {
            input.disabled = !checkbox.checked;
          });
          container.style.opacity = checkbox.checked ? '1' : '0.4';
          container.style.pointerEvents = checkbox.checked ? 'auto' : 'none';
        };
        checkbox?.addEventListener('change', toggle);
        toggle();
      })();
    </script>
  `));
});

adminRoutes.post("/quotes/:id/status", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const status = formString(body.status);
  if (status) {
    updateQuoteStatus(id, status);
  }
  // When dispatching, go straight to the production pipeline
  if (status === "despachado") return c.redirect("/admin/production?tab=pagos");
  return c.redirect(`/admin/quotes/${id}`);
});

adminRoutes.get("/quotes/:id/pdf", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const quote = getQuote(id);
  if (!quote) return c.notFound();

  const items = getQuoteItemsWithProducts(id);

  // Read query parameters
  const emisor = c.req.query("emisor") || "JOSÉ FRANCISCO CASTILLO MARMOLEJO";
  const emisorRfc = c.req.query("emisor_rfc") || "CAMF020607T76";
  const emisorCorreo = c.req.query("emisor_correo") || "francisco.castillo@pixkey3d.com";
  const emisorTelefono = c.req.query("emisor_telefono") || "496 126 6304";
  const emisorDireccion = c.req.query("emisor_direccion") || "Av. Cuauhtémoc 620 Tequis, De Tequisquiapan, 78250 San Luis Potosí, S.L.P.";

  const condEntrega = c.req.query("cond_entrega") || "";
  const condPago = c.req.query("cond_pago") || "";
  const condPrioritario = c.req.query("cond_prioritario") || "";
  const formaPago = c.req.query("forma_pago") || "";
  const lugarExpedicion = c.req.query("lugar_expedicion") || "78250";

  const config = getConfig();
  const companyLogo = config.company_logo || "";

  const hasCargoExtra = c.req.query("has_cargo_extra") === "1";
  const cargoExtraClave = c.req.query("cargo_extra_clave") || "E-002";
  const cargoExtraDesc = c.req.query("cargo_extra_desc") || "Zona Extendida Estafeta";
  const cargoExtraImporte = parseFloat(c.req.query("cargo_extra_importe") || "0");

  let index = 1;
  const itemsHtml = items.map((item) => {
    const clave = `U-${String(index++).padStart(3, "0")}`;
    return `
      <tr class="border-b border-gray-200">
        <td class="px-2 py-1.5 text-center font-mono">${clave}</td>
        <td class="px-2 py-1.5">${escapeHtml(item.product_name)}</td>
        <td class="px-2 py-1.5 text-center">${item.quantity}</td>
        <td class="px-2 py-1.5 text-center">1${clave}</td>
        <td class="px-2 py-1.5 text-center">Pza</td>
        <td class="px-2 py-1.5 text-center">Pieza</td>
        <td class="px-2 py-1.5 text-right font-mono">${plainMoney(item.unit_price)}</td>
        <td class="px-2 py-1.5 text-right font-mono">0.00</td>
        <td class="px-2 py-1.5 text-right font-mono font-semibold">${plainMoney(item.subtotal)}</td>
      </tr>
    `;
  });

  // Shipping item (ONLY if cost > 0)
  if (quote.shipping_cost > 0) {
    const shippingClave = `E-001`;
    itemsHtml.push(`
      <tr class="border-b border-gray-200">
        <td class="px-2 py-1.5 text-center font-mono">${shippingClave}</td>
        <td class="px-2 py-1.5">Envio ${escapeHtml(quote.shipping_provider)}</td>
        <td class="px-2 py-1.5 text-center">1</td>
        <td class="px-2 py-1.5 text-center">1${shippingClave}</td>
        <td class="px-2 py-1.5 text-center">Servicio</td>
        <td class="px-2 py-1.5 text-center">Servicio</td>
        <td class="px-2 py-1.5 text-right font-mono">${plainMoney(quote.shipping_cost)}</td>
        <td class="px-2 py-1.5 text-right font-mono">0.00</td>
        <td class="px-2 py-1.5 text-right font-mono font-semibold">${plainMoney(quote.shipping_cost)}</td>
      </tr>
    `);
  }

  let totalAcumulado = quote.subtotal + quote.shipping_cost;

  if (hasCargoExtra && cargoExtraImporte > 0) {
    itemsHtml.push(`
      <tr class="border-b border-gray-200">
        <td class="px-2 py-1.5 text-center font-mono">${escapeHtml(cargoExtraClave)}</td>
        <td class="px-2 py-1.5">${escapeHtml(cargoExtraDesc)}</td>
        <td class="px-2 py-1.5 text-center">1</td>
        <td class="px-2 py-1.5 text-center">1${escapeHtml(cargoExtraClave)}</td>
        <td class="px-2 py-1.5 text-center">Servicio</td>
        <td class="px-2 py-1.5 text-center">Servicio</td>
        <td class="px-2 py-1.5 text-right font-mono">${plainMoney(cargoExtraImporte)}</td>
        <td class="px-2 py-1.5 text-right font-mono">0.00</td>
        <td class="px-2 py-1.5 text-right font-mono font-semibold">${plainMoney(cargoExtraImporte)}</td>
      </tr>
    `);
    totalAcumulado += cargoExtraImporte;
  }

  return c.html(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cotización ${escapeHtml(quoteFolio(quote))}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
          @media print {
            .no-print { display: none !important; }
            body { background: white; color: black; }
            .print-border { border: 1px solid #000 !important; }
          }
          body { font-family: system-ui, -apple-system, sans-serif; }
        </style>
    </head>
    <body class="bg-gray-100 min-h-screen p-4 sm:p-8">
        <div class="max-w-4xl mx-auto bg-white p-6 sm:p-10 shadow-lg rounded-lg print-border print:shadow-none print:p-0 print:rounded-none">
            <div class="flex items-center justify-between no-print border-b pb-4 mb-6">
              <a href="/admin/quotes/${quote.id}" class="bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded font-semibold text-sm transition-colors">
                ← Volver al detalle
              </a>
              <button onclick="window.print()" class="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded font-bold shadow text-sm transition-colors flex items-center gap-1.5">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Imprimir o Guardar como PDF
              </button>
            </div>

            <!-- Header Section matching sample -->
            <div class="flex flex-col sm:flex-row justify-between items-start gap-4 mb-8">
              <div class="flex items-start gap-4">
                ${companyLogo ? `<img src="${escapeHtml(companyLogo)}" alt="Logo" class="h-16 w-auto object-contain flex-shrink-0 print:h-14">` : ""}
                <div class="space-y-1">
                <h1 class="text-xl font-bold text-gray-900 tracking-tight uppercase">${escapeHtml(emisor)}</h1>
                <p class="text-xs text-gray-600 font-semibold">Correo: <span class="font-normal text-gray-900">${escapeHtml(emisorCorreo)}</span></p>
                <p class="text-xs text-gray-600 font-semibold">Teléfono: <span class="font-normal text-gray-900">${escapeHtml(emisorTelefono)}</span></p>
                <p class="text-xs text-gray-600 font-semibold max-w-xs leading-normal">Dirección: <span class="font-normal text-gray-900">${escapeHtml(emisorDireccion)}</span></p>
                </div>
              </div>
              <div class="text-right space-y-1 min-w-[200px]">
                <h2 class="text-2xl font-black text-gray-900 tracking-wide uppercase">COTIZACIÓN</h2>
                <p class="text-xs text-gray-600 font-semibold">RFC: <span class="font-bold text-gray-900">${escapeHtml(emisorRfc)}</span></p>
                <p class="text-sm font-bold text-red-600 bg-red-50 inline-block px-2.5 py-0.5 rounded border border-red-100 font-mono tracking-wide mt-1">${escapeHtml(quoteFolio(quote))}</p>
                <p class="text-xs text-gray-600 font-semibold mt-1">FECHA DE EMISIÓN: <span class="font-normal text-gray-900">${formatDate(quote.created_at)}</span></p>
              </div>
            </div>

            <!-- Client Info matching sample -->
            <div class="bg-gray-50 border border-gray-200 rounded p-4 mb-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <h3 class="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">CLIENTE</h3>
                <p class="text-sm text-gray-600 font-semibold">Nombre: <span class="font-bold text-gray-900 text-base">${escapeHtml(quote.customer_name)}</span></p>
              </div>
              <div class="sm:text-right">
                <p class="text-xs text-gray-600 font-semibold mt-4 sm:mt-0">Lugar de Expedición: <span class="font-bold text-gray-900">${escapeHtml(lugarExpedicion)}</span></p>
              </div>
            </div>

            <!-- Items Table exactly matching sample -->
            <div class="overflow-x-auto mb-6">
              <table class="min-w-full text-xs text-gray-700">
                <thead>
                  <tr class="bg-gray-100 border-t border-b border-gray-300 text-[10px] text-gray-500 uppercase font-bold">
                    <th class="px-2 py-2 text-center w-16">CLAVE</th>
                    <th class="px-2 py-2 text-left">DESCRIPCIÓN</th>
                    <th class="px-2 py-2 text-center w-12">CANT</th>
                    <th class="px-2 py-2 text-center w-16">CLAVE UNIDAD</th>
                    <th class="px-2 py-2 text-center w-16">UNIDAD</th>
                    <th class="px-2 py-2 text-center w-16">UNIDAD(Pieza)</th>
                    <th class="px-2 py-2 text-right w-24">P. UNITARIO(MAYOREO)</th>
                    <th class="px-2 py-2 text-right w-16">DESCUENTO</th>
                    <th class="px-2 py-2 text-right w-24">TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHtml.join("")}
                </tbody>
              </table>
            </div>

            <!-- Totals & Terms matching sample -->
            <div class="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
              <div class="md:col-span-7 space-y-3">
                <div class="space-y-1">
                  <p class="text-xs text-gray-600 font-semibold"><span class="text-gray-500 font-normal">Condiciones de entrega:</span> ${escapeHtml(condEntrega)}</p>
                  <p class="text-xs text-gray-600 font-semibold"><span class="text-gray-500 font-normal">Condiciones de pago:</span> ${escapeHtml(condPago)}</p>
                  <p class="text-xs text-gray-600 font-semibold"><span class="text-gray-500 font-normal">Condiciones de pago para pedido prioritario:</span> ${escapeHtml(condPrioritario)}</p>
                  <p class="text-xs text-gray-600 font-semibold"><span class="text-gray-500 font-normal">Forma de pago:</span> ${escapeHtml(formaPago)}</p>
                </div>
                <div class="border-t pt-2 mt-4">
                  <p class="text-xs text-gray-600 font-semibold uppercase">Importe con letra: <span class="font-bold text-gray-900" id="grand-total-letters">...</span></p>
                </div>
              </div>

              <div class="md:col-span-5 border border-gray-200 rounded p-4 bg-gray-50 space-y-2 text-sm font-semibold text-gray-700">
                <div class="flex justify-between">
                  <span class="text-gray-500 font-normal">Subtotal:</span>
                  <span class="font-mono">${plainMoney(quote.subtotal)}</span>
                </div>
                ${quote.shipping_cost > 0 ? `
                <div class="flex justify-between">
                  <span class="text-gray-500 font-normal">Envío:</span>
                  <span class="font-mono">${plainMoney(quote.shipping_cost)}</span>
                </div>
                ` : ""}
                ${hasCargoExtra && cargoExtraImporte > 0 ? `
                <div class="flex justify-between">
                  <span class="text-gray-500 font-normal">Cargo Extra:</span>
                  <span class="font-mono">${plainMoney(cargoExtraImporte)}</span>
                </div>
                ` : ""}
                <div class="flex justify-between text-base font-black text-gray-900 border-t pt-2 mt-2">
                  <span>TOTAL:</span>
                  <span class="font-mono text-red-600">$${plainMoney(totalAcumulado)} MXN</span>
                </div>
              </div>
            </div>
        </div>

        <script>
          (() => {
            function numeroALetras(num) {
              var data = {
                numero: num,
                enteros: Math.floor(num),
                centavos: Math.round(((num - Math.floor(num)) * 100)),
                letrasCentavos: '',
                letrasEnteros: ''
              };

              if (data.centavos < 10) {
                data.letrasCentavos = '0' + data.centavos + '/100 M.N.';
              } else {
                data.letrasCentavos = data.centavos + '/100 M.N.';
              }

              if (data.enteros == 0) {
                return 'CERO PESOS ' + data.letrasCentavos;
              }

              function Millones(num) {
                if (num >= 1000000) {
                  var millones = Math.floor(num / 1000000);
                  var resto = num % 1000000;
                  var strMillones = '';
                  if (millones === 1) {
                    strMillones = 'UN MILLÓN';
                  } else {
                    strMillones = TresCifras(millones) + ' MILLONES';
                  }
                  if (resto > 0) {
                    return strMillones + ' ' + Miles(resto);
                  }
                  return strMillones + ' DE';
                }
                return Miles(num);
              }

              function Miles(num) {
                if (num >= 1000) {
                  var miles = Math.floor(num / 1000);
                  var resto = num % 1000;
                  var strMiles = '';
                  if (miles === 1) {
                    strMiles = 'MIL';
                  } else {
                    strMiles = TresCifras(miles) + ' MIL';
                  }
                  if (resto > 0) {
                    return strMiles + ' ' + TresCifras(resto);
                  }
                  return strMiles;
                }
                return TresCifras(num);
              }

              function TresCifras(num) {
                var centenas = Math.floor(num / 100);
                var decenas = num % 100;
                var str = '';

                if (centenas > 0) {
                  if (centenas === 1 && decenas > 0) {
                    str = 'CIENTO';
                  } else {
                    var cent = ['CERO', 'CIEN', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SIETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
                    str = cent[centenas];
                  }
                }

                if (decenas > 0) {
                  if (str !== '') str += ' ';
                  str += DosCifras(decenas);
                }

                return str;
              }

              function DosCifras(num) {
                if (num < 10) {
                  var un = ['CERO', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
                  return un[num];
                }
                if (num >= 10 && num < 20) {
                  var esp = {
                    10: 'DIEZ', 11: 'ONCE', 12: 'DOCE', 13: 'TRECE', 14: 'CATORCE', 15: 'QUINCE',
                    16: 'DIECISÉIS', 17: 'DIECISIETE', 18: 'DIECIOCHO', 19: 'DIECINUEVE'
                  };
                  return esp[num];
                }
                if (num >= 20 && num < 30) {
                  if (num === 20) return 'VEINTE';
                  var un = ['CERO', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
                  return 'VEINTI' + un[num - 20];
                }
                
                var decena = Math.floor(num / 10);
                var unidad = num % 10;
                var decs = ['CERO', 'DIEZ', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
                var str = decs[decena];
                if (unidad > 0) {
                  var un = ['CERO', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE'];
                  str += ' Y ' + un[unidad];
                }
                return str;
              }

              data.letrasEnteros = Millones(data.enteros);
              return (data.letrasEnteros + ' PESOS ' + data.letrasCentavos).replace(/\s+/g, ' ').trim();
            }

            const total = ${totalAcumulado};
            const label = document.getElementById('grand-total-letters');
            if (label) {
              label.textContent = numeroALetras(total);
            }
          })();
        </script>
    </body>
    </html>
  `);
});


// Production Settings view and controllers
adminRoutes.get("/production-settings", (c) => {
  const printers = getPrinters();
  const filaments = getFilaments();

  return c.html(AdminLayout("Ajustes de Producción", `
    <div class="space-y-6">
      <div class="flex items-center justify-between border-b pb-4">
        <h1 class="text-2xl font-bold text-gray-800">Ajustes de Producción</h1>
        <p class="text-sm text-gray-500">Agrega tus impresoras 3D y filamentos para calcular consumos y programar la producción.</p>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Printers Card -->
        <div class="bg-white shadow rounded-lg p-6 space-y-6">
          <div>
            <h2 class="text-lg font-bold text-gray-800">Impresoras 3D</h2>
            <p class="text-xs text-gray-500 mt-0.5">Define el costo de electricidad por hora de funcionamiento.</p>
          </div>

          <form action="/admin/production-settings/printers" method="post" class="bg-gray-50 border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div class="sm:col-span-2">
              <label class="block text-xs font-bold text-gray-700">Nombre / Modelo *</label>
              <input type="text" name="name" required placeholder="Ej: Ender 3, Bambu P1S" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Costo Luz/Hora ($ MXN) *</label>
              <input type="number" name="power_cost" required min="0" step="0.01" value="1.50" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Costo Mensual ($ MXN)</label>
              <input type="number" name="monthly_cost" min="0" step="0.01" value="0" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Impresiones / Mes</label>
              <input type="number" name="prints_per_month" min="1" step="1" value="30" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div class="sm:col-span-2 flex justify-end">
              <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-4 py-2 rounded shadow-sm">
                + Agregar Impresora
              </button>
            </div>
          </form>
          <p class="text-[10px] text-gray-400">Costo por impresión = Costo Mensual ÷ Impresiones/Mes. Se suma al costo de producción de cada trabajo.</p>

          <div class="overflow-x-auto border rounded-lg">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Nombre</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Luz/Hora</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Mensual</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Impr./Mes</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">$/Impresión</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200">
                ${printers.map(p => {
                  const costPerPrint = p.prints_per_month > 0 ? p.monthly_cost / p.prints_per_month : 0;
                  return `
                  <tr>
                    <td class="px-3 py-2 font-medium">${escapeHtml(p.name)}</td>
                    <td class="px-3 py-2 font-mono">${money(p.power_cost_per_hour)}</td>
                    <td class="px-3 py-2 font-mono">${money(p.monthly_cost)}</td>
                    <td class="px-3 py-2 text-center">${p.prints_per_month}</td>
                    <td class="px-3 py-2 font-mono font-bold text-blue-700">${money(costPerPrint)}</td>
                    <td class="px-3 py-2 text-right">
                      <form action="/admin/production-settings/printers/${p.id}/delete" method="post" onsubmit="return confirm('¿Seguro que deseas eliminar esta impresora?');" class="inline">
                        <button type="submit" class="text-red-600 hover:underline text-xs font-semibold">Eliminar</button>
                      </form>
                    </td>
                  </tr>
                `;}).join("")}
                ${printers.length === 0 ? '<tr><td colspan="6" class="px-4 py-6 text-center text-gray-400">No hay impresoras agregadas.</td></tr>' : ""}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Filaments Card -->
        <div class="bg-white shadow rounded-lg p-6 space-y-6">
          <div>
            <h2 class="text-lg font-bold text-gray-800">Filamentos</h2>
            <p class="text-xs text-gray-500 mt-0.5">Define el costo de tus bobinas por kilogramo.</p>
          </div>

          <form action="/admin/production-settings/filaments" method="post" class="bg-gray-50 border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
            <div>
              <label class="block text-xs font-bold text-gray-700">Color / Material *</label>
              <input type="text" name="color" required placeholder="Ej: PLA Negro, PETG Rojo" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Precio/Kg ($ MXN) *</label>
              <input type="number" name="price" required min="0" step="0.01" value="380.00" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-700">Stock Actual (gramos) *</label>
              <input type="number" name="stock_grams" required min="0" step="0.1" value="1000" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            </div>
            <div class="sm:col-span-3 flex justify-end">
              <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-4 py-2 rounded shadow-sm">
                + Agregar Filamento
              </button>
            </div>
          </form>
          <p class="text-[10px] text-gray-400">El stock se resta automáticamente al guardar la planificación de cada trabajo de impresión.</p>

          <div class="overflow-x-auto border rounded-lg">
            <table class="min-w-full divide-y divide-gray-200 text-sm">
              <thead class="bg-gray-50">
                <tr>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Color / Material</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Precio / Kg</th>
                  <th class="px-3 py-2 text-left font-semibold text-gray-500">Stock</th>
                  <th class="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-200">
                ${filaments.map(f => {
                  const stockPct = Math.min(100, (f.stock_grams / 1000) * 100);
                  const stockColor = f.stock_grams < 100 ? 'bg-red-500' : f.stock_grams < 300 ? 'bg-yellow-500' : 'bg-green-500';
                  return `
                  <tr>
                    <td class="px-3 py-2 font-medium">${escapeHtml(f.color)}</td>
                    <td class="px-3 py-2 font-mono">${money(f.price_per_kg)}</td>
                    <td class="px-3 py-2">
                      <div class="flex items-center gap-2">
                        <div class="w-20 bg-gray-200 rounded-full h-2">
                          <div class="${stockColor} h-2 rounded-full" style="width: ${stockPct}%"></div>
                        </div>
                        <span class="font-mono text-xs ${f.stock_grams < 100 ? 'text-red-600 font-bold' : ''}">${f.stock_grams.toFixed(0)}g</span>
                      </div>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <form action="/admin/production-settings/filaments/${f.id}/delete" method="post" onsubmit="return confirm('¿Seguro que deseas eliminar este filamento?');" class="inline">
                        <button type="submit" class="text-red-600 hover:underline text-xs font-semibold">Eliminar</button>
                      </form>
                    </td>
                  </tr>
                `;}).join("")}
                ${filaments.length === 0 ? '<tr><td colspan="4" class="px-4 py-6 text-center text-gray-400">No hay filamentos agregados.</td></tr>' : ""}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `));
});

adminRoutes.post("/production-settings/printers", async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const name = formString(body.name).trim();
  const powerCost = parseFloat(formString(body.power_cost)) || 0;
  const monthlyCost = parseFloat(formString(body.monthly_cost)) || 0;
  const printsPerMonth = parseInt(formString(body.prints_per_month), 10) || 1;
  if (name) {
    createPrinter(name, powerCost, monthlyCost, printsPerMonth);
  }
  return c.redirect("/admin/production-settings");
});

adminRoutes.post("/production-settings/printers/:id/delete", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  deletePrinter(id);
  return c.redirect("/admin/production-settings");
});

adminRoutes.post("/production-settings/filaments", async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const color = formString(body.color).trim();
  const price = parseFloat(formString(body.price)) || 0;
  const stockGrams = parseFloat(formString(body.stock_grams)) || 1000;
  if (color) {
    createFilament(color, price, stockGrams);
  }
  return c.redirect("/admin/production-settings");
});

adminRoutes.post("/production-settings/filaments/:id/delete", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  deleteFilament(id);
  return c.redirect("/admin/production-settings");
});

// Production pipeline/dashboard view
adminRoutes.get("/production", (c) => {
  const currentTab = c.req.query("tab") || "pagos";
  const quotes = getQuotes(100);
  const printers = getPrinters();
  const filaments = getFilaments();

  // Filter based on production tab
  const unpaidQuotes = quotes.filter((q) => q.status === "despachado");
  const activeQuotes = quotes.filter((q) => q.status === "produccion");
  const finishedQuotes = quotes.filter((q) => q.status === "finalizado");

  let activeList = unpaidQuotes;
  if (currentTab === "produccion") activeList = activeQuotes;
  if (currentTab === "finalizadas") activeList = finishedQuotes;

  const formatPrintTime = (totalMins: number) => {
    if (totalMins <= 0) return "0 min";
    const days = Math.floor(totalMins / (24 * 60));
    const hours = Math.floor((totalMins % (24 * 60)) / 60);
    const mins = totalMins % 60;
    return [
      days > 0 ? `${days}d` : "",
      hours > 0 ? `${hours}h` : "",
      mins > 0 ? `${mins}m` : ""
    ].filter(Boolean).join(" ");
  };

  const cardsHtml = activeList.map((quote) => {
    const items = getQuoteItemsWithProducts(quote.id);
    
    // Calculate totals for scheduling
    let totalGrams = 0;
    let totalMins = 0;
    let totalExtraCosts = 0;
    const itemsListHtml = items.map((item) => {
      const g = item.product_filament_grams || 0;
      const t = item.product_print_time_mins || 0;
      const e = item.product_extra_costs || 0;
      totalGrams += item.quantity * g;
      totalMins += item.quantity * t;
      totalExtraCosts += item.quantity * e;

      return `
        <div class="text-xs text-gray-700 bg-gray-50 border rounded p-2 flex justify-between items-center">
          <div>
            <span class="font-bold text-gray-900">${escapeHtml(item.product_name)}</span> (x${item.quantity})
            <div class="text-gray-500 font-medium mt-0.5">${g}g · ${t}m por pza · extra: ${money(e)}</div>
          </div>
          <div class="text-right">
            <div class="font-semibold text-gray-800">${g * item.quantity}g · ${formatPrintTime(t * item.quantity)}</div>
          </div>
        </div>
      `;
    }).join("");

    // Delivery time associated
    const deliveryCondition = items.find((item) => item.delivery_time)?.delivery_time || "A convenir";

    // Power cost calc
    const activePrinter = printers.find((p) => p.id === quote.printer_id);
    const powerCost = activePrinter ? (totalMins / 60) * activePrinter.power_cost_per_hour : 0;
    const printerCostPerPrint = activePrinter && activePrinter.prints_per_month > 0 ? activePrinter.monthly_cost / activePrinter.prints_per_month : 0;

    // Filament cost now calculated per-card from quote_filaments table (see produccion block)

    let contentCard = "";
    if (quote.status === "despachado") {
      contentCard = `
        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mt-4 space-y-3">
          <div class="text-xs text-yellow-800 font-bold uppercase tracking-wider flex items-center gap-1">
            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Esperando Comprobante de Pago
          </div>
          <form action="/admin/production/${quote.id}/proof" method="post" enctype="multipart/form-data" class="flex flex-col sm:flex-row gap-2.5 items-end sm:items-center">
            <div class="flex-1 w-full">
              <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Subir Imagen del Comprobante *</label>
              <input type="file" name="payment_proof" accept="image/*" required class="block w-full text-xs text-gray-500 bg-white border border-gray-300 rounded p-1">
            </div>
            <button type="submit" class="bg-green-600 hover:bg-green-700 text-white font-bold text-xs px-4 py-2.5 rounded shadow-sm whitespace-nowrap w-full sm:w-auto transition-colors">
              Iniciar Producción
            </button>
          </form>
        </div>
      `;
    } else if (quote.status === "produccion") {
      const printerOptions = printers.map((p) => `<option value="${p.id}" ${p.id === quote.printer_id ? "selected" : ""}>${escapeHtml(p.name)} (${money(p.power_cost_per_hour)}/hr)</option>`).join("");
      const filamentOptionsHtml = filaments.map((f) => `<option value="${f.id}" data-price="${f.price_per_kg}">${escapeHtml(f.color)} (${money(f.price_per_kg)}/Kg)</option>`).join("");

      // Get saved filaments for this quote
      const quoteFilaments = getQuoteFilaments(quote.id);

      // Calculate filament cost from saved multi-filament data
      const filamentCostFromEntries = quoteFilaments.reduce((sum, qf) => sum + (qf.grams_used / 1000) * qf.price_per_kg, 0);
      const totalAssignedGrams = quoteFilaments.reduce((sum, qf) => sum + qf.grams_used, 0);

      // Build existing filament rows
      const existingFilamentRows = quoteFilaments.length > 0
        ? quoteFilaments.map((qf) => `
          <div class="filament-row flex items-center gap-2">
            <select name="filament_ids" class="filament-select flex-1 border border-gray-300 rounded p-1.5 text-xs bg-white">
              <option value="">-- Filamento --</option>
              ${filaments.map((f) => `<option value="${f.id}" data-price="${f.price_per_kg}" ${f.id === qf.filament_id ? "selected" : ""}>${escapeHtml(f.color)} (${money(f.price_per_kg)}/Kg)</option>`).join("")}
            </select>
            <input type="number" name="filament_grams" value="${qf.grams_used}" step="0.1" min="0" placeholder="Gramos" class="w-24 border border-gray-300 rounded p-1.5 text-xs bg-white">
            <span class="text-[10px] text-gray-400">g</span>
            <button type="button" onclick="this.closest('.filament-row').remove()" class="text-red-400 hover:text-red-600 text-sm font-bold px-1" title="Quitar">&times;</button>
          </div>
        `).join("")
        : `
          <div class="filament-row flex items-center gap-2">
            <select name="filament_ids" class="filament-select flex-1 border border-gray-300 rounded p-1.5 text-xs bg-white">
              <option value="">-- Filamento --</option>
              ${filamentOptionsHtml}
            </select>
            <input type="number" name="filament_grams" value="" step="0.1" min="0" placeholder="Gramos" class="w-24 border border-gray-300 rounded p-1.5 text-xs bg-white">
            <span class="text-[10px] text-gray-400">g</span>
            <button type="button" onclick="this.closest('.filament-row').remove()" class="text-red-400 hover:text-red-600 text-sm font-bold px-1" title="Quitar">&times;</button>
          </div>
        `;

      const formId = `sched-${quote.id}`;

      contentCard = `
        <div class="grid grid-cols-1 xl:grid-cols-3 gap-4 border-t pt-4 mt-4">
          <!-- Left side scheduling inputs -->
          <form id="${formId}" action="/admin/production/${quote.id}/schedule" method="post" class="xl:col-span-2 space-y-4">
            <h4 class="text-xs font-bold text-gray-500 uppercase tracking-wider">Planificador de Impresión</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="block text-[10px] font-bold text-gray-600 uppercase mb-1">Impresora 3D</label>
                <select name="printer_id" class="block w-full border border-gray-300 rounded p-1.5 text-xs bg-white">
                  <option value="">-- No seleccionada --</option>
                  ${printerOptions}
                </select>
              </div>
              <div>
                <label class="block text-[10px] font-bold text-gray-600 uppercase mb-1">Inicio de Impresión</label>
                <input type="datetime-local" name="scheduled_start" value="${quote.scheduled_start || ''}" class="block w-full border border-gray-300 rounded p-1.5 text-xs bg-white">
              </div>
            </div>

            <!-- Multi-filament section -->
            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="text-[10px] font-bold text-gray-600 uppercase">Filamentos Utilizados</label>
                <button type="button" onclick="addFilamentRow_${quote.id}()" class="text-[10px] font-bold text-blue-600 hover:text-blue-800 flex items-center gap-0.5">
                  <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
                  Agregar Color
                </button>
              </div>
              <div id="filament-list-${quote.id}" class="space-y-2">
                ${existingFilamentRows}
              </div>
              <div class="text-[10px] text-gray-400 mt-1">Peso total estimado del pedido: <strong>${totalGrams.toFixed(1)} g</strong></div>
            </div>

            <div class="flex justify-between items-center gap-3">
              ${quote.payment_proof_url ? `
                <a href="${escapeHtml(quote.payment_proof_url)}" target="_blank" class="text-xs font-bold text-blue-600 hover:underline flex items-center gap-1">
                  <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  Ver Comprobante de Pago ↗
                </a>
              ` : ""}
              <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-4 py-2 rounded transition-colors shadow-sm">
                Guardar Planificación
              </button>
            </div>
          </form>
          <template id="filament-tpl-${quote.id}">
            <div class="filament-row flex items-center gap-2">
              <select name="filament_ids" class="filament-select flex-1 border border-gray-300 rounded p-1.5 text-xs bg-white">
                <option value="">-- Filamento --</option>
                ${filamentOptionsHtml}
              </select>
              <input type="number" name="filament_grams" value="" step="0.1" min="0" placeholder="Gramos" class="w-24 border border-gray-300 rounded p-1.5 text-xs bg-white">
              <span class="text-[10px] text-gray-400">g</span>
              <button type="button" onclick="this.closest('.filament-row').remove()" class="text-red-400 hover:text-red-600 text-sm font-bold px-1" title="Quitar">&times;</button>
            </div>
          </template>
          <script>
            function addFilamentRow_${quote.id}() {
              var tpl = document.getElementById('filament-tpl-${quote.id}');
              var clone = tpl.content.cloneNode(true);
              document.getElementById('filament-list-${quote.id}').appendChild(clone);
            }
          </script>

          <!-- Right side calculations list -->
          <div class="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2.5 text-xs">
            <h4 class="font-bold text-gray-800 border-b pb-1 mb-2">Métricas y Costos Estimados</h4>
            <div class="flex justify-between">
              <span class="text-gray-500">Mínimo (Impresión):</span>
              <span class="font-bold text-gray-900">${formatPrintTime(totalMins)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">Máximo (Tiempos de Entrega):</span>
              <span class="font-bold text-blue-800">${escapeHtml(deliveryCondition)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">Peso Total Filamento (estimado):</span>
              <span class="font-semibold">${totalGrams.toFixed(1)} g</span>
            </div>
            ${totalAssignedGrams > 0 ? `
              <div class="flex justify-between">
                <span class="text-gray-500">Filamento Asignado:</span>
                <span class="font-semibold text-blue-700">${totalAssignedGrams.toFixed(1)} g</span>
              </div>
            ` : ""}
            ${quoteFilaments.length > 0 ? quoteFilaments.map((qf) => `
              <div class="flex justify-between pl-2 text-gray-400">
                <span>${escapeHtml(qf.color)}:</span>
                <span>${qf.grams_used.toFixed(1)} g → ${money((qf.grams_used / 1000) * qf.price_per_kg)}</span>
              </div>
            `).join("") : ""}
            <div class="flex justify-between pt-1 border-t border-dashed">
              <span class="text-gray-500">Costo Filamento:</span>
              <span>${money(filamentCostFromEntries)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-500">Costo Luz:</span>
              <span>${money(powerCost)}</span>
            </div>
            ${printerCostPerPrint > 0 ? `
            <div class="flex justify-between">
              <span class="text-gray-500">Costo Impresora/Impresión:</span>
              <span>${money(printerCostPerPrint)}</span>
            </div>
            ` : ""}
            <div class="flex justify-between">
              <span class="text-gray-500">Costos Extra:</span>
              <span>${money(totalExtraCosts)}</span>
            </div>
            <div class="flex justify-between pt-2 border-t font-bold">
              <span class="text-gray-700">Total Costo Producción:</span>
              <span class="text-blue-800">${money(powerCost + printerCostPerPrint + filamentCostFromEntries + totalExtraCosts)}</span>
            </div>
          </div>
        </div>
      `;
    }

    const whatsappNum = escapeHtml(quote.whatsapp_number || '');
    const whatsappLink = quote.whatsapp_number ? '<a href="https://wa.me/' + whatsappNum + '" target="_blank" class="text-green-600 hover:underline text-xs font-semibold">&#128241; ' + whatsappNum + '</a>' : '<span class="text-xs text-gray-400">Sin WhatsApp</span>';

    return `
      <div class="bg-white shadow rounded-lg border overflow-hidden">
        <div class="p-4 flex flex-col sm:flex-row sm:items-start justify-between gap-3 bg-gray-50 border-b">
          <div class="space-y-0.5">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span class="font-bold text-gray-800 bg-gray-200 px-2 py-0.5 rounded font-mono">${quoteFolio(quote)}</span>
              <a href="/admin/quotes/${quote.id}" class="text-blue-600 hover:underline font-semibold">Ver cotizaci&#243;n &#8599;</a>
              <a href="/admin/quotes/${quote.id}/pdf" target="_blank" class="text-blue-600 hover:underline font-semibold">PDF &#8599;</a>
            </div>
            <div class="font-bold text-gray-900">${escapeHtml(quote.customer_name)}</div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span>${formatDate(quote.created_at)}</span>
              <span>&middot;</span>
              ${whatsappLink}
            </div>
          </div>
          <div class="text-right shrink-0">
            <div class="text-lg font-bold text-gray-900">${money(quote.grand_total)}</div>
            <div class="text-xs text-gray-500">${quote.total_pieces} pzas</div>
            <div class="text-xs text-gray-400">Subtotal: ${money(quote.subtotal)}</div>
            ${quote.shipping_cost > 0 ? '<div class="text-xs text-gray-400">Env&iacute;o: ' + money(quote.shipping_cost) + '</div>' : '<div class="text-xs text-green-600 font-semibold">Env&iacute;o Gratis</div>'}
          </div>
        </div>
        <div class="p-4 space-y-3">
          <div class="space-y-1.5">${itemsListHtml}</div>
          ${contentCard}
          ${quote.status === "finalizado" ? `
            <div class="pt-3 border-t flex justify-end">
              <span class="text-xs text-green-700 font-bold bg-green-50 border border-green-200 px-3 py-1 rounded-full">&#10003; Finalizada</span>
            </div>
          ` : `
            <div class="pt-3 border-t flex justify-end">
              <form action="/admin/production/${quote.id}/finish" method="post" onsubmit="return confirm('&#191;Marcar como finalizada?')">
                <button type="submit" class="bg-green-600 hover:bg-green-700 text-white font-bold text-xs px-4 py-2 rounded shadow-sm transition-colors">
                  Marcar Finalizada
                </button>
              </form>
            </div>
          `}
        </div>
      </div>
    `;
  }).join("");

  return c.html(AdminLayout("Tubería de Producción", `
    <div class="space-y-6">
      <div class="flex items-center justify-between border-b pb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Tubería de Producción (Tasklist)</h1>
          <p class="text-sm text-gray-500 mt-0.5">Controla y planifica los trabajos de impresión 3D a partir de cotizaciones despachadas.</p>
        </div>
        <a href="/admin/production-settings" class="bg-gray-100 hover:bg-gray-200 text-gray-700 border px-4 py-2 rounded-md text-sm font-semibold transition-colors">
          ⚙ Ajustes de Impresoras/Bobinas
        </a>
      </div>

      <div class="flex border-b border-gray-200 mb-6 bg-gray-50 p-1.5 rounded-lg gap-1.5 max-w-xl">
        <a href="/admin/production?tab=pagos" class="px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${currentTab === 'pagos' ? 'bg-yellow-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">
          Pendientes de Pago
          <span class="h-4 w-4 rounded-full bg-white text-yellow-800 flex items-center justify-center text-[10px]">${unpaidQuotes.length}</span>
        </a>
        <a href="/admin/production?tab=produccion" class="px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${currentTab === 'produccion' ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">
          En Impresión
          <span class="h-4 w-4 rounded-full bg-white text-blue-800 flex items-center justify-center text-[10px]">${activeQuotes.length}</span>
        </a>
        <a href="/admin/production?tab=finalizadas" class="px-4 py-2 text-xs font-bold rounded-md transition-all flex items-center gap-1.5 ${currentTab === 'finalizadas' ? 'bg-green-600 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-200'}">
          Finalizadas
          <span class="h-4 w-4 rounded-full bg-white text-green-800 flex items-center justify-center text-[10px]">${finishedQuotes.length}</span>
        </a>
      </div>

      <div class="space-y-6">
        ${cardsHtml || `
          <div class="bg-white shadow rounded-lg p-10 text-center border">
            <svg class="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
            </svg>
            <h3 class="mt-2 text-sm font-bold text-gray-900">Tubería vacía</h3>
            <p class="mt-1 text-xs text-gray-500">No hay cotizaciones registradas en este estado.</p>
          </div>
        `}
      </div>
    </div>
  `));
});

// Production proof and schedule actions
adminRoutes.post("/production/:id/proof", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const file = formFile(body.payment_proof);
  if (file) {
    const fileUrl = await saveUpload(file, "payments", "proof");
    updateQuotePaymentProof(id, fileUrl);
  }
  return c.redirect("/admin/production?tab=produccion");
});

adminRoutes.post("/production/:id/schedule", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  const printerId = parseInt(formString(body.printer_id), 10) || null;
  const scheduledStart = formString(body.scheduled_start) || null;

  // Parse multi-filament entries
  const filamentIds = formStringArray(body.filament_ids);
  const filamentGrams = formStringArray(body.filament_grams);
  const entries: { filament_id: number; grams_used: number }[] = [];
  for (let i = 0; i < filamentIds.length; i++) {
    const fId = parseInt(filamentIds[i], 10);
    const grams = parseFloat(filamentGrams[i] || "0");
    if (fId && grams > 0) {
      entries.push({ filament_id: fId, grams_used: grams });
    }
  }

  // Restore stock from previous filament assignments before replacing
  const previousFilaments = getQuoteFilaments(id);
  for (const pf of previousFilaments) {
    subtractFilamentStock(pf.filament_id, -pf.grams_used); // negative = add back
  }

  updateQuoteScheduler(id, printerId, scheduledStart);
  replaceQuoteFilaments(id, entries);

  // Subtract stock for new filament assignments
  for (const entry of entries) {
    subtractFilamentStock(entry.filament_id, entry.grams_used);
  }

  return c.redirect("/admin/production?tab=produccion");
});

adminRoutes.post("/production/:id/finish", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  updateQuoteStatus(id, "finalizado");
  return c.redirect("/admin/production?tab=finalizadas");
});

export { adminRoutes };
