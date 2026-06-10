import { join } from "path";
import * as fs from "fs";
import { llmConfig, settingValue, parseLlmError, parseLlmContent, trimToWordLimit } from "./llm";
import { callImageEditProvider, type ImageEnhanceResult } from "./image-enhance";
import { urlToDataUrl, resolveUploadPath } from "./images";
import type { Category, Subcategory } from "../db/schema";

export type CategorySuggestion =
  | { match: "existing"; id: number; name: string }
  | { match: "new"; name: string }
  | null;

export type SubcategorySuggestion =
  | { match: "existing"; id: number; name: string }
  | { match: "new"; name: string }
  | null;

export type AdaptedDescriptionResult = {
  description: string;
  category: CategorySuggestion;
  subcategory: SubcategorySuggestion;
};

export const DEFAULT_CATALOG_DESCRIPTION_PROMPT = "Reescribe la descripción para una tarjeta de producto de catálogo. Debe caber debajo de la imagen, antes de la tabla de precios. Un solo párrafo corto, comercial, descriptivo, que invite a comprar sin exagerar. Mantente fiel a la información original.";

const findBalancedJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
};

const tryExtractJsonObject = (raw: string): any | null => {
  const ZERO_WIDTH = /[﻿​‌‍⁠]/g;
  raw = raw.replace(ZERO_WIDTH, "");
  const cleaned = raw.trim();
  if (!cleaned) return null;

  try { return JSON.parse(cleaned); } catch {}

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  const candidate = findBalancedJsonObject(cleaned);
  if (candidate) {
    try { return JSON.parse(candidate); } catch {}
  }

  return null;
};

export const parseAdaptedJson = (raw: string, categories: Category[], subcategories: Subcategory[] = []): AdaptedDescriptionResult => {
  const parsed = tryExtractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") {
    console.warn("[LLM description/adapt] No se pudo extraer JSON del raw. Cae al fallback (raw como descripción).", { rawPreview: raw.slice(0, 300) });
    return { description: raw.trim(), category: null, subcategory: null };
  }
  const desc = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!desc) {
    console.warn("[LLM description/adapt] JSON parseado pero sin 'description' string. Cae al fallback.", { parsedKeys: Object.keys(parsed), rawPreview: raw.slice(0, 300) });
    return { description: raw.trim(), category: null, subcategory: null };
  }
  const catRaw = parsed.category;
  let category: CategorySuggestion = null;
  if (catRaw && typeof catRaw === "object") {
    const match = catRaw.match;
    if (match === "existing") {
      const id = Number.parseInt(String(catRaw.id), 10);
      if (Number.isFinite(id)) {
        const found = categories.find((c) => c.id === id);
        if (found) category = { match: "existing", id: found.id, name: found.name };
        else console.warn("[LLM description/adapt] match=existing pero id no existe en la DB; sugerencia descartada", { id, availableIds: categories.map((c) => c.id) });
      }
    } else if (match === "new") {
      const name = typeof catRaw.name === "string" ? catRaw.name.trim() : "";
      if (name) {
        const existing = categories.find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
        if (existing) category = { match: "existing", id: existing.id, name: existing.name };
        else category = { match: "new", name };
      }
    }
  }

  const subRaw = parsed.subcategory;
  let subcategory: SubcategorySuggestion = null;
  if (category && subRaw && typeof subRaw === "object") {
    const categorySubs = category.match === "existing"
      ? subcategories.filter((s) => s.category_id === category.id)
      : [];
    const match = subRaw.match;
    if (match === "existing" && category.match === "existing") {
      const id = Number.parseInt(String(subRaw.id), 10);
      if (Number.isFinite(id)) {
        const found = categorySubs.find((s) => s.id === id);
        if (found) subcategory = { match: "existing", id: found.id, name: found.name };
        else console.warn("[LLM description/adapt] subcategoría match=existing pero id no pertenece a la categoría; descartada", { id, categoryId: category.id });
      }
    }
    if (!subcategory) {
      const name = typeof subRaw.name === "string" ? subRaw.name.trim() : "";
      if (name) {
        const existing = categorySubs.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
        if (existing) subcategory = { match: "existing", id: existing.id, name: existing.name };
        else subcategory = { match: "new", name };
      }
    }
  }
  return { description: desc, category, subcategory };
};

