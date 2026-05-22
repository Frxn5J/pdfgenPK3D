import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, getConfig, updateConfig, getProducts, getProduct, getDefaultPriceTiers, getProductPriceTiers, replaceDefaultPriceTiers, replaceProductPriceTiers, type PriceTier } from "../db/schema";
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

const formString = (value: unknown) => typeof value === "string" ? value : "";
const formFile = (value: unknown) => value instanceof File && value.size > 0 ? value : null;
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
  <div class="border border-gray-200 rounded-lg overflow-hidden">
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
  <button type="button" id="add-tier" class="mt-3 bg-gray-200 text-gray-800 px-3 py-2 rounded-md hover:bg-gray-300 text-sm">+ Agregar rango</button>
  <script>
    (() => {
      const table = document.querySelector('#price-tiers-table tbody');
      const add = document.getElementById('add-tier');
      add?.addEventListener('click', () => {
        const row = document.createElement('tr');
        row.innerHTML = '<td><input type="number" name="tier_min" min="1" required class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="number" name="tier_max" min="1" placeholder="Sin límite" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="number" name="tier_price" min="0" step="0.01" required class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td><td><input type="text" name="tier_delivery" class="w-full px-2 py-1 border border-gray-300 rounded-md"></td><td><button type="button" class="remove-tier text-red-600 hover:text-red-800">Quitar</button></td>';
        table?.appendChild(row);
      });
      table?.addEventListener('click', (event) => {
        if (event.target instanceof HTMLElement && event.target.classList.contains('remove-tier')) {
          event.target.closest('tr')?.remove();
        }
      });
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
        const selectedMakerWorldImage = form.querySelector('input[name="selected_image"]:checked');
        if (selectedMakerWorldImage instanceof HTMLInputElement && selectedMakerWorldImage.value.trim()) return selectedMakerWorldImage.value.trim();
        const imageUrl = form.querySelector('input[name="image_url"]');
        if (imageUrl instanceof HTMLInputElement && imageUrl.value.trim()) return imageUrl.value.trim();
        return '';
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

adminRoutes.post("/description/adapt", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const description = await adaptDescriptionForCatalog(formString(body.name), formString(body.description), formString(body.imageUrl));
    return c.json({ description });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "No se pudo adaptar la descripción." }, 400);
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
          <p class="text-xs text-gray-500 mt-1">Prioridad: archivo subido, URL alternativa, imagen seleccionada.</p>
        </div>
        <div>
          <label class="flex items-start gap-3 text-sm">
            <input type="checkbox" name="use_default_pricing" value="1" checked class="mt-1 h-4 w-4 text-blue-600 border-gray-300 rounded">
            <span><strong>Usar tabla global de precios</strong><br><span class="text-gray-500">Desmarca para guardar precios custom para este producto.</span></span>
          </label>
        </div>
        <div>
          <h3 class="text-lg font-semibold mb-3">Rangos de precios custom</h3>
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
  const body = await c.req.parseBody() as Record<string, unknown>;
  let imageUrl = formString(body.image_url) || formString(body.selected_image);
  const file = formFile(body.image_file);
  if (file) imageUrl = await saveUpload(file, "products", "prod");
  const useDefaultPricing = body.use_default_pricing === "1" ? 1 : 0;
  const result = db.query(`
    INSERT INTO products (name, description, image_url, use_default_pricing, sort_order)
    VALUES (?, ?, ?, ?, 0) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, useDefaultPricing) as {id: number};
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
                        <iframe id="catalog-preview" src="/?embed=1" class="h-full w-full bg-white" title="Vista previa del catálogo"></iframe>
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
                    <label class="block text-sm font-medium text-gray-700">Logo (URL o subir archivo)</label>
                    <input type="text" name="company_logo_url" value="${configValue(config, "company_logo")}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                    <input type="file" name="company_logo_file" accept="image/*" class="block w-full text-sm text-gray-500">
                </div>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Bienvenida</label>
                <textarea name="welcome_text" rows="8" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "welcome_text")}</textarea>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Contacto / Pie de página</label>
                <textarea name="contact_text" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "contact_text")}</textarea>
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
  const body = await c.req.parseBody() as Record<string, unknown>;
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
    company_name: body.company_name as string,
    company_logo: logoUrl,
    cover_subtitle: body.cover_subtitle as string,
    products_title: body.products_title as string,
    welcome_text: body.welcome_text as string,
    contact_text: body.contact_text as string,
    color_primary: body.color_primary as string,
    color_secondary: body.color_secondary as string,
    color_accent: body.color_accent as string,
    bg_cover: body.bg_cover as string,
    color_cover_text: body.color_cover_text as string,
    bg_welcome: body.bg_welcome as string,
    bg_products: body.bg_products as string,
    bg_contact: body.bg_contact as string,
    color_contact_text: body.color_contact_text as string,
    bg_card: body.bg_card as string,
    color_card_border: body.color_card_border as string,
    bg_table_header: body.bg_table_header as string,
    color_table_header_text: body.color_table_header_text as string,
    color_body_text: body.color_body_text as string,
    color_heading_text: body.color_heading_text as string,
    color_muted_text: body.color_muted_text as string,
    font_body: body.font_body as string,
    font_heading: body.font_heading as string,
    font_body_file: fontBodyFileUrl,
    font_heading_file: fontHeadingFileUrl,
    border_radius: body.border_radius as string,
    button_radius: body.button_radius as string,
    card_shadow: body.card_shadow as string,
    card_style: body.card_style as string,
    layout_density: body.layout_density as string,
    product_image_fit: body.product_image_fit as string,
    decorative_shapes_enabled: (body.decorative_shapes_enabled ? "1" : "0"),
    decorative_shape_style: body.decorative_shape_style as string,
    decorative_shape_color: body.decorative_shape_color as string,
    decorative_shape_opacity: body.decorative_shape_opacity as string,
    decorative_shape_blur: body.decorative_shape_blur as string,
    custom_css: body.custom_css as string,
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
                <p class="text-sm text-gray-500 mb-3">Si desmarcas precios globales, estos rangos se guardan solo para este producto.</p>
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
  const body = await c.req.parseBody() as Record<string, unknown>;

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

  const useDefaultPricing = body.use_default_pricing === "1" ? 1 : 0;

  const result = db.query(`
    INSERT INTO products (name, description, image_url, use_default_pricing, sort_order)
    VALUES (?, ?, ?, ?, 0) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, useDefaultPricing) as {id: number};

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
                <p class="text-sm text-gray-500 mb-3">Desmarca precios globales para que el catálogo use estos rangos en este producto.</p>
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
  const body = await c.req.parseBody() as Record<string, unknown>;

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

  const useDefaultPricing = body.use_default_pricing === "1" ? 1 : 0;

  db.run(`
    UPDATE products SET name = ?, description = ?, image_url = ?, use_default_pricing = ? WHERE id = ?
  `, [formString(body.name), formString(body.description) || null, imageUrl || null, useDefaultPricing, id]);

  replaceProductPriceTiers(id, useDefaultPricing ? [] : parsePriceTiers(body));

  return c.redirect("/admin/products");
});

export { adminRoutes };