export const adaptDescriptionForCatalog = async (
  name: string,
  description: string,
  imageUrl = "",
  categories: Category[] = [],
  subcategories: Subcategory[] = [],
): Promise<AdaptedDescriptionResult> => {
  const config = llmConfig();
  if (!config.apiKey) throw new Error("LLM_API_KEY no está configurada en el entorno.");
  if (!description.trim()) throw new Error("Primero necesitas una descripción base para adaptarla.");
  if (config.models.length === 0) throw new Error("LLM_MODEL no está configurado (no hay modelo primario ni fallbacks).");
  const hasImage = /^https?:\/\//i.test(imageUrl) || imageUrl.startsWith("data:image/");

  console.log("[LLM description/adapt] request", {
    baseUrl: config.baseUrl,
    models: config.models,
    temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
    hasApiKey: Boolean(config.apiKey),
    maxWords: config.maxWords,
    hasImage,
    imageSource: imageUrl.startsWith("data:image/") ? "uploaded-file" : hasImage ? "url" : "none",
    nameLength: name.length,
    descriptionLength: description.length,
    availableCategories: categories.length,
  });

  const subsByCategory = (categoryId: number) => subcategories.filter((s) => s.category_id === categoryId);
  const categoryList = categories.length > 0
    ? `\n\nCategorías disponibles (con sus subcategorías):\n${categories.map((c) => {
        const subs = subsByCategory(c.id);
        const subText = subs.length > 0
          ? `\n    subcategorías: ${subs.map((s) => `id=${s.id}→${s.name}`).join(", ")}`
          : `\n    (sin subcategorías todavía)`;
        return `- id=${c.id} → ${c.name}${subText}`;
      }).join("\n")}`
    : "\n\nNo hay categorías creadas todavía.";

  const descPrompt = settingValue("catalog_description_prompt", "LLM_DESCRIPTION_PROMPT", DEFAULT_CATALOG_DESCRIPTION_PROMPT);
  const imageTaskNum = hasImage ? "4" : "";
  const userText = `Producto: ${name || "Producto de impresión 3D"}\n\nDescripción original:\n${description}${categoryList}\n\nTareas:\n1) ${descPrompt} Máximo ${config.maxWords} palabras.\n2) Asigna una categoría:\n   - Si el producto encaja claramente en alguna de las categorías disponibles, devuelve {"match":"existing","id":<id>}.\n   - Si NO encaja en ninguna existente (o si no hay ninguna), sugiere una NUEVA con un nombre corto (1-3 palabras, en español, capitalizado), devuelve {"match":"new","name":"<nombre>"}.\n   - Prefiere reutilizar una existente antes que crear una nueva si dudas.\n3) Asigna una subcategoría DENTRO de la categoría elegida (más específica que la categoría; ej. categoría "Llaveros" → subcategoría "Motos", "Fidget toy", "Clicker"; categoría "Figuras" → nombre de la serie):\n   - Si la categoría elegida ya tiene una subcategoría que encaja, devuelve {"match":"existing","id":<id>} (usando un id de la lista de subcategorías de ESA categoría).\n   - Si no encaja ninguna (o la categoría es nueva), sugiere una NUEVA con un nombre corto (1-3 palabras, en español, capitalizado): {"match":"new","name":"<nombre>"}.\n   - Si el producto no amerita subcategoría, devuelve null.\n${hasImage ? `${imageTaskNum}) Si la imagen aporta información clara sobre forma, estilo, serie o apariencia, úsala como contexto adicional, sin inventar medidas/materiales/funciones.` : ""}\n\nDevuelve SOLO un objeto JSON válido con esta forma exacta, sin texto extra ni cercas de markdown:\n{"description":"...","category":{"match":"existing"|"new","id":<int opcional>,"name":"<string opcional>"},"subcategory":{"match":"existing"|"new","id":<int opcional>,"name":"<string opcional>"}|null}`;

  const attempts: { model: string; error: string }[] = [];

  for (const model of config.models) {
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: Number.isFinite(config.temperature) ? config.temperature : 0.7,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "Eres un copywriter y clasificador experto en catálogos de productos de impresión 3D. Escribes en español claro, comercial y profesional. No inventes materiales, medidas, licencias, compatibilidades ni usos no presentes en el texto original. Devuelves SIEMPRE JSON válido siguiendo el esquema indicado.",
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
      console.log("[LLM description/adapt] response", { model, status: response.status, ok: response.ok, bodyPreview: rawPayload.slice(0, 400) });

      if (!response.ok) {
        const errMsg = parseLlmError(rawPayload) || `HTTP ${response.status}`;
        attempts.push({ model, error: errMsg });
        console.warn(`[LLM description/adapt] modelo "${model}" falló: ${errMsg}. Intentando siguiente.`);
        continue;
      }
      const content = parseLlmContent(rawPayload);
      if (!content) {
        attempts.push({ model, error: "respuesta vacía" });
        console.warn(`[LLM description/adapt] modelo "${model}" devolvió contenido vacío. Intentando siguiente.`);
        continue;
      }
      if (attempts.length > 0) {
        console.log(`[LLM description/adapt] modelo "${model}" tuvo éxito tras ${attempts.length} fallback(s)`);
      }
      const parsed = parseAdaptedJson(content, categories, subcategories);
      return {
        description: trimToWordLimit(parsed.description, config.maxWords),
        category: parsed.category,
        subcategory: parsed.subcategory,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      attempts.push({ model, error: errMsg });
      console.warn(`[LLM description/adapt] modelo "${model}" lanzó excepción: ${errMsg}. Intentando siguiente.`);
    }
  }

  const summary = attempts.map((a) => `${a.model}: ${a.error}`).join(" | ");
  throw new Error(`Todos los modelos fallaron. ${summary}`);
};

export const buildDesignPrompt = (template: string, userPrompt: string) => {
  const cleanedTemplate = (template || "").trim();
  const cleanedUser = userPrompt.trim();
  if (cleanedTemplate.includes("{userPrompt}")) {
    return cleanedTemplate.replace(/\{userPrompt\}/g, cleanedUser).replace(/\s+/g, " ").trim();
  }
  if (!cleanedTemplate) return cleanedUser;
  if (!cleanedUser) return cleanedTemplate;
  return `${cleanedTemplate}\n\nDescripción adicional del usuario: ${cleanedUser}`;
};

export const resolveImageInput = async (imageInput: string): Promise<string> => {
  const trimmed = imageInput.trim();
  if (!trimmed) throw new Error("Sube una imagen para generar el diseño.");
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (/^\/uploads\//.test(trimmed)) {
    const localPath = resolveUploadPath(trimmed);
    try {
      const buf = fs.readFileSync(localPath);
      const ext = (trimmed.split(".").pop() || "png").toLowerCase();
      const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch (e) {
      console.warn("[design] Could not read local upload, sending raw URL:", e);
      return trimmed;
    }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return await urlToDataUrl(trimmed);
    } catch (e) {
      console.warn("[design] Could not download remote image, sending raw URL:", e);
      return trimmed;
    }
  }
  throw new Error("Formato de imagen no reconocido.");
};

export const generateDesign = async (
  imageInput: string,
  basePromptTemplate: string,
  userExtraPrompt: string,
): Promise<ImageEnhanceResult> => {
  const finalPrompt = buildDesignPrompt(basePromptTemplate, userExtraPrompt);
  if (!finalPrompt) throw new Error("El prompt base está vacío. Configúralo en /admin/config.");
  const resolvedImage = await resolveImageInput(imageInput);
  return callImageEditProvider({
    prompt: finalPrompt,
    image: resolvedImage,
    intent: "image-to-image-product-design",
    options: { output: "raster", format: "png", noText: true, noCode: true, preserveSubject: true },
    source: "pixkey3d-design-generate",
    logTag: "Qwen design/generate",
    filePrefix: "design",
  });
};

export const refineDesign = async (previousImageUrl: string, feedback: string): Promise<ImageEnhanceResult> => {
  const cleanedFeedback = feedback.trim();
  if (!cleanedFeedback) throw new Error("Escribe qué cambio quieres aplicar al diseño.");
  if (!previousImageUrl.trim()) throw new Error("No hay imagen previa para editar.");
  const resolvedImage = await resolveImageInput(previousImageUrl);
  return callImageEditProvider({
    prompt: cleanedFeedback,
    image: resolvedImage,
    intent: "image-to-image-refine",
    options: { output: "raster", format: "png", noText: true, noCode: true, preserveSubject: true },
    source: "pixkey3d-design-refine",
    logTag: "Qwen design/refine",
    filePrefix: "design",
  });
};
