import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { db, getConfig, updateConfig, getProducts, getProduct, getDefaultPriceTiers, getProductPriceTiers, replaceDefaultPriceTiers, replaceProductPriceTiers, getQuotes, getQuote, getQuoteItemsWithProducts, updateQuoteStatus, getPrinters, createPrinter, deletePrinter, getFilaments, createFilament, deleteFilament, updateQuotePaymentProof, getQuoteFilaments, applyQuoteSchedule, getExpenseCategories, createExpenseCategory, deleteExpenseCategory, getExpenses, createExpense, deleteExpense, getPayments, createPayment, deletePayment, getFinancialSummary, createQuote, getCategories, getCategory, createCategory, updateCategory, deleteCategory, getSubcategories, getSubcategoriesByCategory, getSubcategory, createSubcategory, updateSubcategory, deleteSubcategory, addPushSubscription, deletePushSubscription, countPushSubscriptions, getUsers, getUserById, getUserByUsername, createUser, updateUser, deleteUser, updateQuoteItemPrintValues, type PriceTier, type QuoteItemWithProduct, type Quote, type Printer, type Filament, type QuoteFilamentWithDetails, type QuoteItemInput, type Category, type Subcategory, type UserRole, type AppUser } from "../db/schema";
import { generateClientToken, updatePrintedQuantities, updateShippingInfo } from "../db/portal";
import { join } from "path";
import * as fs from "fs";
import { pwaHeadTags, pwaRegisterScript, getVapidPublicKey, sendPushToAll } from "../pwa";
import { type SessionData, requireAuth, requireRole, signSession, verifySession, bumpSessionVersion } from "../lib/session";
import { formString, formStringArray, formFile, safeFilename, isFontFile, saveUpload, saveImageUpload, escapeHtml, configValue, defaultFontFamily } from "../lib/html";
import { money, plainMoney, volumeText, renderStatusBadge, quoteFolio, formatDate } from "../lib/formatting";
import { cleanText, decodeEntities, metaContent, tagText, uniqueImages, collectImageCandidates } from "../lib/text";
import { settingValue, llmConfig, parseLlmContent, parseLlmError } from "../lib/llm";
import { type PrintProfile, type MakerWorldCollectionItem, type MakerWorldDraft, normalizeMakerWorldUrl, isMakerWorldCollection, isCloudflareChallenge, scrapeMakerWorld, scrapeMakerWorldCollection } from "../lib/makerworld";
import { type ImageEnhanceResult, enhanceImageForCatalog, callImageEditProvider } from "../lib/image-enhance";
import { type AdaptedDescriptionResult, type CategorySuggestion, type SubcategorySuggestion, adaptDescriptionForCatalog, generateDesign, refineDesign, parseAdaptedJson, DEFAULT_CATALOG_DESCRIPTION_PROMPT } from "../lib/design";
import { bodyValues, parsePriceTiers, renderPriceTierRows } from "../lib/pricing";

const adminRoutes = new Hono();

// ── CSRF (proxy-aware) ──────────────────────────────────────────────────────
// En métodos que mutan, si llega cabecera Origin debe coincidir con el host de
// la petición (usa X-Forwarded-Host detrás del reverse proxy). Complementa el
// SameSite=Lax de la cookie de sesión. No rompe peticiones same-origin ni las
// que no envían Origin (algunos clientes legítimos).
const csrfGuard = async (c: any, next: any) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
    try {
      if (new URL(origin).host !== host) return c.text("CSRF: origen no permitido.", 403);
    } catch {
      return c.text("CSRF: origen inválido.", 403);
    }
  }
  return next();
};
adminRoutes.use("/*", csrfGuard);

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

// Renderiza los selects de Categoría + Subcategoría (en cascada). La lista
// completa de subcategorías viaja en data-all-subcategories del select para que
// el JS pueda repoblar al cambiar la categoría sin recargar. El select de
// subcategoría solo muestra las de la categoría seleccionada.
const renderCategoryFields = (categories: Category[], subcategories: Subcategory[], selectedCategoryId: number | null = null, selectedSubId: number | null = null) => {
  const allSubs = subcategories.map((s) => ({ id: s.id, category_id: s.category_id, name: s.name }));
  const dataAttr = escapeHtml(JSON.stringify(allSubs));
  const visibleSubs = selectedCategoryId != null ? subcategories.filter((s) => s.category_id === selectedCategoryId) : [];
  return `
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700">Categoría</label>
        <select name="category_id" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
          <option value="" ${selectedCategoryId == null ? 'selected' : ''}>— Sin categoría —</option>
          ${categories.map((cat) => `<option value="${cat.id}" ${selectedCategoryId === cat.id ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`).join("")}
        </select>
        <p class="text-xs text-gray-500 mt-1">¿Falta una? <a href="/admin/categorias" target="_blank" class="text-blue-600 underline">Gestionar categorías</a></p>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700">Subcategoría</label>
        <select name="subcategory_id" data-all-subcategories="${dataAttr}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
          <option value="">— Sin subcategoría —</option>
          ${visibleSubs.map((s) => `<option value="${s.id}" ${s.id === selectedSubId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join("")}
        </select>
        <p class="text-xs text-gray-500 mt-1">Se filtra según la categoría. La IA puede sugerirla al adaptar.</p>
      </div>
    </div>
  `;
};

// Lee category_id/subcategory_id de un form y valida la jerarquía: la
// subcategoría solo se conserva si existe y pertenece a la categoría elegida.
const parseCategoryAndSub = (body: Record<string, unknown>): { categoryId: number | null; subcategoryId: number | null } => {
  const rawCategory = formString(body.category_id);
  const categoryId = rawCategory && rawCategory !== "" ? (Number.parseInt(rawCategory, 10) || null) : null;
  const rawSub = formString(body.subcategory_id);
  let subcategoryId = rawSub && rawSub !== "" ? (Number.parseInt(rawSub, 10) || null) : null;
  if (subcategoryId != null) {
    const sub = getSubcategory(subcategoryId);
    if (!sub || categoryId == null || sub.category_id !== categoryId) subcategoryId = null;
  }
  return { categoryId, subcategoryId };
};

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

      // Aplica la sugerencia de categoría al <select name="category_id"> del
      // form. Si el modelo propuso una EXISTENTE, la selecciona. Si propuso
      // una NUEVA, pregunta al usuario antes de crearla via quick-create.
      const applyCategorySuggestion = async (form, suggestion, status) => {
        if (!suggestion || !form) return '';
        const select = form.querySelector('select[name="category_id"]');
        if (!(select instanceof HTMLSelectElement)) return ''; // El form puede no tener dropdown (ej. MakerWorld import legacy).

        if (suggestion.match === 'existing') {
          const id = String(suggestion.id);
          const option = Array.from(select.options).find((o) => o.value === id);
          if (option) {
            select.value = id;
            return ' Categoría asignada: ' + option.textContent + '.';
          }
          return ' (No se encontró la categoría sugerida id=' + id + ' en el dropdown.)';
        }

        if (suggestion.match === 'new') {
          const accept = window.confirm('La IA sugiere crear una nueva categoría: "' + suggestion.name + '".\\n\\n¿Quieres crearla y asignarla a este producto?');
          if (!accept) return ' Sugerencia de nueva categoría "' + suggestion.name + '" descartada.';
          if (status) status.textContent = 'Creando categoría "' + suggestion.name + '"...';
          try {
            const res = await fetch('/admin/categorias/quick-create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: suggestion.name }),
            });
            const data = await res.json();
            if (!res.ok || !data.category) throw new Error(data.error || 'No se pudo crear la categoría.');
            const cat = data.category;
            let option = Array.from(select.options).find((o) => o.value === String(cat.id));
            if (!option) {
              option = new Option(cat.name, String(cat.id));
              select.appendChild(option);
            }
            select.value = String(cat.id);
            return data.created
              ? ' Nueva categoría "' + cat.name + '" creada y asignada.'
              : ' Reutilizada categoría existente "' + cat.name + '".';
          } catch (e) {
            return ' No se pudo crear la categoría: ' + (e instanceof Error ? e.message : String(e));
          }
        }
        return '';
      };

      // Lista completa de subcategorías embebida en el select. La usamos para
      // repoblar el dropdown al cambiar la categoría (cascada) sin recargar.
      const subcatData = (select) => {
        try { return JSON.parse(select.dataset.allSubcategories || '[]'); } catch { return []; }
      };

      // Repuebla select[name=subcategory_id] con las subcategorías de la
      // categoría dada. Siempre deja la opción "— Sin subcategoría —".
      const populateSubcategorySelect = (form, categoryId, selectedSubId) => {
        const sub = form?.querySelector('select[name="subcategory_id"]');
        if (!(sub instanceof HTMLSelectElement)) return;
        const catId = categoryId !== '' && categoryId != null ? Number(categoryId) : null;
        const matches = catId != null ? subcatData(sub).filter((s) => Number(s.category_id) === catId) : [];
        sub.innerHTML = '';
        sub.appendChild(new Option('— Sin subcategoría —', ''));
        for (const s of matches) {
          const option = new Option(s.name, String(s.id));
          if (selectedSubId != null && String(s.id) === String(selectedSubId)) option.selected = true;
          sub.appendChild(option);
        }
      };

      // Cascada: al cambiar la categoría manualmente, refresca la subcategoría.
      document.addEventListener('change', (event) => {
        const target = event.target;
        if (target instanceof HTMLSelectElement && target.name === 'category_id') {
          populateSubcategorySelect(target.closest('form'), target.value, null);
        }
      });

      // Aplica la sugerencia de subcategoría DENTRO de la categoría ya resuelta
      // (categoryId es el value del select de categoría tras aplicar su propia
      // sugerencia). Sin categoría no hay dónde colgar la subcategoría.
      const applySubcategorySuggestion = async (form, suggestion, categoryId, status) => {
        if (!suggestion || !form) return '';
        const sub = form.querySelector('select[name="subcategory_id"]');
        if (!(sub instanceof HTMLSelectElement)) return '';
        if (!categoryId) return ' (La subcategoría sugerida necesita una categoría asignada.)';
        populateSubcategorySelect(form, categoryId, null);

        if (suggestion.match === 'existing') {
          const id = String(suggestion.id);
          let option = Array.from(sub.options).find((o) => o.value === id);
          if (!option) { option = new Option(suggestion.name, id); sub.appendChild(option); }
          sub.value = id;
          return ' Subcategoría asignada: ' + suggestion.name + '.';
        }

        if (suggestion.match === 'new') {
          const accept = window.confirm('La IA sugiere crear una nueva subcategoría: "' + suggestion.name + '".\\n\\n¿Quieres crearla y asignarla a este producto?');
          if (!accept) return ' Sugerencia de subcategoría "' + suggestion.name + '" descartada.';
          if (status) status.textContent = 'Creando subcategoría "' + suggestion.name + '"...';
          try {
            const res = await fetch('/admin/subcategorias/quick-create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ category_id: categoryId, name: suggestion.name }),
            });
            const data = await res.json();
            if (!res.ok || !data.subcategory) throw new Error(data.error || 'No se pudo crear la subcategoría.');
            const s = data.subcategory;
            const all = subcatData(sub);
            if (!all.some((x) => String(x.id) === String(s.id))) {
              all.push({ id: s.id, category_id: s.category_id, name: s.name });
              sub.dataset.allSubcategories = JSON.stringify(all);
            }
            let option = Array.from(sub.options).find((o) => o.value === String(s.id));
            if (!option) { option = new Option(s.name, String(s.id)); sub.appendChild(option); }
            sub.value = String(s.id);
            return data.created
              ? ' Nueva subcategoría "' + s.name + '" creada y asignada.'
              : ' Reutilizada subcategoría existente "' + s.name + '".';
          } catch (e) {
            return ' No se pudo crear la subcategoría: ' + (e instanceof Error ? e.message : String(e));
          }
        }
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
        if (status) status.textContent = 'Generando texto de catálogo y categoría con IA...';
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
          const catNote = await applyCategorySuggestion(form, payload.category, status);
          const catSelect = form?.querySelector('select[name="category_id"]');
          const resolvedCatId = catSelect instanceof HTMLSelectElement ? catSelect.value : '';
          const subNote = await applySubcategorySuggestion(form, payload.subcategory, resolvedCatId, status);
          if (status) status.textContent = 'Descripción adaptada. Revisa el texto antes de guardar.' + catNote + subNote;
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

const adminCssValue = (value: unknown, fallback: string) => {
  const s = String(value ?? fallback).replace(/[;\r\n]/g, " ").replace(/<\/style/gi, "").trim();
  return s || fallback;
};
const adminCssUrl = (value: unknown) => String(value ?? "").replace(/[)"'\\\r\n<>]/g, "").trim();
const adminFontFace = (family: string, url: unknown) => {
  const u = adminCssUrl(url);
  return u ? `@font-face { font-family: "${family}"; src: url("${u}"); font-display: swap; }` : "";
};
const adminFontStack = (family: string, url: unknown, fallback: string) => adminCssUrl(url) ? `"${family}", ${fallback}` : fallback;

const buildAdminThemeCss = (config: Record<string, string>) => {
  const bodyFallback = adminCssValue(config.font_body, defaultFontFamily);
  const headingFallback = adminCssValue(config.font_heading, defaultFontFamily);
  return `
    ${adminFontFace("Uploaded Body Font", config.font_body_file)}
    ${adminFontFace("Uploaded Heading Font", config.font_heading_file)}
    :root {
      --brand-primary: ${adminCssValue(config.color_primary, "#ef4444")};
      --brand-secondary: ${adminCssValue(config.color_secondary, "#1f2937")};
      --brand-accent: ${adminCssValue(config.color_accent, "#f87171")};
      --heading-text: ${adminCssValue(config.color_heading_text, "#111827")};
      --body-text: ${adminCssValue(config.color_body_text, "#374151")};
      --muted-text: ${adminCssValue(config.color_muted_text, "#6b7280")};
      --font-body: ${adminFontStack("Uploaded Body Font", config.font_body_file, bodyFallback)};
      --font-heading: ${adminFontStack("Uploaded Heading Font", config.font_heading_file, headingFallback)};
      --radius: ${adminCssValue(config.border_radius, "0.75rem")};
    }
    body { font-family: var(--font-body) !important; color: var(--body-text); }
    h1, h2, h3, h4, h5, h6 { font-family: var(--font-heading) !important; }
    .admin-nav { background: var(--brand-primary) !important; color: var(--brand-secondary) !important; }
    .admin-nav a, .admin-nav button, .nav-dropdown-btn, .nav-direct-link { color: var(--brand-secondary) !important; }
    .admin-nav a:hover, .admin-nav button:hover,
    .nav-dropdown-btn:hover, .nav-dropdown.open .nav-dropdown-btn { background: var(--brand-accent) !important; }
    .admin-nav .nav-direct-link:hover { background: var(--brand-accent) !important; }
    .btn-primary, a.btn-primary { background: var(--brand-primary) !important; }
    .btn-primary:hover, a.btn-primary:hover { filter: brightness(0.9); }
  `;
};

const AdminLayout = (title: string, content: string, session?: SessionData) => {
  const config = getConfig();
  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            blue: {
              600: '${adminCssValue(config.color_primary, "#2563eb")}',
              700: '${adminCssValue(config.color_primary, "#2563eb")}e6',
              800: '${adminCssValue(config.color_secondary, "#1f2937")}',
            }
          }
        }
      }
    }
    </script>
    ${pwaHeadTags(config)}
    <style>${buildAdminThemeCss(config)}</style>
</head>
<body class="bg-gray-100 min-h-screen">
    <style>
      .nav-dropdown { position: relative; }
      .nav-dropdown-btn { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; background: none; border: none; color: inherit; }
      .nav-dropdown-btn:hover, .nav-dropdown.open .nav-dropdown-btn { background: rgba(255,255,255,.15); }
      .nav-dropdown-btn svg { width: 14px; height: 14px; transition: transform .15s; }
      .nav-dropdown.open .nav-dropdown-btn svg { transform: rotate(180deg); }
      .nav-dropdown-menu { display: none; position: absolute; top: 100%; left: 0; min-width: 200px; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 6px 0; z-index: 50; margin-top: 4px; }
      .nav-dropdown.open .nav-dropdown-menu { display: block; }
      .nav-dropdown-menu a { display: block; padding: 8px 16px; font-size: 13px; font-weight: 500; color: var(--brand-primary) !important; text-decoration: none; transition: background .1s; }
      .nav-dropdown-menu a:hover { background: var(--brand-accent) !important; color: var(--brand-secondary) !important; }
      .nav-dropdown-menu .menu-divider { height: 1px; background: #e2e8f0; margin: 4px 0; }
      .nav-direct-link { padding: 8px 12px; border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none; color: inherit; }
      .nav-direct-link:hover { background: rgba(255,255,255,.15); }
      .nav-direct-link.catalog-link { color: #bfdbfe; }
      .nav-direct-link.catalog-link:hover { color: #fff; background: rgba(255,255,255,.15); }
      @media (max-width: 768px) {
        .nav-items { display: none !important; }
        .nav-mobile-toggle { display: flex !important; }
        .nav-items.mobile-open { display: flex !important; position: absolute; top: 64px; left: 0; right: 0; flex-direction: column; background: var(--brand-primary); padding: 8px 16px 16px; gap: 2px; z-index: 50; box-shadow: 0 4px 12px rgba(0,0,0,.2); }
        .nav-items.mobile-open .nav-dropdown-menu { position: static; box-shadow: none; background: rgba(255,255,255,.1); margin: 2px 0 4px 12px; border-radius: 6px; }
        .nav-items.mobile-open .nav-dropdown-menu a { color: var(--brand-secondary) !important; }
        .nav-items.mobile-open .nav-dropdown-menu a:hover { background: var(--brand-accent) !important; }
        .nav-items.mobile-open .nav-dropdown-menu .menu-divider { background: rgba(0,0,0,.1); }
      }
    </style>
    <nav class="admin-nav text-white shadow-md" style="position:relative">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center gap-2">
                    <a href="/admin" class="font-bold text-xl tracking-tight">PIXKEY3D Admin</a>
                    <button class="nav-mobile-toggle" style="display:none;align-items:center;justify-content:center;width:36px;height:36px;border:none;background:rgba(255,255,255,.15);border-radius:6px;color:#fff;cursor:pointer" aria-label="Menú">
                      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h14M3 10h14M3 14h14"/></svg>
                    </button>
                </div>
                <div class="nav-items flex items-center gap-1">
                    <div class="nav-dropdown">
                        <button class="nav-dropdown-btn" type="button">Catálogo
                          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                        </button>
                        <div class="nav-dropdown-menu">
                            <a href="/admin/products">Productos</a>
                            <a href="/admin/categorias">Categorías</a>
                            <a href="/admin/makerworld">Importar MakerWorld</a>
                            <div class="menu-divider"></div>
                            <a href="/" target="_blank">Ver Catálogo ↗</a>
                        </div>
                    </div>
                    <div class="nav-dropdown">
                        <button class="nav-dropdown-btn" type="button">Cotizaciones
                          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                        </button>
                        <div class="nav-dropdown-menu">
                            <a href="/admin/quotes">Ver cotizaciones</a>
                            <a href="/admin/quotes/new">Nueva cotización</a>
                            <a href="/admin/notificaciones">Notificaciones push</a>
                        </div>
                    </div>
                    <div class="nav-dropdown">
                        <button class="nav-dropdown-btn" type="button">Herramientas
                          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                        </button>
                        <div class="nav-dropdown-menu">
                            <a href="/admin/herramientas/creador-disenios">Creador de diseños</a>
                        </div>
                    </div>
                    <div class="nav-dropdown">
                        <button class="nav-dropdown-btn" type="button">Finanzas
                          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                        </button>
                        <div class="nav-dropdown-menu">
                            <a href="/admin/finanzas">Dashboard</a>
                            <a href="/admin/finanzas/ingresos">Ingresos / Pagos</a>
                            <a href="/admin/finanzas/gastos">Gastos</a>
                            <a href="/admin/finanzas/reportes">Reportes</a>
                        </div>
                    </div>
                    <div class="nav-dropdown">
                        <button class="nav-dropdown-btn" type="button">Producción
                          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd"/></svg>
                        </button>
                        <div class="nav-dropdown-menu">
                            <a href="/admin/production">Panel de Producción</a>
                            <a href="/admin/production-settings">Impresoras y Filamentos</a>
                        </div>
                    </div>
                    <a href="/admin/config" class="nav-direct-link">Configuración</a>
                    ${session?.role === "superusuario" ? `<a href="/admin/usuarios" class="nav-direct-link">Usuarios</a>` : ""}
                </div>
                <div class="flex items-center gap-3">
                    ${session ? `<div class="flex items-center gap-2 text-sm">
                      <span class="text-blue-100 font-medium">${escapeHtml(session.username)}</span>
                      <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${session.role === "superusuario" ? "bg-purple-500 text-white" : session.role === "admin" ? "bg-red-500 text-white" : session.role === "editor" ? "bg-blue-400 text-white" : "bg-gray-400 text-white"}">${escapeHtml(session.role)}</span>
                    </div>` : ""}
                    <form action="/admin/logout" method="post" class="inline">
                        <button type="submit" class="text-sm font-medium text-blue-200 hover:text-white">Cerrar Sesión</button>
                    </form>
                </div>
            </div>
        </div>
    </nav>
    <script>
    (function(){
      document.querySelectorAll('.nav-dropdown-btn').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          var dd = btn.closest('.nav-dropdown');
          var wasOpen = dd.classList.contains('open');
          document.querySelectorAll('.nav-dropdown.open').forEach(function(d){ d.classList.remove('open'); });
          if (!wasOpen) dd.classList.add('open');
        });
      });
      document.addEventListener('click', function(){ document.querySelectorAll('.nav-dropdown.open').forEach(function(d){ d.classList.remove('open'); }); });
      var toggle = document.querySelector('.nav-mobile-toggle');
      var items = document.querySelector('.nav-items');
      if (toggle && items) toggle.addEventListener('click', function(){ items.classList.toggle('mobile-open'); });
    })();
    </script>
    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        ${content}
    </main>
${descriptionAiScript}
${pwaRegisterScript()}
</body>
</html>
`;
};

adminRoutes.get("/login", (c) => {
  const loginConfig = getConfig();
  const loginLogo = loginConfig.company_logo || "";
  return c.html(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login - Admin</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>${buildAdminThemeCss(loginConfig)}</style>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
        <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
            ${loginLogo ? `<div class="flex justify-center mb-4"><img src="${escapeHtml(loginLogo)}" alt="Logo" class="h-16 w-auto object-contain"></div>` : ""}
            <h1 class="text-2xl font-bold mb-6 text-center">${escapeHtml(loginConfig.company_name || "Administración")}</h1>
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

// ── Rate limiting de login (en memoria) ────────────────────────────────────
// Frena fuerza bruta: máx. LOGIN_MAX_ATTEMPTS fallos por IP+usuario dentro de
// LOGIN_WINDOW_MS. Un login exitoso limpia el contador.
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, number[]>();

const clientIp = (c: any): string =>
  (c.req.header("x-forwarded-for") || "").split(",")[0]?.trim() ||
  c.req.header("x-real-ip") || "unknown";

const loginRateKey = (c: any, username: string) => `${clientIp(c)}:${username.toLowerCase()}`;

// Devuelve segundos de espera si está limitado, o 0 si puede intentar.
const loginRetryAfter = (key: string): number => {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(key, recent);
  if (recent.length >= LOGIN_MAX_ATTEMPTS) {
    return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - recent[0]!)) / 1000));
  }
  return 0;
};

const recordLoginFailure = (key: string) => {
  const arr = loginAttempts.get(key) || [];
  arr.push(Date.now());
  loginAttempts.set(key, arr);
};

adminRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const inputUsername = String(body.username || "").trim();
  const inputPassword = String(body.password || "");

  const rateKey = loginRateKey(c, inputUsername);
  const retryAfter = loginRetryAfter(rateKey);
  if (retryAfter > 0) {
    c.header("Retry-After", String(retryAfter));
    return c.text(`Demasiados intentos de inicio de sesión. Intenta de nuevo en ${Math.ceil(retryAfter / 60)} minuto(s).`, 429);
  }

  const superUsername = settingValue("admin_username", "ADMIN_USERNAME", "");
  const superPassword = settingValue("admin_password", "ADMIN_PASSWORD", "");

  let sessionData: SessionData | null = null;

  // Superusuario de config: la contraseña se almacena hasheada (Bun.password).
  // Compat: si el valor viniera en texto plano (p. ej. ADMIN_PASSWORD del .env
  // sin migrar), se compara directo. Sin username configurado → deshabilitado.
  if (inputUsername && superUsername && inputUsername === superUsername && superPassword) {
    const looksHashed = /^\$(argon2|2[aby]?)\$/.test(superPassword);
    const valid = looksHashed
      ? await Bun.password.verify(inputPassword, superPassword)
      : inputPassword === superPassword;
    if (valid) {
      sessionData = { id: 0, username: superUsername, role: "superusuario", exp: Date.now() + 24 * 60 * 60 * 1000 };
    }
  }

  // If not superusuario, check users table
  if (!sessionData) {
    const user = getUserByUsername(inputUsername);
    if (user && user.active) {
      const valid = await Bun.password.verify(inputPassword, user.password_hash);
      if (valid) {
        sessionData = { id: user.id, username: user.username, role: user.role, exp: Date.now() + 24 * 60 * 60 * 1000 };
      }
    }
  }

  if (sessionData) {
    loginAttempts.delete(rateKey);
    const token = await signSession(sessionData);
    setCookie(c, "admin_session", token, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 86400 });
    return c.redirect("/admin");
  }

  recordLoginFailure(rateKey);
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

// ── Gestión de usuarios ──────────────────────────────────────────────────

const roleBadge = (role: UserRole) => {
  const classes: Record<UserRole, string> = {
    superusuario: "bg-purple-100 text-purple-800",
    admin: "bg-red-100 text-red-800",
    editor: "bg-blue-100 text-blue-800",
    visor: "bg-gray-100 text-gray-800",
  };
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${classes[role] || classes.visor}">${escapeHtml(role)}</span>`;
};

adminRoutes.get("/usuarios", requireRole(["superusuario"]), (c) => {
  const session = c.get("session") as SessionData;
  const users = getUsers();
  const superUsername = settingValue("admin_username", "ADMIN_USERNAME", "Frxn5J");
  const rows = users.map((u) => `
    <tr class="hover:bg-gray-50">
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${escapeHtml(u.username)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm">${roleBadge(u.role)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm">
        ${u.active ? '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Activo</span>' : '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Inactivo</span>'}
      </td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(u.created_at)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-3">
        <a href="/admin/usuarios/${u.id}/editar" class="text-blue-600 hover:text-blue-900">Editar</a>
        <form method="post" action="/admin/usuarios/${u.id}/eliminar" class="inline" onsubmit="return confirm('¿Eliminar usuario ${escapeHtml(u.username)}?')">
          <button type="submit" class="text-red-600 hover:text-red-900">Eliminar</button>
        </form>
      </td>
    </tr>
  `).join("");

  return c.html(AdminLayout("Usuarios", `
    <div class="bg-white shadow rounded-lg overflow-hidden">
      <div class="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div>
          <h2 class="text-xl font-bold text-gray-800">Gestión de Usuarios</h2>
          <p class="text-sm text-gray-500 mt-1">Administra los usuarios que pueden acceder al panel.</p>
        </div>
        <a href="/admin/usuarios/nuevo" class="btn-primary inline-flex items-center px-4 py-2 rounded-md text-white text-sm font-medium">+ Nuevo usuario</a>
      </div>
      <div class="px-6 py-4 bg-yellow-50 border-b border-yellow-200">
        <p class="text-sm text-yellow-800"><strong>Superusuario de config:</strong> <code class="bg-yellow-100 px-1 rounded">${escapeHtml(superUsername)}</code> — gestionado desde /admin/config o variables de entorno.</p>
      </div>
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Usuario</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rol</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Estado</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Creado</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          ${rows || '<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 text-sm">No hay usuarios adicionales. Crea uno con "+ Nuevo usuario".</td></tr>'}
        </tbody>
      </table>
    </div>
  `, session));
});

adminRoutes.get("/usuarios/nuevo", requireRole(["superusuario"]), (c) => {
  const session = c.get("session") as SessionData;
  const error = c.req.query("error") || "";
  const errorMsg = error === "username_taken" ? "El nombre de usuario ya existe." : error === "invalid" ? "Datos inválidos. Verifica el formulario." : "";
  return c.html(AdminLayout("Nuevo Usuario", `
    <div class="max-w-lg mx-auto bg-white shadow rounded-lg p-6">
      <h2 class="text-xl font-bold text-gray-800 mb-6">Crear nuevo usuario</h2>
      ${errorMsg ? `<div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">${escapeHtml(errorMsg)}</div>` : ""}
      <form method="post" action="/admin/usuarios/nuevo" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700">Nombre de usuario</label>
          <input type="text" name="username" required autocomplete="off" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Contraseña</label>
          <input type="password" name="password" required autocomplete="new-password" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Rol</label>
          <select name="role" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
            <option value="admin">admin — gestión completa excepto usuarios</option>
            <option value="editor">editor — puede crear/editar productos y categorías</option>
            <option value="visor" selected>visor — solo lectura</option>
          </select>
        </div>
        <div class="flex items-center gap-3 pt-2">
          <button type="submit" class="btn-primary px-5 py-2 rounded-md text-white text-sm font-medium">Crear usuario</button>
          <a href="/admin/usuarios" class="text-sm text-gray-600 hover:underline">Cancelar</a>
        </div>
      </form>
    </div>
  `, session));
});

adminRoutes.post("/usuarios/nuevo", requireRole(["superusuario"]), async (c) => {
  const body = await c.req.parseBody();
  const username = formString(body.username).trim();
  const password = formString(body.password);
  const role = formString(body.role) as UserRole;
  const validRoles: UserRole[] = ["admin", "editor", "visor"];
  if (!username || !password || !validRoles.includes(role)) {
    return c.redirect("/admin/usuarios/nuevo?error=invalid");
  }
  try {
    const hash = await Bun.password.hash(password);
    createUser(username, hash, role);
    return c.redirect("/admin/usuarios");
  } catch {
    return c.redirect("/admin/usuarios/nuevo?error=username_taken");
  }
});

adminRoutes.get("/usuarios/:id/editar", requireRole(["superusuario"]), (c) => {
  const session = c.get("session") as SessionData;
  const id = Number(c.req.param("id"));
  const user = getUserById(id);
  if (!user) return c.html("<p>Usuario no encontrado.</p>", 404);
  const error = c.req.query("error") || "";
  const errorMsg = error === "username_taken" ? "El nombre de usuario ya existe." : error === "invalid" ? "Datos inválidos." : "";
  return c.html(AdminLayout(`Editar Usuario: ${escapeHtml(user.username)}`, `
    <div class="max-w-lg mx-auto bg-white shadow rounded-lg p-6">
      <h2 class="text-xl font-bold text-gray-800 mb-6">Editar usuario</h2>
      ${errorMsg ? `<div class="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">${escapeHtml(errorMsg)}</div>` : ""}
      <form method="post" action="/admin/usuarios/${user.id}/editar" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700">Nombre de usuario</label>
          <input type="text" name="username" required value="${escapeHtml(user.username)}" autocomplete="off" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Contraseña</label>
          <input type="password" name="password" autocomplete="new-password" placeholder="(dejar vacío para no cambiar)" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">Rol</label>
          <select name="role" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm">
            <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin — gestión completa excepto usuarios</option>
            <option value="editor" ${user.role === "editor" ? "selected" : ""}>editor — puede crear/editar productos y categorías</option>
            <option value="visor" ${user.role === "visor" ? "selected" : ""}>visor — solo lectura</option>
          </select>
        </div>
        <div class="flex items-center gap-3">
          <label class="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
            <input type="checkbox" name="active" value="1" ${user.active ? "checked" : ""} class="rounded border-gray-300 text-blue-600">
            Usuario activo
          </label>
        </div>
        <div class="flex items-center gap-3 pt-2">
          <button type="submit" class="btn-primary px-5 py-2 rounded-md text-white text-sm font-medium">Guardar cambios</button>
          <a href="/admin/usuarios" class="text-sm text-gray-600 hover:underline">Cancelar</a>
        </div>
      </form>
    </div>
  `, session));
});

adminRoutes.post("/usuarios/:id/editar", requireRole(["superusuario"]), async (c) => {
  const id = Number(c.req.param("id"));
  const user = getUserById(id);
  if (!user) return c.html("<p>Usuario no encontrado.</p>", 404);
  const body = await c.req.parseBody();
  const username = formString(body.username).trim();
  const password = formString(body.password);
  const role = formString(body.role) as UserRole;
  const active = body.active === "1" ? 1 : 0;
  const validRoles: UserRole[] = ["admin", "editor", "visor"];
  if (!username || !validRoles.includes(role)) {
    return c.redirect(`/admin/usuarios/${id}/editar?error=invalid`);
  }
  try {
    const updates: { username?: string; password_hash?: string; role?: UserRole; active?: number } = { username, role, active };
    if (password) {
      updates.password_hash = await Bun.password.hash(password);
    }
    updateUser(id, updates);
    return c.redirect("/admin/usuarios");
  } catch {
    return c.redirect(`/admin/usuarios/${id}/editar?error=username_taken`);
  }
});

adminRoutes.post("/usuarios/:id/eliminar", requireRole(["superusuario"]), (c) => {
  const id = Number(c.req.param("id"));
  deleteUser(id);
  return c.redirect("/admin/usuarios");
});

// ── Notificaciones push (admin) ──────────────────────────────────────────
adminRoutes.get("/push/public-key", (c) => c.json({ publicKey: getVapidPublicKey() }));

adminRoutes.post("/push/subscribe", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>;
    const sub = body.subscription || body;
    const endpoint = String(sub?.endpoint || "").trim();
    // Normalize to base64url (no padding, no standard base64 chars).
    // Safari on iOS sends keys with '=' padding or '+'/'/'; Node's WebCrypto
    // throws "The string did not match the expected pattern" on those inputs.
    const toBase64url = (s: string) => s.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const p256dh = toBase64url(String(sub?.keys?.p256dh || ""));
    const auth = toBase64url(String(sub?.keys?.auth || ""));
    if (!endpoint || !p256dh || !auth) return c.json({ error: "Suscripción inválida." }, 400);
    addPushSubscription(endpoint, p256dh, auth, c.req.header("user-agent") || null);
    return c.json({ ok: true, total: countPushSubscriptions() });
  } catch (error) {
    console.error("[push] subscribe failed", error);
    return c.json({ error: "No se pudo guardar la suscripción." }, 400);
  }
});

adminRoutes.post("/push/unsubscribe", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, any>;
    const endpoint = String(body?.endpoint || body?.subscription?.endpoint || "").trim();
    if (endpoint) deletePushSubscription(endpoint);
    return c.json({ ok: true, total: countPushSubscriptions() });
  } catch (error) {
    console.error("[push] unsubscribe failed", error);
    return c.json({ error: "No se pudo cancelar la suscripción." }, 400);
  }
});

adminRoutes.post("/push/test", async (c) => {
  try {
    const result = await sendPushToAll({
      title: "Prueba de notificación",
      body: "Si ves esto, las notificaciones push funcionan ✅",
      url: "/admin/quotes",
      tag: "pixkey3d-test",
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    console.error("[push] test failed", error);
    return c.json({ error: "No se pudo enviar la prueba." }, 500);
  }
});

adminRoutes.get("/notificaciones", (c) => {
  const total = countPushSubscriptions();
  const publicKey = getVapidPublicKey();
  return c.html(AdminLayout("Notificaciones", `
    <div class="max-w-2xl mx-auto space-y-6">
      <div class="border-b pb-4">
        <h1 class="text-2xl font-bold text-gray-800">Notificaciones push</h1>
        <p class="text-sm text-gray-500 mt-1">Instala la app en tu teléfono ("Agregar a pantalla de inicio") y activa las notificaciones para recibir un aviso cada vez que entre una <strong>cotización nueva</strong> desde el catálogo.</p>
      </div>

      <div class="bg-white shadow rounded-lg p-6 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-semibold text-gray-800">Estado en este dispositivo</p>
            <p data-push-status class="text-sm text-gray-500 mt-1">Comprobando…</p>
          </div>
          <span data-push-badge class="text-xs font-semibold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600">—</span>
        </div>

        <div class="flex flex-wrap gap-3 pt-2">
          <button type="button" data-push-enable class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 text-sm font-medium">Activar notificaciones</button>
          <button type="button" data-push-disable class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300 text-sm font-medium hidden">Desactivar</button>
          <button type="button" data-push-test class="border border-blue-600 text-blue-600 px-4 py-2 rounded-md hover:bg-blue-50 text-sm font-medium">Enviar prueba</button>
        </div>

        <p class="text-xs text-gray-400">Dispositivos suscritos actualmente: <strong data-push-count>${total}</strong>. Cada teléfono/navegador donde actives cuenta como uno.</p>
      </div>

      <div class="bg-amber-50 border border-amber-200 rounded-lg p-4 text-xs text-amber-800 space-y-1">
        <p><strong>iPhone/iPad:</strong> primero usa Safari → Compartir → "Agregar a pantalla de inicio", abre la app desde el ícono y luego activa las notificaciones (iOS solo permite push en apps instaladas).</p>
        <p><strong>Android/Chrome:</strong> puedes activar desde el navegador o instalando la app. Requiere HTTPS (o localhost).</p>
      </div>
    </div>

    <script>
    (() => {
      const VAPID_PUBLIC_KEY = ${JSON.stringify(publicKey)};
      const statusEl = document.querySelector('[data-push-status]');
      const badgeEl = document.querySelector('[data-push-badge]');
      const countEl = document.querySelector('[data-push-count]');
      const enableBtn = document.querySelector('[data-push-enable]');
      const disableBtn = document.querySelector('[data-push-disable]');
      const testBtn = document.querySelector('[data-push-test]');

      const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

      const urlBase64ToUint8Array = (base64String) => {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      };

      const setBadge = (text, ok) => {
        if (!badgeEl) return;
        badgeEl.textContent = text;
        badgeEl.className = 'text-xs font-semibold px-2.5 py-1 rounded-full ' + (ok ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600');
      };

      const refresh = async () => {
        if (!supported) { statusEl.textContent = 'Este navegador no soporta notificaciones push.'; setBadge('No soportado', false); enableBtn.disabled = true; return; }
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (Notification.permission === 'denied') {
          statusEl.textContent = 'Bloqueaste las notificaciones para este sitio. Actívalas desde la configuración del navegador.';
          setBadge('Bloqueado', false);
        } else if (sub) {
          statusEl.textContent = 'Activadas en este dispositivo. Recibirás avisos de cotizaciones nuevas.';
          setBadge('Activadas', true);
        } else {
          statusEl.textContent = 'No estás recibiendo notificaciones en este dispositivo.';
          setBadge('Inactivas', false);
        }
        enableBtn.classList.toggle('hidden', !!sub);
        disableBtn.classList.toggle('hidden', !sub);
      };

      enableBtn?.addEventListener('click', async () => {
        if (!supported) return;
        enableBtn.disabled = true; enableBtn.textContent = 'Activando…';
        try {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') { statusEl.textContent = 'Permiso no concedido.'; await refresh(); return; }
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) });
          const res = await fetch('/admin/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: sub }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'No se pudo suscribir.');
          if (countEl && typeof data.total === 'number') countEl.textContent = data.total;
        } catch (e) {
          statusEl.textContent = 'Error al activar: ' + (e instanceof Error ? e.message : String(e));
        } finally {
          enableBtn.disabled = false; enableBtn.textContent = 'Activar notificaciones';
          await refresh();
        }
      });

      disableBtn?.addEventListener('click', async () => {
        disableBtn.disabled = true; disableBtn.textContent = 'Desactivando…';
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await fetch('/admin/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
            await sub.unsubscribe().catch(() => {});
          }
        } finally {
          disableBtn.disabled = false; disableBtn.textContent = 'Desactivar';
          await refresh();
        }
      });

      testBtn?.addEventListener('click', async () => {
        testBtn.disabled = true; const prev = testBtn.textContent; testBtn.textContent = 'Enviando…';
        try {
          const res = await fetch('/admin/push/test', { method: 'POST' });
          if (res.status === 401) throw new Error('Sesión expirada. Recargá la página.');
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Error');
          statusEl.textContent = 'Prueba enviada a ' + data.sent + ' de ' + data.total + ' dispositivo(s).';
        } catch (e) {
          statusEl.textContent = 'No se pudo enviar la prueba: ' + (e instanceof Error ? e.message : String(e));
        } finally {
          testBtn.disabled = false; testBtn.textContent = prev;
        }
      });

      refresh();
    })();
    </script>
  `, c.get("session") as SessionData | undefined));
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
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.get("/zona-extendida/:cp", async (c) => {
  const cp = c.req.param("cp").trim();
  if (!/^\d{4,5}$/.test(cp)) {
    return c.json({ error: "Código postal inválido" }, 400);
  }

  try {
    const valores = Buffer.from(cp, "utf-8").toString("base64");
    const url = `https://zonaextendida.com/consultarGuia.php?valores=${encodeURIComponent(valores)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://zonaextendida.com/",
        "Accept": "application/json, text/plain, */*",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      return c.json({ error: `Upstream HTTP ${res.status}` }, 502);
    }

    const data = await res.json() as {
      encontrado?: boolean;
      mensaje?: string;
      informacion?: {
        cp?: string;
        estado?: string;
        municipio?: string;
        Estafeta?: { zonaExtendida?: string };
        Fedex?: { zonaExtendida?: string };
        DHL?: { zonaExtendida?: string };
      };
    };

    if (!data.encontrado || !data.informacion) {
      return c.json({ found: false, message: data.mensaje || "CP no encontrado" });
    }

    const info = data.informacion;
    const estafetaZE = info.Estafeta?.zonaExtendida ?? "";
    const fedexZE = info.Fedex?.zonaExtendida ?? "";
    const dhlZE = info.DHL?.zonaExtendida ?? "";

    const isExtended = (v: string) => v !== "" && v !== "0" && v.toUpperCase() !== "N";

    return c.json({
      found: true,
      cp: info.cp || cp,
      estado: info.estado || "",
      municipio: info.municipio || "",
      estafeta: { extended: isExtended(estafetaZE), raw: estafetaZE },
      fedex: { extended: isExtended(fedexZE), raw: fedexZE },
      dhl: { extended: isExtended(dhlZE), raw: dhlZE },
    });
  } catch (error) {
    console.error("[zona-extendida] failed", error);
    return c.json({ error: "Error al consultar" }, 500);
  }
});

adminRoutes.post("/description/adapt", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const categories = getCategories();
    const subcategories = getSubcategories();
    const result = await adaptDescriptionForCatalog(
      formString(body.name),
      formString(body.description),
      formString(body.imageUrl),
      categories,
      subcategories,
    );
    return c.json(result);
  } catch (error) {
    console.error("[description/adapt] failed", error);
    return c.json({ error: error instanceof Error ? error.message : "No se pudo adaptar la descripción." }, 400);
  }
});

adminRoutes.post("/design/generate", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const imageInput = formString(body.image) || formString(body.imageUrl);
    const userPrompt = formString(body.userPrompt);
    if (!imageInput) {
      return c.json({ error: "Sube una imagen primero." }, 400);
    }
    const config = getConfig();
    const template = config.design_creator_prompt || "";
    const result = await generateDesign(imageInput, template, userPrompt);
    return c.json(result);
  } catch (error) {
    console.error("[design/generate] failed", error);
    return c.json({ error: error instanceof Error ? error.message : "No se pudo generar el diseño." }, 400);
  }
});

adminRoutes.post("/design/refine", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const previousImageUrl = formString(body.imageUrl);
    const feedback = formString(body.feedback);
    const result = await refineDesign(previousImageUrl, feedback);
    return c.json(result);
  } catch (error) {
    console.error("[design/refine] failed", error);
    return c.json({ error: error instanceof Error ? error.message : "No se pudo refinar el diseño." }, 400);
  }
});

adminRoutes.post("/image/enhance", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const result = await enhanceImageForCatalog(formString(body.imageUrl));
    return c.json(result);
  } catch (error) {
    console.error("[image/enhance] failed", error);
    return c.json({ error: error instanceof Error ? error.message : "No se pudo mejorar la imagen." }, 400);
  }
});

const renderCollectionPage = (collectionUrl: string, items: MakerWorldCollectionItem[], error = "", session?: SessionData) => {
  return AdminLayout("Colección MakerWorld", `
    <div class="bg-white shadow rounded-lg p-6 space-y-6">
      <div class="flex items-start gap-4">
        <a href="/admin/makerworld" class="text-sm text-blue-600 hover:underline whitespace-nowrap mt-1">← Buscar otro link</a>
        <div>
          <h2 class="text-xl font-bold text-gray-800">Colección MakerWorld</h2>
          <p class="text-sm text-gray-500">${items.length} artículo${items.length !== 1 ? "s" : ""} encontrado${items.length !== 1 ? "s" : ""}. Haz clic en un artículo para importarlo al catálogo.</p>
          <p class="text-xs text-gray-400 mt-1 break-all">${escapeHtml(collectionUrl)}</p>
        </div>
      </div>
      ${error ? `<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">${escapeHtml(error)}</div>` : ""}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        ${items.map(item => `
          <form action="/admin/makerworld" method="post">
            <input type="hidden" name="makerworld_url" value="${escapeHtml(item.itemUrl)}">
            <button type="submit" class="w-full text-left border border-gray-200 rounded-lg overflow-hidden hover:border-blue-500 hover:shadow-md transition-all bg-white group">
              ${item.thumbnail
                ? `<img src="${escapeHtml(item.thumbnail)}" alt="${escapeHtml(item.title)}" class="w-full h-40 object-cover bg-gray-50 group-hover:opacity-90 transition-opacity" loading="lazy">`
                : `<div class="w-full h-40 bg-gray-100 flex items-center justify-center text-gray-400 text-sm">Sin imagen</div>`
              }
              <div class="p-3">
                <p class="font-medium text-sm text-gray-800 line-clamp-2">${escapeHtml(item.title)}</p>
                ${item.summary ? `<p class="text-xs text-gray-500 mt-1 line-clamp-2">${escapeHtml(item.summary)}</p>` : ""}
              </div>
            </button>
          </form>
        `).join("")}
      </div>
    </div>
  `, session);
};

const renderMakerWorldForm = (draft?: MakerWorldDraft, error = "", session?: SessionData) => {
  const defaultTiers = getDefaultPriceTiers();
  const categories = getCategories();
  const subcategories = getSubcategories();
  return AdminLayout("Importar MakerWorld", `
    <div class="bg-white shadow rounded-lg p-6 space-y-6">
      <div>
        <h2 class="text-xl font-bold text-gray-800">Importar desde MakerWorld</h2>
        <p class="text-sm text-gray-500 mt-1">Pega un link de MakerWorld (artículo o colección). Si es una colección, muestra la lista de artículos para que elijas cuáles importar. Todo queda editable antes de mandar al catálogo.</p>
      </div>
      ${error ? `<div class="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">${escapeHtml(error)}</div>` : ""}
      <form id="mw-form" action="/admin/makerworld" method="post" class="flex flex-col sm:flex-row gap-3">
        <input type="url" name="makerworld_url" id="mw-url" required value="${escapeHtml(draft?.sourceUrl || "")}" placeholder="https://makerworld.com/es/models/... o /es/collections/..." class="flex-1 px-3 py-2 border border-gray-300 rounded-md">
        <input type="hidden" name="client_html" id="mw-html">
        <button type="submit" id="mw-btn" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Analizar link</button>
      </form>
      <script>
      document.getElementById('mw-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const btn = document.getElementById('mw-btn');
        const url = document.getElementById('mw-url').value;
        btn.disabled = true; btn.textContent = 'Descargando página...';
        try {
          const res = await fetch(url);
          if (res.ok) document.getElementById('mw-html').value = await res.text();
        } catch(err) { console.warn('Client fetch failed, server will try', err); }
        btn.textContent = 'Analizando...';
        this.submit();
      });
      </script>
      ${draft ? `
      <form action="/admin/makerworld/save" method="post" enctype="multipart/form-data" class="space-y-6 border-t pt-6">
        <input type="hidden" name="source_url" value="${escapeHtml(draft.sourceUrl)}">
        <div>
          <label class="block text-sm font-medium text-gray-700">Nombre del llavero / producto *</label>
          <input type="text" name="name" required value="${escapeHtml(draft.name)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
        </div>
        ${renderCategoryFields(categories, subcategories)}
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
          ${draft.printProfiles.length > 0 ? `
          <div class="mb-4">
            <label class="block text-xs font-bold text-gray-700 mb-1">Perfil de impresión detectado — selecciona uno para auto-rellenar los campos</label>
            <select id="print-profile-select" class="block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
              <option value="">— Elige un perfil —</option>
              ${draft.printProfiles.map(p => `
                <option value="${escapeHtml(p.id)}"
                  data-grams="${p.filamentGrams}"
                  data-mins="${p.printTimeMins}"
                  data-type="${escapeHtml(p.filamentType)}"
                  data-color="${escapeHtml(p.filamentColor)}">
                  ${escapeHtml(p.name)}${p.filamentType ? ` | ${escapeHtml(p.filamentType)}` : ""}${p.filamentColor ? ` ${escapeHtml(p.filamentColor)}` : ""} | ${p.filamentGrams}g | ${p.printTimeMins}min
                </option>
              `).join("")}
            </select>
            <script>
            (function() {
              var sel = document.getElementById('print-profile-select');
              function applyProfile() {
                var opt = sel.options[sel.selectedIndex];
                if (!opt || !opt.value) return;
                document.querySelector('[name="filament_grams"]').value = opt.dataset.grams || '0';
                document.querySelector('[name="print_time_mins"]').value = opt.dataset.mins || '0';
              }
              sel.addEventListener('change', applyProfile);
              if (sel.options.length === 2) { sel.selectedIndex = 1; applyProfile(); }
            })();
            </script>
          </div>` : ""}
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
  `, session);
};

adminRoutes.get("/makerworld", (c) => c.html(renderMakerWorldForm(undefined, "", c.get("session") as SessionData | undefined)));

adminRoutes.post("/makerworld", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const rawUrl = formString(body.makerworld_url);
  const clientHtml = formString(body.client_html) || undefined;
  try {
    if (isMakerWorldCollection(rawUrl)) {
      const items = await scrapeMakerWorldCollection(rawUrl, clientHtml);
      return c.html(renderCollectionPage(rawUrl, items, "", c.get("session") as SessionData | undefined));
    }
    const draft = await scrapeMakerWorld(rawUrl, clientHtml);
    return c.html(renderMakerWorldForm(draft, "", c.get("session") as SessionData | undefined));
  } catch (error) {
    console.error("[MakerWorld scrape error]", error);
    return c.html(renderMakerWorldForm(undefined, error instanceof Error ? error.message : "No se pudo analizar el link de MakerWorld", c.get("session") as SessionData | undefined), 400);
  }
});

adminRoutes.post("/makerworld/save", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  let imageUrl = formString(body.image_url) || formString(body.selected_image);
  const file = formFile(body.image_file);
  if (file) imageUrl = await saveImageUpload(file, "products", "prod");
  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;
  const { categoryId, subcategoryId } = parseCategoryAndSub(body);
  const result = db.query(`
    INSERT INTO products (name, description, image_url, makerworld_url, filament_grams, print_time_mins, extra_costs, use_default_pricing, sort_order, category_id, subcategory_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.source_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing, categoryId, subcategoryId) as {id: number};
  if (!useDefaultPricing) replaceProductPriceTiers(result.id, parsePriceTiers(body));
  return c.redirect(`/admin/products/${result.id}/edit`);
});

adminRoutes.get("/config", requireRole(["superusuario", "admin"]), (c) => {
  const config = getConfig();
  const tiers = getDefaultPriceTiers();

  // Landing: prefill de beneficios. Render de 6 filas fijas (icon/title/text).
  const LANDING_BENEFIT_ROWS = 6;
  let landingBenefits: Array<{ icon?: string; title?: string; text?: string }> = [];
  try {
    const parsed = JSON.parse(config.landing_benefits_items || "[]");
    if (Array.isArray(parsed)) landingBenefits = parsed;
  } catch {
    landingBenefits = [];
  }
  const landingChecked = (key: string) => (config[key] !== "0" ? "checked" : "");

  // Indica de dónde proviene el valor actual de cada setting "env-style".
  const sourceLabel = (key: string, envKey: string, envKeyLegacy = "") => {
    if ((config[key] || "").trim()) return '<span class="ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-green-700 bg-green-100 px-1.5 py-0.5 rounded">guardado</span>';
    if ((process.env[envKey] || "").trim()) return '<span class="ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">usando .env</span>';
    if (envKeyLegacy && (process.env[envKeyLegacy] || "").trim()) return '<span class="ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">usando .env</span>';
    return '<span class="ml-2 inline-flex items-center text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">sin valor</span>';
  };

  // Pre-llena los inputs con el mismo valor que el server usa en runtime:
  // DB → .env → fallback. Si la DB está vacía y .env trae el valor, el input
  // muestra el valor del .env (no en blanco). Al guardar sin tocar, el valor
  // efectivo se persiste en DB (override consciente del .env).
  const effective = (key: string, envKey: string, envKeyLegacy = "", fallback = "") => {
    const dbValue = (config[key] || "").trim();
    if (dbValue) return dbValue;
    const envValue = (process.env[envKey] || "").trim();
    if (envValue) return envValue;
    if (envKeyLegacy) {
      const envValueLegacy = (process.env[envKeyLegacy] || "").trim();
      if (envValueLegacy) return envValueLegacy;
    }
    return fallback;
  };
  const eff = (key: string, envKey: string, envKeyLegacy = "", fallback = "") => escapeHtml(effective(key, envKey, envKeyLegacy, fallback));

  return c.html(AdminLayout("Configuración", `
    <div class="bg-white shadow rounded-lg p-6 mb-6">
        <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4">
            <div>
                <h2 class="text-xl font-bold">Configuración</h2>
                <p class="text-sm text-gray-500">Todo lo que afecta a la marca, los modelos de IA y los accesos vive aquí. Las settings de IA y de servidor <strong>sobrescriben al <code>.env</code></strong> y se aplican al instante, sin reiniciar el contenedor.</p>
            </div>
            <p class="text-xs text-gray-500">Un solo botón "Guardar Configuración" persiste todas las pestañas a la vez.</p>
        </div>

        <form action="/admin/config" method="post" enctype="multipart/form-data" class="space-y-6">
            <input type="hidden" name="__config_form" value="1">

            <!-- Tab navigation -->
            <div class="border-b border-gray-200">
                <nav class="-mb-px flex flex-wrap gap-1 sm:gap-2" id="config-tabs" role="tablist">
                    <button type="button" data-config-tab="marca" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-blue-600 text-blue-700 text-sm font-medium" aria-selected="true">Marca y Catálogo</button>
                    <button type="button" data-config-tab="landing" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Landing</button>
                    <button type="button" data-config-tab="tema" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Tema Visual</button>
                    <button type="button" data-config-tab="precios" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Precios</button>
                    <button type="button" data-config-tab="ia-modelos" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">IA · Modelos</button>
                    <button type="button" data-config-tab="ia-prompts" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">IA · Prompts</button>
                    <button type="button" data-config-tab="integraciones" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Integraciones</button>
                    <button type="button" data-config-tab="acceso" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Acceso & Servidor</button>
                    <button type="button" data-config-tab="legal" class="config-tab whitespace-nowrap py-2 px-3 border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 text-sm font-medium" aria-selected="false">Legal</button>
                </nav>
            </div>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: MARCA Y CATÁLOGO                                          -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="marca" class="space-y-6">
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
                        <p class="text-xs text-gray-500 mt-1">Este logo también se usa como <strong>ícono de la app instalable (PWA)</strong>. Para que se vea bien como ícono, usa una imagen cuadrada con algo de margen. Idealmente PNG (mejor compatibilidad en iPhone).</p>
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
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: LANDING (homepage configurable)                          -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="landing" class="space-y-8 hidden">
                <p class="text-sm text-gray-500">Esta es la página de inicio (<code>/</code>). Configura su contenido por secciones. El catálogo sigue en <code>/catalogo</code>.</p>

                <!-- SEO DE LA LANDING -->
                <div class="border border-blue-200 bg-blue-50 rounded-lg p-4 space-y-4">
                    <h3 class="text-md font-semibold text-blue-800">SEO — Título, descripción e imagen social</h3>
                    <p class="text-xs text-blue-600">Estos campos sobreescriben la generación automática. Si se dejan vacíos, el SEO se genera desde el contenido del hero.</p>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Título SEO <span class="text-gray-400 font-normal">(max 60 caracteres · recomendado: incluir "San Luis Potosí")</span></label>
                        <input type="text" name="seo_title_landing" value="${configValue(config, "seo_title_landing")}" maxlength="70" placeholder="Llaveros y Figuras 3D Personalizados en San Luis Potosí | PIXKEY3D" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm">
                        <p class="text-xs text-gray-400 mt-1">Caracteres: <span id="seo-title-count">${(config.seo_title_landing || "").length}</span> / 60</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Meta descripción <span class="text-gray-400 font-normal">(max 155 caracteres · incluir ciudad y CTA)</span></label>
                        <textarea name="seo_description_landing" rows="2" maxlength="160" placeholder="Llaveros y figuras 3D bajo pedido en San Luis Potosí. Precios desde $25 MXN · Mín. 25 piezas · Envíos a todo México. Cotiza por WhatsApp." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm">${configValue(config, "seo_description_landing")}</textarea>
                        <p class="text-xs text-gray-400 mt-1">Caracteres: <span id="seo-desc-count">${(config.seo_description_landing || "").length}</span> / 155</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Imagen Open Graph / social <span class="text-gray-400 font-normal">(1200×630 px recomendado — para WhatsApp, Facebook, etc.)</span></label>
                        <input type="text" name="og_image_landing_url" value="${configValue(config, "og_image_landing")}" placeholder="URL de imagen 1200×630px o deja vacío para usar la imagen del hero" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                        <input type="file" name="og_image_landing_file" accept="image/*" class="block w-full text-sm text-gray-500">
                        ${config.og_image_landing ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${escapeHtml(config.og_image_landing)}" target="_blank" class="text-blue-600 underline">ver imagen</a> · <button type="button" onclick="document.querySelector('[name=og_image_landing_url]').value=''" class="text-red-500 underline">quitar</button></p>` : ""}
                    </div>
                    <script>
                    document.querySelector('[name=seo_title_landing]')?.addEventListener('input', function() {
                        document.getElementById('seo-title-count').textContent = this.value.length;
                    });
                    document.querySelector('[name=seo_description_landing]')?.addEventListener('input', function() {
                        document.getElementById('seo-desc-count').textContent = this.value.length;
                    });
                    </script>
                </div>

                <!-- HERO -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Hero (encabezado principal)</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_hero_enabled" value="1" ${landingChecked("landing_hero_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Título</label>
                            <input type="text" name="landing_hero_title" value="${configValue(config, "landing_hero_title")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Texto del botón</label>
                            <input type="text" name="landing_hero_cta_label" value="${configValue(config, "landing_hero_cta_label")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">Subtítulo</label>
                            <textarea name="landing_hero_subtitle" rows="2" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "landing_hero_subtitle")}</textarea>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Destino del botón</label>
                            <select name="landing_hero_cta_target" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                                <option value="/catalogo" ${config.landing_hero_cta_target !== "whatsapp" ? "selected" : ""}>Catálogo (/catalogo)</option>
                                <option value="whatsapp" ${config.landing_hero_cta_target === "whatsapp" ? "selected" : ""}>WhatsApp</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Imagen del hero (URL o subir)</label>
                            <input type="text" name="landing_hero_image_url" value="${configValue(config, "landing_hero_image")}" placeholder="Por defecto usa el logo" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                            <input type="file" name="landing_hero_image_file" accept="image/*" class="block w-full text-sm text-gray-500">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Modo del hero</label>
                            <select name="landing_hero_mode" onchange="document.getElementById('hero-carousel-slots').style.display=this.value==='carousel'?'':'none'" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md bg-white">
                                <option value="image" ${configValue(config, "landing_hero_mode") !== "carousel" ? "selected" : ""}>Imagen única</option>
                                <option value="carousel" ${configValue(config, "landing_hero_mode") === "carousel" ? "selected" : ""}>Carrusel (hasta 5 imágenes)</option>
                            </select>
                        </div>
                        <div id="hero-carousel-slots" class="sm:col-span-2 space-y-3 border border-gray-200 rounded-lg p-4 bg-gray-50" style="display:${configValue(config, "landing_hero_mode") === "carousel" ? "" : "none"}">
                            <p class="text-sm font-medium text-gray-700">Imágenes del carrusel</p>
                            <div>
                                <label class="block text-xs text-gray-500">Intervalo entre imágenes (ms)</label>
                                <input type="number" name="landing_hero_carousel_interval" value="${configValue(config, "landing_hero_carousel_interval", "4000")}" min="1000" step="500" class="mt-1 block w-40 px-3 py-2 border border-gray-300 rounded-md">
                            </div>
                            ${[1, 2, 3, 4, 5].map((i) => `
                            <div class="border border-gray-100 rounded p-3 bg-white">
                                <label class="block text-xs font-medium text-gray-600 mb-1">Imagen ${i}</label>
                                <input type="text" name="landing_hero_carousel_image_${i}_url" value="${configValue(config, `landing_hero_carousel_image_${i}`)}" placeholder="Vacío para omitir" class="block w-full px-3 py-2 border border-gray-300 rounded-md mb-1 text-sm">
                                <input type="file" name="landing_hero_carousel_image_${i}_file" accept="image/*" class="block w-full text-sm text-gray-500">
                            </div>`).join("")}
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Icono / logo en la landing <span class="text-gray-400 font-normal">(navbar y footer — usa el logo principal si se deja vacío)</span></label>
                            <input type="text" name="landing_logo_url" value="${configValue(config, "landing_logo")}" placeholder="URL o deja vacío para usar el logo principal" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                            <input type="file" name="landing_logo_file" accept="image/*" class="block w-full text-sm text-gray-500">
                            ${config.landing_logo ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${escapeHtml(config.landing_logo)}" target="_blank" class="text-blue-600 underline">ver imagen</a> · <button type="button" onclick="document.querySelector('[name=landing_logo_url]').value=''" class="text-red-500 underline">quitar</button></p>` : ""}
                        </div>
                    </div>
                </div>

                <!-- BENEFICIOS -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Beneficios</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_benefits_enabled" value="1" ${landingChecked("landing_benefits_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Título de la sección</label>
                        <input type="text" name="landing_benefits_title" value="${configValue(config, "landing_benefits_title")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                    </div>
                    <p class="text-xs text-gray-500">Hasta ${LANDING_BENEFIT_ROWS} beneficios. Las filas vacías se ignoran.</p>
                    <div class="space-y-2">
                        ${Array.from({ length: LANDING_BENEFIT_ROWS }, (_, i) => {
                          const it = landingBenefits[i] || {};
                          return `
                        <div class="grid grid-cols-12 gap-2">
                            <input type="text" name="landing_benefit_icon" value="${escapeHtml(it.icon || "")}" placeholder="Icono" class="col-span-2 px-2 py-2 border border-gray-300 rounded-md text-center">
                            <input type="text" name="landing_benefit_title" value="${escapeHtml(it.title || "")}" placeholder="Título" class="col-span-4 px-3 py-2 border border-gray-300 rounded-md">
                            <input type="text" name="landing_benefit_text" value="${escapeHtml(it.text || "")}" placeholder="Descripción" class="col-span-6 px-3 py-2 border border-gray-300 rounded-md">
                        </div>`;
                        }).join("")}
                    </div>
                </div>

                <!-- PRODUCTOS DESTACADOS -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Productos destacados</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_featured_enabled" value="1" ${landingChecked("landing_featured_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Título de la sección</label>
                        <input type="text" name="landing_featured_title" value="${configValue(config, "landing_featured_title")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                    </div>
                    <p class="text-xs text-gray-500">Marca productos como destacados editándolos en <a href="/admin/products" class="text-blue-600 underline">Productos</a> (casilla "Destacar en landing").</p>
                </div>

                <!-- SOBRE NOSOTROS -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Sobre nosotros</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_about_enabled" value="1" ${landingChecked("landing_about_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Título</label>
                            <input type="text" name="landing_about_title" value="${configValue(config, "landing_about_title")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Imagen (URL o subir)</label>
                            <input type="text" name="landing_about_image_url" value="${configValue(config, "landing_about_image")}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                            <input type="file" name="landing_about_image_file" accept="image/*" class="block w-full text-sm text-gray-500">
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto (acepta HTML)</label>
                        <textarea name="landing_about_text" rows="5" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "landing_about_text")}</textarea>
                    </div>
                </div>

                <!-- CTA -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Llamada a la acción (CTA)</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_cta_enabled" value="1" ${landingChecked("landing_cta_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Título</label>
                            <input type="text" name="landing_cta_title" value="${configValue(config, "landing_cta_title")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Texto del botón</label>
                            <input type="text" name="landing_cta_button_label" value="${configValue(config, "landing_cta_button_label")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">Texto</label>
                            <textarea name="landing_cta_text" rows="2" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "landing_cta_text")}</textarea>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Destino del botón</label>
                            <select name="landing_cta_button_target" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                                <option value="whatsapp" ${config.landing_cta_button_target !== "/catalogo" ? "selected" : ""}>WhatsApp</option>
                                <option value="/catalogo" ${config.landing_cta_button_target === "/catalogo" ? "selected" : ""}>Catálogo (/catalogo)</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- CONTACTO -->
                <div class="border border-gray-200 rounded-lg p-4 space-y-4">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Contacto</h3>
                        <label class="inline-flex items-center"><input type="checkbox" name="landing_contact_enabled" value="1" ${landingChecked("landing_contact_enabled")} class="h-4 w-4 text-blue-600 border-gray-300 rounded"><span class="ml-2 text-sm text-gray-700">Mostrar</span></label>
                    </div>
                    <p class="text-xs text-gray-500">Reutiliza el "Texto de Contacto" y el WhatsApp configurados en la pestaña <strong>Marca y Catálogo</strong>.</p>
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: TEMA VISUAL                                              -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="tema" class="space-y-6 hidden">
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start">
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

                <h4 class="text-md font-semibold mt-2">Colores Base</h4>
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

                <h4 class="text-md font-semibold mt-2">Fondos y Textos de Secciones</h4>
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

                <h4 class="text-md font-semibold mt-2">Tipografía y Colores Generales</h4>
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
                <p class="text-xs text-gray-500">Formatos permitidos: .woff, .woff2, .ttf y .otf. Si subes un archivo, se usa primero; el campo de texto queda como respaldo.</p>

                <h4 class="text-md font-semibold mt-2">Estilos Visuales</h4>
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

                <h4 class="text-md font-semibold mt-2">Modo Oscuro</h4>
                <div class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg bg-gray-50">
                    <input type="checkbox" name="dark_mode_enabled" id="dark_mode_enabled" value="1" ${config.dark_mode_enabled !== '0' ? 'checked' : ''} class="h-4 w-4 text-blue-600 border-gray-300 rounded">
                    <label for="dark_mode_enabled" class="text-sm font-medium text-gray-700">Activar toggle sol/luna en el nav del landing <span class="text-gray-400 font-normal">(respeta prefers-color-scheme del navegador por defecto)</span></label>
                </div>

                <h4 class="text-md font-semibold mt-4">Colores — Modo Oscuro</h4>
                <p class="text-xs text-gray-500 -mt-2">Estos colores se aplican cuando el visitante activa el modo oscuro. Independientes del modo claro.</p>
                <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Portada/Hero</label>
                        <input type="color" name="dark_bg_cover" value="${configValue(config, "dark_bg_cover", "#0c1117")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Hero, nav, footer</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto Portada/Hero</label>
                        <input type="color" name="dark_color_cover_text" value="${configValue(config, "dark_color_cover_text", "#f1f5f9")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Texto en hero, nav, footer</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Banner CTA</label>
                        <input type="color" name="dark_bg_cta" value="${configValue(config, "dark_bg_cta", "#1e3a5f")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Sección "¿Listo para tu pedido?"</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Sección Media</label>
                        <input type="color" name="dark_bg_welcome" value="${configValue(config, "dark_bg_welcome", "#111827")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Ubicación, Sobre nosotros</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Sección Clara</label>
                        <input type="color" name="dark_bg_products" value="${configValue(config, "dark_bg_products", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Productos destacados, body</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Sección Oscura</label>
                        <input type="color" name="dark_bg_section_dark" value="${configValue(config, "dark_bg_section_dark", "#0f172a")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Precios, Proceso, FAQ</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Tarjetas</label>
                        <input type="color" name="dark_bg_card" value="${configValue(config, "dark_bg_card", "#1e293b")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                        <p class="text-xs text-gray-400 mt-1">Tabla de precios, pasos</p>
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Borde Tarjetas</label>
                        <input type="color" name="dark_color_card_border" value="${configValue(config, "dark_color_card_border", "#374151")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Fondo Encabezado Tabla</label>
                        <input type="color" name="dark_bg_table_header" value="${configValue(config, "dark_bg_table_header", "#374151")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto Encabezado Tabla</label>
                        <input type="color" name="dark_color_table_header_text" value="${configValue(config, "dark_color_table_header_text", "#d1d5db")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                </div>
                <div class="grid grid-cols-1 gap-6 sm:grid-cols-3 mt-4">
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto Principal</label>
                        <input type="color" name="dark_color_body_text" value="${configValue(config, "dark_color_body_text", "#e2e8f0")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto Encabezados</label>
                        <input type="color" name="dark_color_heading_text" value="${configValue(config, "dark_color_heading_text", "#f8fafc")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">Texto Secundario</label>
                        <input type="color" name="dark_color_muted_text" value="${configValue(config, "dark_color_muted_text", "#94a3b8")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                    </div>
                </div>

                <h4 class="text-md font-semibold mt-2">Formas Decorativas (Portadas y Secciones)</h4>
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
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: PRECIOS                                                  -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="precios" class="space-y-6 hidden">
                <div>
                    <h3 class="text-lg font-semibold mb-1">Tabla Global de Precios por Volumen</h3>
                    <p class="text-sm text-gray-500 mb-3">Estos rangos se usan en productos que tengan marcada la opción de precios globales. Si dejas la tabla vacía al guardar, no se sobrescribe (anti-wipe).</p>
                    ${renderPricingEditor(tiers)}
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: IA · MODELOS                                             -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="ia-modelos" class="space-y-8 hidden">
                <div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <div class="flex items-start justify-between gap-3 mb-3">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">Modelo de Texto (Descripciones para catálogo)</h3>
                            <p class="text-xs text-gray-500">Endpoint OpenAI-compatible. Se usa al adaptar descripciones de productos al estilo del catálogo.</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Base URL ${sourceLabel("llm_base_url", "LLM_BASE_URL")}</label>
                            <input type="text" name="llm_base_url" value="${eff("llm_base_url", "LLM_BASE_URL", "", "https://api.openai.com/v1")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="https://api.openai.com/v1">
                            <p class="text-xs text-gray-500 mt-1">Default: <code>https://api.openai.com/v1</code></p>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Modelo primario ${sourceLabel("llm_model", "LLM_MODEL")}</label>
                            <input type="text" name="llm_model" value="${eff("llm_model", "LLM_MODEL", "", "gpt-4o-mini")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="gpt-4o-mini">
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">Modelos de fallback ${sourceLabel("llm_fallback_models", "LLM_FALLBACK_MODELS")}</label>
                            <textarea name="llm_fallback_models" rows="3" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="Uno por línea o separado por comas. Ej:&#10;gpt-4o&#10;claude-3-5-sonnet">${eff("llm_fallback_models", "LLM_FALLBACK_MODELS")}</textarea>
                            <p class="text-xs text-gray-500 mt-1">Si el modelo primario falla (HTTP no-2xx, timeout o respuesta vacía), el sistema intenta cada modelo de esta lista en orden. Usa la misma Base URL y API Key.</p>
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">API Key ${sourceLabel("llm_api_key", "LLM_API_KEY")}</label>
                            <div class="mt-1 flex gap-2">
                                <input type="password" name="llm_api_key" value="" class="block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="sk-... (vacío = no cambiar)" autocomplete="new-password" data-secret>
                                <button type="button" class="px-3 py-2 border border-gray-300 rounded-md text-xs text-gray-700 bg-white hover:bg-gray-50" data-toggle-secret>Mostrar</button>
                            </div>
                            <p class="text-xs text-gray-500 mt-1">Anti-wipe: si dejas el campo vacío al guardar, el valor actual se conserva.</p>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Temperature ${sourceLabel("llm_temperature", "LLM_TEMPERATURE")}</label>
                            <input type="number" step="0.05" min="0" max="2" name="llm_temperature" value="${eff("llm_temperature", "LLM_TEMPERATURE", "", "0.7")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="0.7">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Máx. palabras descripción ${sourceLabel("llm_description_max_words", "LLM_DESCRIPTION_MAX_WORDS")}</label>
                            <input type="number" step="1" min="10" max="200" name="llm_description_max_words" value="${eff("llm_description_max_words", "LLM_DESCRIPTION_MAX_WORDS", "", "45")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="45">
                        </div>
                    </div>
                </div>

                <div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <div class="flex items-start justify-between gap-3 mb-3">
                        <div>
                            <h3 class="text-lg font-semibold text-gray-900">Modelo de Imagen (Creador de diseños y mejoras de catálogo)</h3>
                            <p class="text-xs text-gray-500">Endpoint OpenAI-compatible <code>/v1/images/edits</code>. Se puede dar <strong>Base URL</strong> (recomendado, el sistema completa la ruta) o <strong>Endpoint</strong> completo, y opcionalmente una <strong>Route</strong> override.</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Base URL ${sourceLabel("image_base_url", "QWEN_IMAGE_BASE_URL", "IMAGE_ENHANCE_BASE_URL")}</label>
                            <input type="text" name="image_base_url" value="${eff("image_base_url", "QWEN_IMAGE_BASE_URL", "IMAGE_ENHANCE_BASE_URL")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="https://api.openai.com">
                            <p class="text-xs text-gray-500 mt-1">Si está, se ignora <em>Endpoint</em>. Default de ruta: <code>/v1/images/edits</code>.</p>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Endpoint completo ${sourceLabel("image_endpoint", "QWEN_IMAGE_ENDPOINT", "IMAGE_ENHANCE_ENDPOINT")}</label>
                            <input type="text" name="image_endpoint" value="${eff("image_endpoint", "QWEN_IMAGE_ENDPOINT", "IMAGE_ENHANCE_ENDPOINT")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="https://provider/v1/images/edits">
                            <p class="text-xs text-gray-500 mt-1">Solo se usa si <em>Base URL</em> está vacío.</p>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Route override ${sourceLabel("image_route", "QWEN_IMAGE_ROUTE", "IMAGE_ENHANCE_ROUTE")}</label>
                            <input type="text" name="image_route" value="${eff("image_route", "QWEN_IMAGE_ROUTE", "IMAGE_ENHANCE_ROUTE")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="/v1/images/edits">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Modelo primario ${sourceLabel("image_model", "QWEN_IMAGE_MODEL", "IMAGE_ENHANCE_MODEL")}</label>
                            <input type="text" name="image_model" value="${eff("image_model", "QWEN_IMAGE_MODEL", "IMAGE_ENHANCE_MODEL")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="qwen-image">
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">Modelos de fallback ${sourceLabel("image_fallback_models", "QWEN_IMAGE_FALLBACK_MODELS", "IMAGE_ENHANCE_FALLBACK_MODELS")}</label>
                            <textarea name="image_fallback_models" rows="3" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="Uno por línea o separado por comas. Ej:&#10;seedream-3&#10;dall-e-3">${eff("image_fallback_models", "QWEN_IMAGE_FALLBACK_MODELS", "IMAGE_ENHANCE_FALLBACK_MODELS")}</textarea>
                            <p class="text-xs text-gray-500 mt-1">Si el modelo primario falla, el sistema reintenta con cada modelo de esta lista. Cada modelo conserva el retry interno por flakiness (3 intentos cada uno) antes de pasar al siguiente.</p>
                        </div>
                        <div class="sm:col-span-2">
                            <label class="block text-sm font-medium text-gray-700">API Key ${sourceLabel("image_api_key", "QWEN_IMAGE_API_KEY", "IMAGE_ENHANCE_API_KEY")}</label>
                            <div class="mt-1 flex gap-2">
                                <input type="password" name="image_api_key" value="" class="block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="sk-... (vacío = no cambiar)" autocomplete="new-password" data-secret>
                                <button type="button" class="px-3 py-2 border border-gray-300 rounded-md text-xs text-gray-700 bg-white hover:bg-gray-50" data-toggle-secret>Mostrar</button>
                            </div>
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Timeout (ms) ${sourceLabel("image_timeout_ms", "QWEN_IMAGE_TIMEOUT_MS")}</label>
                            <input type="number" step="1000" min="5000" name="image_timeout_ms" value="${eff("image_timeout_ms", "QWEN_IMAGE_TIMEOUT_MS", "", "120000")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="120000">
                        </div>
                    </div>
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: IA · PROMPTS                                             -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="ia-prompts" class="space-y-6 hidden">
                <div>
                    <h3 class="text-lg font-semibold mb-1 flex items-center gap-2">
                        <svg class="h-5 w-5 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
                        Prompts de IA
                    </h3>
                    <p class="text-sm text-gray-500 mb-4">Estos prompts se envían junto con la imagen al provider configurado. Edítalos para ajustar el resultado al estilo de tu marca.</p>

                    <div class="space-y-5">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Prompt: Adaptar Descripción a Catálogo (botón "Adaptar a catálogo con IA")</label>
                            <textarea name="catalog_description_prompt" rows="4" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="${escapeHtml(DEFAULT_CATALOG_DESCRIPTION_PROMPT)}">${configValue(config, "catalog_description_prompt")}</textarea>
                            <p class="text-xs text-gray-500 mt-1">Instrucción de reescritura del botón "Adaptar a catálogo con IA" (en producto nuevo/editar y MakerWorld). Solo controla <strong>cómo se reescribe el texto</strong>; la asignación de categoría/subcategoría y el formato de salida quedan fijos. El <strong>límite de palabras</strong> se controla aparte (pestaña IA · Modelos). Déjalo vacío para usar el prompt por defecto.</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700">Prompt: Creador de Diseños (Herramientas)</label>
                            <textarea name="design_creator_prompt" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs">${configValue(config, "design_creator_prompt")}</textarea>
                            <p class="text-xs text-gray-500 mt-1">Usado por <code class="bg-gray-100 px-1 rounded">Herramientas → Creador de Diseños</code> y por el botón "Crear diseño con IA" dentro de cotizaciones manuales. Incluye <code class="bg-gray-100 px-1 rounded">{userPrompt}</code> donde quieras inyectar la descripción adicional del usuario; si no incluyes el placeholder y el usuario escribe algo, se concatena al final. Si el usuario no escribe nada, se manda solo este prompt.</p>
                        </div>

                        <div>
                            <label class="block text-sm font-medium text-gray-700">Prompt: Imagen para Catálogo / MakerWorld</label>
                            <textarea name="catalog_image_prompt" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs">${configValue(config, "catalog_image_prompt")}</textarea>
                            <p class="text-xs text-gray-500 mt-1">Usado al hacer clic en "Mejorar imagen con IA" al importar productos desde MakerWorld o al editar un producto del catálogo. Aquí no aplica <code class="bg-gray-100 px-1 rounded">{userPrompt}</code>: el prompt se envía tal cual junto con la imagen seleccionada.</p>
                        </div>
                    </div>
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: INTEGRACIONES                                            -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="integraciones" class="space-y-6 hidden">
                <div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <h3 class="text-lg font-semibold text-gray-900 mb-1">FlareSolverr (scraper de MakerWorld)</h3>
                    <p class="text-xs text-gray-500 mb-3">URL de un FlareSolverr corriendo (típicamente <code>http://flaresolverr:8191/v1</code>). Se usa para esquivar el desafío de Cloudflare al importar productos desde MakerWorld. Si lo dejas vacío, el sistema intenta fetch directo + proxies públicos.</p>
                    <div>
                        <label class="block text-sm font-medium text-gray-700">URL ${sourceLabel("flaresolverr_url", "FLARESOLVERR_URL")}</label>
                        <input type="text" name="flaresolverr_url" value="${eff("flaresolverr_url", "FLARESOLVERR_URL")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="http://flaresolverr:8191/v1">
                    </div>
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: ACCESO Y SERVIDOR                                        -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="acceso" class="space-y-6 hidden">
                <div class="border border-amber-200 rounded-lg p-4 bg-amber-50">
                    <h3 class="text-lg font-semibold text-amber-900 mb-1">⚠ Credenciales de Administrador</h3>
                    <p class="text-xs text-amber-800 mb-3">Cambiar estos valores afecta inmediatamente al próximo login. La sesión actual sigue activa hasta que cierres sesión o expire la cookie.</p>
                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Usuario ${sourceLabel("admin_username", "ADMIN_USERNAME")}</label>
                            <input type="text" name="admin_username" value="${eff("admin_username", "ADMIN_USERNAME", "", "Frxn5J")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Frxn5J" autocomplete="off">
                        </div>
                        <div>
                            <label class="block text-sm font-medium text-gray-700">Password ${sourceLabel("admin_password", "ADMIN_PASSWORD")}</label>
                            <div class="mt-1 flex gap-2">
                                <input type="password" name="admin_password" value="" class="block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="(vacío = no cambiar)" autocomplete="new-password" data-secret>
                                <button type="button" class="px-3 py-2 border border-gray-300 rounded-md text-xs text-gray-700 bg-white hover:bg-gray-50" data-toggle-secret>Mostrar</button>
                            </div>
                            <p class="text-xs text-gray-500 mt-1">Anti-wipe: si dejas el campo vacío al guardar, el valor actual se conserva.</p>
                        </div>
                    </div>
                </div>

                <div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
                    <h3 class="text-lg font-semibold text-gray-900 mb-1">Puerto del servidor</h3>
                    <p class="text-xs text-gray-500 mb-3">El puerto se lee del <code>.env</code> al iniciar el contenedor. Cambiarlo desde la UI no surte efecto sin reiniciar — edita el <code>.env</code> y reinicia el container si necesitas cambiarlo.</p>
                    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                            <label class="block text-sm font-medium text-gray-700">PORT (informativo)</label>
                            <input type="text" value="${escapeHtml(process.env.PORT || "3000")}" disabled class="mt-1 block w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-100 text-gray-500 font-mono text-xs">
                        </div>
                    </div>
                </div>
            </section>

            <!-- ═════════════════════════════════════════════════════════════ -->
            <!-- TAB: LEGAL                                                    -->
            <!-- ═════════════════════════════════════════════════════════════ -->
            <section data-config-pane="legal" class="space-y-6 hidden">
                <p class="text-sm text-gray-500">Contenido de las páginas <code>/aviso-privacidad</code> y <code>/terminos</code>. Acepta HTML. Si se deja vacío se muestra el texto predeterminado.</p>

                <div class="border border-gray-200 rounded-lg p-4 space-y-3">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Aviso de Privacidad</h3>
                        <a href="/aviso-privacidad" target="_blank" class="text-xs text-blue-600 underline">Ver página →</a>
                    </div>
                    <p class="text-xs text-gray-500">Se muestra dentro de la sección principal. Puedes escribir HTML o texto plano con saltos de línea.</p>
                    <textarea name="aviso_privacidad_content" rows="14" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="Deja vacío para usar el texto predeterminado (LFPDPPP)…">${configValue(config, "aviso_privacidad_content")}</textarea>
                </div>

                <div class="border border-gray-200 rounded-lg p-4 space-y-3">
                    <div class="flex items-center justify-between">
                        <h3 class="text-md font-semibold">Términos y Condiciones</h3>
                        <a href="/terminos" target="_blank" class="text-xs text-blue-600 underline">Ver página →</a>
                    </div>
                    <p class="text-xs text-gray-500">Se muestra dentro de la sección principal. Puedes escribir HTML o texto plano con saltos de línea.</p>
                    <textarea name="terminos_content" rows="14" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-xs" placeholder="Deja vacío para usar el texto predeterminado…">${configValue(config, "terminos_content")}</textarea>
                </div>
            </section>

            <!-- Save button -->
            <div class="pt-4 border-t flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <p class="text-xs text-gray-500">Un solo "Guardar" persiste los valores de <strong>todas</strong> las pestañas a la vez.</p>
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Configuración</button>
            </div>
        </form>
    </div>
    <script>
      (() => {
        // ── Tabs ─────────────────────────────────────────────────────────
        const tabs = Array.from(document.querySelectorAll('[data-config-tab]'));
        const panes = Array.from(document.querySelectorAll('[data-config-pane]'));
        const activateTab = (name) => {
          tabs.forEach((tab) => {
            const active = tab.dataset.configTab === name;
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            if (active) {
              tab.classList.add('border-blue-600', 'text-blue-700');
              tab.classList.remove('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300');
            } else {
              tab.classList.remove('border-blue-600', 'text-blue-700');
              tab.classList.add('border-transparent', 'text-gray-500', 'hover:text-gray-700', 'hover:border-gray-300');
            }
          });
          panes.forEach((pane) => {
            pane.classList.toggle('hidden', pane.dataset.configPane !== name);
          });
          try { history.replaceState(null, '', '#tab=' + name); } catch (_) {}
        };
        tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.configTab)));
        const initial = (location.hash.match(/tab=([\\w-]+)/) || [])[1];
        if (initial && tabs.some((t) => t.dataset.configTab === initial)) activateTab(initial);

        // ── Secret reveal ────────────────────────────────────────────────
        document.querySelectorAll('[data-toggle-secret]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const input = btn.parentElement && btn.parentElement.querySelector('input[data-secret]');
            if (!input) return;
            const isPwd = input.type === 'password';
            input.type = isPwd ? 'text' : 'password';
            btn.textContent = isPwd ? 'Ocultar' : 'Mostrar';
          });
        });

        // ── Live CSS preview ─────────────────────────────────────────────
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

        frame && frame.addEventListener('load', applyCss);
        editor && editor.addEventListener('input', applyCss);
        refresh && refresh.addEventListener('click', () => {
          if (frame && frame.contentWindow) frame.contentWindow.location.reload();
        });
        desktop && desktop.addEventListener('click', () => {
          if (!shell) return;
          shell.style.maxWidth = '100%';
          shell.style.height = '720px';
        });
        mobile && mobile.addEventListener('click', () => {
          if (!shell) return;
          shell.style.maxWidth = '390px';
          shell.style.height = '720px';
        });
      })();
    </script>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/config", requireRole(["superusuario", "admin"]), async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;

  // Anti-wipe: rechazamos POSTs que no traigan el marcador de formulario.
  // Esto evita que un POST parcial (smoke test, fetch externo, repetición
  // accidental) sobreescriba campos no enviados con cadena vacía.
  if (!("__config_form" in body)) {
    return c.text("Bad request: falta el marcador __config_form. Solo se acepta el POST desde el formulario completo de /admin/config.", 400);
  }

  const updates: Record<string, string> = {};
  const put = (key: string) => {
    if (key in body) updates[key] = formString(body[key]);
  };
  // Para los secretos: si vienen vacíos, no se escribe la clave, así el valor
  // anterior (sea DB o .env) se conserva. Evita wipes accidentales cuando el
  // usuario guarda la config solo para cambiar otra pestaña.
  const putSecret = (key: string) => {
    if (!(key in body)) return;
    const value = formString(body[key]);
    if (value.length === 0) return;
    updates[key] = value;
  };

  // Campos simples: solo se escriben si vinieron en el body.
  const simpleFields = [
    "company_name",
    "cover_subtitle",
    "products_title",
    "quote_whatsapp_number",
    "welcome_text",
    "contact_text",
    "aviso_privacidad_content",
    "terminos_content",
    "design_creator_prompt",
    "catalog_image_prompt",
    "catalog_description_prompt",
    "color_primary",
    "color_secondary",
    "color_accent",
    "bg_cover",
    "color_cover_text",
    "bg_welcome",
    "bg_products",
    "bg_contact",
    "color_contact_text",
    "bg_card",
    "color_card_border",
    "bg_table_header",
    "color_table_header_text",
    "color_body_text",
    "color_heading_text",
    "color_muted_text",
    "font_body",
    "font_heading",
    "border_radius",
    "button_radius",
    "card_shadow",
    "card_style",
    "layout_density",
    "product_image_fit",
    "decorative_shape_style",
    "decorative_shape_color",
    "decorative_shape_opacity",
    "decorative_shape_blur",
    "custom_css",
    "dark_bg_cover",
    "dark_color_cover_text",
    "dark_bg_cta",
    "dark_bg_welcome",
    "dark_bg_products",
    "dark_bg_card",
    "dark_color_card_border",
    "dark_color_body_text",
    "dark_color_heading_text",
    "dark_color_muted_text",
    "dark_bg_table_header",
    "dark_color_table_header_text",
    "dark_bg_section_dark",
    // ── Landing (contenido de marketing) ──────────────────────────────
    "landing_hero_title",
    "landing_hero_subtitle",
    "landing_hero_cta_label",
    "landing_hero_cta_target",
    "landing_hero_mode",
    "landing_hero_carousel_interval",
    "landing_benefits_title",
    "landing_featured_title",
    "landing_about_title",
    "landing_about_text",
    "landing_cta_title",
    "landing_cta_text",
    "landing_cta_button_label",
    "landing_cta_button_target",
    // ── Settings que sobrescriben al .env ─────────────────────────────
    // Texto plano (URL, modelo, número): si vienen vacíos sí se borra el
    // override de DB y el sistema cae al .env como fallback.
    "llm_base_url",
    "llm_model",
    "llm_fallback_models",
    "llm_temperature",
    "llm_description_max_words",
    "image_base_url",
    "image_endpoint",
    "image_route",
    "image_model",
    "image_fallback_models",
    "image_timeout_ms",
    "flaresolverr_url",
    "admin_username",
  ];
  for (const key of simpleFields) put(key);

  // Secretos: anti-wipe explícito. Vacío = no tocar.
  putSecret("llm_api_key");
  putSecret("image_api_key");
  // admin_password: se hashea antes de persistir (nunca se guarda en claro).
  // Al cambiarla se revocan todas las sesiones activas (bump de versión).
  let superPasswordChanged = false;
  if ("admin_password" in body) {
    const pw = formString(body.admin_password);
    if (pw.length > 0) {
      updates.admin_password = await Bun.password.hash(pw);
      superPasswordChanged = true;
    }
  }

  // Campos con default cuando llegan vacíos.
  if ("shipping_provider" in body) updates.shipping_provider = formString(body.shipping_provider) || "Estafeta";
  if ("shipping_price" in body) updates.shipping_price = formString(body.shipping_price) || "0";
  if ("free_shipping_min_pieces" in body) updates.free_shipping_min_pieces = formString(body.free_shipping_min_pieces) || "0";

  // Logo: archivo nuevo OR campo URL presente. Si ninguno aplica, no se toca.
  const logoFile = formFile(body.company_logo_file);
  if (logoFile) {
    updates.company_logo = await saveImageUpload(logoFile, "", "logo");
  } else if ("company_logo_url" in body) {
    updates.company_logo = formString(body.company_logo_url);
  }

  // Fonts: archivo nuevo OR flag de eliminar. Si ninguno aplica, no se toca.
  const fontBodyFile = formFile(body.font_body_file);
  if (fontBodyFile) {
    if (!isFontFile(fontBodyFile)) return c.text("Formato de fuente principal no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    updates.font_body_file = await saveUpload(fontBodyFile, "fonts", "body-font");
  } else if (body.remove_font_body_file === "1") {
    updates.font_body_file = "";
  }

  const fontHeadingFile = formFile(body.font_heading_file);
  if (fontHeadingFile) {
    if (!isFontFile(fontHeadingFile)) return c.text("Formato de fuente de encabezados no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    updates.font_heading_file = await saveUpload(fontHeadingFile, "fonts", "heading-font");
  } else if (body.remove_font_heading_file === "1") {
    updates.font_heading_file = "";
  }

  // Checkbox: el marcador garantiza que el form fue enviado, así que la
  // ausencia se interpreta como "desmarcado".
  updates.decorative_shapes_enabled = body.decorative_shapes_enabled ? "1" : "0";
  updates.dark_mode_enabled = body.dark_mode_enabled ? "1" : "0";

  // ── Landing: toggles de sección (mismo patrón checkbox) ──────────────
  // Solo se procesan cuando el form del landing fue enviado (el pane siempre
  // incluye los checkboxes, así que su ausencia total = no se editó el landing).
  if ("landing_hero_enabled" in body || "landing_benefits_enabled" in body || "landing_cta_enabled" in body) {
    updates.landing_hero_enabled = body.landing_hero_enabled ? "1" : "0";
    updates.landing_benefits_enabled = body.landing_benefits_enabled ? "1" : "0";
    updates.landing_featured_enabled = body.landing_featured_enabled ? "1" : "0";
    updates.landing_about_enabled = body.landing_about_enabled ? "1" : "0";
    updates.landing_cta_enabled = body.landing_cta_enabled ? "1" : "0";
    updates.landing_contact_enabled = body.landing_contact_enabled ? "1" : "0";

    // Beneficios: zip de las filas fijas → JSON, descartando filas vacías.
    const icons = formStringArray(body.landing_benefit_icon);
    const titles = formStringArray(body.landing_benefit_title);
    const texts = formStringArray(body.landing_benefit_text);
    const rows = Math.max(icons.length, titles.length, texts.length);
    const benefits: Array<{ icon: string; title: string; text: string }> = [];
    for (let i = 0; i < rows; i++) {
      const icon = (icons[i] || "").trim();
      const title = (titles[i] || "").trim();
      const text = (texts[i] || "").trim();
      if (!title && !text) continue; // fila vacía
      benefits.push({ icon, title, text });
    }
    updates.landing_benefits_items = JSON.stringify(benefits);
  }

  // Landing: imágenes hero/about (archivo nuevo OR campo URL presente).
  const heroImageFile = formFile(body.landing_hero_image_file);
  if (heroImageFile) {
    updates.landing_hero_image = await saveImageUpload(heroImageFile, "", "landing-hero");
  } else if ("landing_hero_image_url" in body) {
    updates.landing_hero_image = formString(body.landing_hero_image_url);
  }
  for (let i = 1; i <= 5; i++) {
    const key = `landing_hero_carousel_image_${i}`;
    const file = formFile(body[`${key}_file`]);
    if (file) {
      updates[key] = await saveImageUpload(file, "", `carousel-${i}`);
    } else if (`${key}_url` in body) {
      updates[key] = formString(body[`${key}_url`]);
    }
  }
  const landingLogoFile = formFile(body.landing_logo_file);
  if (landingLogoFile) {
    updates.landing_logo = await saveImageUpload(landingLogoFile, "", "landing-logo");
  } else if ("landing_logo_url" in body) {
    updates.landing_logo = formString(body.landing_logo_url);
  }
  const ogImageLandingFile = formFile(body.og_image_landing_file);
  if (ogImageLandingFile) {
    updates.og_image_landing = await saveImageUpload(ogImageLandingFile, "", "og-landing");
  } else if ("og_image_landing_url" in body) {
    updates.og_image_landing = formString(body.og_image_landing_url);
  }
  if ("seo_title_landing" in body) updates.seo_title_landing = formString(body.seo_title_landing).slice(0, 70);
  if ("seo_description_landing" in body) updates.seo_description_landing = formString(body.seo_description_landing).slice(0, 160);
  const aboutImageFile = formFile(body.landing_about_image_file);
  if (aboutImageFile) {
    updates.landing_about_image = await saveImageUpload(aboutImageFile, "", "landing-about");
  } else if ("landing_about_image_url" in body) {
    updates.landing_about_image = formString(body.landing_about_image_url);
  }

  updateConfig(updates);
  if (superPasswordChanged) bumpSessionVersion();

  // Price tiers: solo reemplazamos si vinieron campos tier_min Y el parse
  // arrojó al menos un tier válido. Eso impide vaciados accidentales.
  if ("tier_min" in body) {
    const tiers = parsePriceTiers(body);
    if (tiers.length > 0) {
      replaceDefaultPriceTiers(tiers);
    }
  }

  return c.redirect("/admin/config");
});

// ═══════════════════════════════════════════════════════════════════════
// CRUD de Categorías de Productos
// ═══════════════════════════════════════════════════════════════════════

adminRoutes.get("/categorias", (c) => {
  const categories = getCategories();
  const productCounts = db.query<{ category_id: number | null; count: number }, []>(
    `SELECT category_id, COUNT(*) as count FROM products GROUP BY category_id`
  ).all();
  const countByCat = new Map<number | null, number>();
  for (const row of productCounts) countByCat.set(row.category_id, row.count);
  const orphanCount = countByCat.get(null) || 0;

  const subcategories = getSubcategories();
  const subsByCat = new Map<number, Subcategory[]>();
  for (const s of subcategories) {
    const list = subsByCat.get(s.category_id) || [];
    list.push(s);
    subsByCat.set(s.category_id, list);
  }
  const subCounts = db.query<{ subcategory_id: number | null; count: number }, []>(
    `SELECT subcategory_id, COUNT(*) as count FROM products GROUP BY subcategory_id`
  ).all();
  const countBySub = new Map<number, number>();
  for (const row of subCounts) if (row.subcategory_id != null) countBySub.set(row.subcategory_id, row.count);

  return c.html(AdminLayout("Categorías", `
    <div class="space-y-6">
      <div class="flex items-center justify-between border-b pb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Categorías de Productos</h1>
          <p class="text-sm text-gray-500">Agrupan productos en el catálogo público y en el PDF. Cada categoría puede tener subcategorías (ej. Llaveros → Motos, Clicker), que se muestran como subsecciones. Los productos sin categoría aparecen al final como "Sin categoría".</p>
        </div>
        <a href="/admin/products" class="text-sm text-blue-600 hover:underline">← Volver a productos</a>
      </div>

      <div class="bg-white shadow rounded-lg p-6 space-y-6">
        <form action="/admin/categorias" method="post" class="bg-gray-50 border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div class="sm:col-span-2">
            <label class="block text-xs font-bold text-gray-700">Nombre *</label>
            <input type="text" name="name" required placeholder="Ej: Llaveros, Figuras, Hogar" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-700">Orden</label>
            <input type="number" name="sort_order" step="1" placeholder="auto" class="mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
          </div>
          <div class="sm:col-span-3 flex justify-end">
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-4 py-2 rounded shadow-sm">
              + Crear Categoría
            </button>
          </div>
        </form>
        <p class="text-[11px] text-gray-400">Orden vacío = se asigna automáticamente al final. Cambia el número y guarda para reordenar.</p>

        <div class="space-y-4">
          ${categories.map((cat) => {
            const productCount = countByCat.get(cat.id) || 0;
            const subs = subsByCat.get(cat.id) || [];
            return `
            <div class="border rounded-lg p-4">
              <div class="flex flex-col sm:flex-row sm:items-end gap-3">
                <form action="/admin/categorias/${cat.id}/edit" method="post" class="flex flex-1 flex-wrap items-end gap-3">
                  <div class="w-20">
                    <label class="block text-[11px] font-bold text-gray-500">Orden</label>
                    <input type="number" name="sort_order" value="${cat.sort_order}" step="1" class="w-full px-2 py-1 border border-gray-300 rounded text-xs">
                  </div>
                  <div class="flex-1 min-w-[180px]">
                    <label class="block text-[11px] font-bold text-gray-500">Categoría</label>
                    <input type="text" name="name" value="${escapeHtml(cat.name)}" required class="block w-full px-2 py-1 border border-gray-300 rounded text-sm">
                  </div>
                  <button type="submit" class="text-blue-600 hover:underline text-xs font-semibold py-1">Guardar</button>
                </form>
                <div class="flex items-center gap-3 text-xs whitespace-nowrap">
                  <a href="/admin/products?category=${cat.id}" class="text-blue-600 hover:underline">${productCount} producto${productCount === 1 ? '' : 's'}</a>
                  <form action="/admin/categorias/${cat.id}/delete" method="post" onsubmit="return confirm('¿Eliminar la categoría &quot;${escapeHtml(cat.name).replace(/'/g, "\\'")}&quot;? Sus subcategorías se borran y sus ${productCount} producto${productCount === 1 ? '' : 's'} quedan sin categoría.');" class="inline">
                    <button type="submit" class="text-red-600 hover:underline font-semibold">Eliminar</button>
                  </form>
                </div>
              </div>

              <div class="mt-3 border-l-2 border-gray-100 pl-4 space-y-2">
                <p class="text-[11px] font-bold uppercase tracking-wide text-gray-400">Subcategorías</p>
                ${subs.map((s) => {
                  const subCount = countBySub.get(s.id) || 0;
                  return `
                  <div class="flex flex-wrap items-end gap-2">
                    <form action="/admin/subcategorias/${s.id}/edit" method="post" class="flex flex-1 flex-wrap items-end gap-2">
                      <input type="number" name="sort_order" value="${s.sort_order}" step="1" title="Orden" class="w-14 px-2 py-1 border border-gray-300 rounded text-xs">
                      <input type="text" name="name" value="${escapeHtml(s.name)}" required class="flex-1 min-w-[140px] px-2 py-1 border border-gray-300 rounded text-sm">
                      <button type="submit" class="text-blue-600 hover:underline text-xs font-semibold">Guardar</button>
                    </form>
                    <span class="text-[11px] text-gray-500 whitespace-nowrap">${subCount} prod.</span>
                    <form action="/admin/subcategorias/${s.id}/delete" method="post" onsubmit="return confirm('¿Eliminar la subcategoría &quot;${escapeHtml(s.name).replace(/'/g, "\\'")}&quot;? Sus productos quedan sin subcategoría.');" class="inline">
                      <button type="submit" class="text-red-600 hover:underline text-xs font-semibold">Eliminar</button>
                    </form>
                  </div>`;
                }).join("")}
                ${subs.length === 0 ? '<p class="text-xs text-gray-400 italic">Sin subcategorías todavía.</p>' : ''}
                <form action="/admin/categorias/${cat.id}/subcategorias" method="post" class="flex flex-wrap items-end gap-2 pt-1">
                  <input type="text" name="name" required placeholder="Nueva subcategoría (ej: Motos, Clicker)" class="flex-1 min-w-[160px] px-2 py-1 border border-gray-300 rounded text-sm bg-gray-50">
                  <input type="number" name="sort_order" step="1" placeholder="orden" class="w-16 px-2 py-1 border border-gray-300 rounded text-xs bg-gray-50">
                  <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs px-3 py-1.5 rounded">+ Subcategoría</button>
                </form>
              </div>
            </div>`;
          }).join("")}
          ${categories.length === 0 ? '<p class="text-center text-gray-400 py-6">No hay categorías todavía. Crea la primera arriba.</p>' : ""}
          ${orphanCount > 0 ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">Hay <a href="/admin/products?category=none" class="underline">${orphanCount} producto${orphanCount === 1 ? '' : 's'}</a> sin categoría. Asígnales una desde cada producto.</div>` : ""}
        </div>
      </div>
    </div>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/categorias", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody();
  const name = formString(body.name).trim();
  if (!name) return c.text("El nombre es obligatorio.", 400);
  const rawOrder = formString(body.sort_order).trim();
  const sortOrder = rawOrder === "" ? undefined : Number.parseInt(rawOrder, 10);
  createCategory(name, Number.isFinite(sortOrder) ? sortOrder : undefined);
  return c.redirect("/admin/categorias");
});

adminRoutes.post("/categorias/:id/edit", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.text("ID inválido.", 400);
  const body = await c.req.parseBody();
  const name = formString(body.name).trim();
  if (!name) return c.text("El nombre es obligatorio.", 400);
  const sortOrder = Number.parseInt(formString(body.sort_order) || "0", 10) || 0;
  updateCategory(id, name, sortOrder);
  return c.redirect("/admin/categorias");
});

adminRoutes.post("/categorias/:id/delete", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.text("ID inválido.", 400);
  deleteCategory(id);
  return c.redirect("/admin/categorias");
});

// Crea una categoría desde JS (botón "Adaptar a IA" que acepta una sugerencia
// del modelo). Devuelve la categoría completa para que el frontend pueda
// inyectarla al <select> y seleccionarla sin recargar.
adminRoutes.post("/categorias/quick-create", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const name = formString(body.name).trim();
    if (!name) return c.json({ error: "El nombre es obligatorio." }, 400);
    // Si ya existe una con ese nombre (case-insensitive) la reusamos en lugar
    // de duplicar. El frontend la trata igual.
    const existing = getCategories().find((c) => c.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return c.json({ category: existing, created: false });
    const created = createCategory(name);
    return c.json({ category: created, created: true });
  } catch (error) {
    console.error("[categorias/quick-create] failed", error);
    return c.json({ error: "No se pudo crear la categoría." }, 400);
  }
});

// ── Subcategorías (gestión dentro de /admin/categorias) ──────────────────
adminRoutes.post("/categorias/:id/subcategorias", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const categoryId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(categoryId) || !getCategory(categoryId)) return c.text("Categoría inválida.", 400);
  const body = await c.req.parseBody();
  const name = formString(body.name).trim();
  if (!name) return c.text("El nombre es obligatorio.", 400);
  const rawOrder = formString(body.sort_order).trim();
  const sortOrder = rawOrder === "" ? undefined : Number.parseInt(rawOrder, 10);
  createSubcategory(categoryId, name, Number.isFinite(sortOrder) ? sortOrder : undefined);
  return c.redirect("/admin/categorias");
});

adminRoutes.post("/subcategorias/:id/edit", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.text("ID inválido.", 400);
  const body = await c.req.parseBody();
  const name = formString(body.name).trim();
  if (!name) return c.text("El nombre es obligatorio.", 400);
  const sortOrder = Number.parseInt(formString(body.sort_order) || "0", 10) || 0;
  updateSubcategory(id, name, sortOrder);
  return c.redirect("/admin/categorias");
});

adminRoutes.post("/subcategorias/:id/delete", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) return c.text("ID inválido.", 400);
  deleteSubcategory(id);
  return c.redirect("/admin/categorias");
});

// Crea una subcategoría desde JS (sugerencia del LLM aceptada). Vive dentro de
// una categoría (category_id). Devuelve la subcategoría completa para inyectarla
// al <select> sin recargar.
adminRoutes.post("/subcategorias/quick-create", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const categoryId = Number.parseInt(String(body.category_id ?? ""), 10);
    const name = formString(body.name).trim();
    if (!Number.isFinite(categoryId) || !getCategory(categoryId)) return c.json({ error: "Categoría inválida." }, 400);
    if (!name) return c.json({ error: "El nombre es obligatorio." }, 400);
    const existing = getSubcategoriesByCategory(categoryId).find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    if (existing) return c.json({ subcategory: existing, created: false });
    const created = createSubcategory(categoryId, name);
    return c.json({ subcategory: created, created: true });
  } catch (error) {
    console.error("[subcategorias/quick-create] failed", error);
    return c.json({ error: "No se pudo crear la subcategoría." }, 400);
  }
});

adminRoutes.get("/products", (c) => {
  const allProducts = getProducts();
  const categories = getCategories();
  const categoryById = new Map<number, Category>();
  for (const cat of categories) categoryById.set(cat.id, cat);

  // ?category=<id> filtra por categoría, ?category=none filtra los sin categoría.
  const filter = (c.req.query("category") || "").trim();
  const filteredProducts = !filter
    ? allProducts
    : filter === "none"
      ? allProducts.filter((p) => p.category_id == null)
      : allProducts.filter((p) => String(p.category_id) === filter);

  const filterLabel = (() => {
    if (!filter) return "Todas";
    if (filter === "none") return "Sin categoría";
    return categoryById.get(Number.parseInt(filter, 10))?.name || filter;
  })();

  return c.html(AdminLayout("Productos", `
    <div class="bg-white shadow rounded-lg overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
            <div>
                <h2 class="text-xl font-bold text-gray-800">Catálogo de Productos</h2>
                <p class="text-xs text-gray-500 mt-0.5">Mostrando <strong>${filterLabel}</strong> — ${filteredProducts.length} de ${allProducts.length} producto${allProducts.length === 1 ? '' : 's'}.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <form method="get" action="/admin/products" class="inline-flex items-center gap-2">
                    <label class="text-xs font-medium text-gray-600">Categoría:</label>
                    <select name="category" onchange="this.form.submit()" class="px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
                        <option value="" ${filter === "" ? 'selected' : ''}>Todas</option>
                        <option value="none" ${filter === "none" ? 'selected' : ''}>Sin categoría</option>
                        ${categories.map((cat) => `<option value="${cat.id}" ${filter === String(cat.id) ? 'selected' : ''}>${escapeHtml(cat.name)}</option>`).join("")}
                    </select>
                </form>
                <a href="/admin/categorias" class="text-xs text-blue-600 hover:underline">Gestionar categorías ↗</a>
                <a href="/admin/products/new" class="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 text-sm font-medium">
                    + Nuevo Producto
                </a>
            </div>
        </div>

        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Imagen</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Nombre</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Categoría</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Precios</th>
                    <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
                </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
                ${filteredProducts.map(p => {
                  const cat = p.category_id != null ? categoryById.get(p.category_id) : null;
                  const catCell = cat
                    ? `<span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-700">${escapeHtml(cat.name)}</span>`
                    : `<span class="text-xs italic text-amber-700">Sin categoría</span>`;
                  return `
                <tr>
                    <td class="px-6 py-4 whitespace-nowrap">
                        ${p.image_url
                            ? `<img src="${escapeHtml(p.image_url)}" class="h-10 w-10 rounded object-cover">`
                            : `<div class="h-10 w-10 rounded bg-gray-200"></div>`
                        }
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="text-sm font-medium text-gray-900">${escapeHtml(p.name)}${p.featured ? ' <span class="ml-1 text-xs font-semibold text-amber-600" title="Destacado en landing">★</span>' : ''}</div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">${catCell}</td>
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
                `;}).join('')}
                ${filteredProducts.length === 0 ? `<tr><td colspan="5" class="px-6 py-10 text-center text-gray-500">${allProducts.length === 0 ? 'No hay productos. Crea uno nuevo.' : `No hay productos en "${filterLabel}".`}</td></tr>` : ''}
            </tbody>
        </table>
    </div>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.get("/products/new", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const defaultTiers = getDefaultPriceTiers();
  const categories = getCategories();
  const subcategories = getSubcategories();
  return c.html(AdminLayout("Nuevo Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Agregar Nuevo Producto</h2>
        <form action="/admin/products/new" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            ${renderCategoryFields(categories, subcategories)}

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
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="featured" name="featured" type="checkbox" value="1" class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="featured" class="font-medium text-gray-700">Destacar en landing</label>
                        <p class="text-gray-500">Aparece en la sección "Productos destacados" de la página de inicio. Orden: <input type="number" name="featured_order" value="0" step="1" class="w-20 px-2 py-1 border border-gray-300 rounded-md"> (menor = primero).</p>
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
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/products/new", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    imageUrl = await saveImageUpload(file, "", "prod");
  }

  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;
  const featured = formString(body.featured) === "1" ? 1 : 0;
  const featuredOrder = parseInt(formString(body.featured_order) || "0", 10) || 0;
  const { categoryId, subcategoryId } = parseCategoryAndSub(body);

  const result = db.query(`
    INSERT INTO products (name, description, image_url, makerworld_url, filament_grams, print_time_mins, extra_costs, use_default_pricing, sort_order, category_id, subcategory_id, featured, featured_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.makerworld_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing, categoryId, subcategoryId, featured, featuredOrder) as {id: number};

  if (!useDefaultPricing) replaceProductPriceTiers(result.id, parsePriceTiers(body));

  return c.redirect(useDefaultPricing ? "/admin/products" : `/admin/products/${result.id}/edit`);
});

adminRoutes.post("/products/:id/delete", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const id = c.req.param("id");
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  return c.redirect("/admin/products");
});

// Helper route to just serve edit form
adminRoutes.get("/products/:id/edit", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const id = parseInt(c.req.param("id"));
  const product = getProduct(id);
  if (!product) return c.notFound();
  const productTiers = getProductPriceTiers(id);
  const tiers = productTiers.length ? productTiers : getDefaultPriceTiers();
  const categories = getCategories();
  const subcategories = getSubcategories();

  return c.html(AdminLayout("Editar Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Editar Producto: ${escapeHtml(product.name)}</h2>
        <form action="/admin/products/${id}/edit" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" value="${escapeHtml(product.name)}" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            ${renderCategoryFields(categories, subcategories, product.category_id, product.subcategory_id)}

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
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="featured" name="featured" type="checkbox" value="1" ${product.featured ? 'checked' : ''} class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="featured" class="font-medium text-gray-700">Destacar en landing</label>
                        <p class="text-gray-500">Aparece en la sección "Productos destacados" de la página de inicio. Orden: <input type="number" name="featured_order" value="${product.featured_order || 0}" step="1" class="w-20 px-2 py-1 border border-gray-300 rounded-md"> (menor = primero).</p>
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
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/products/:id/edit", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    imageUrl = await saveImageUpload(file, "", "prod");
  }

  const useDefaultPricing = formString(body.use_default_pricing) === "1" ? 1 : 0;
  const filamentGrams = parseFloat(formString(body.filament_grams) || "0") || 0;
  const printTimeMins = parseInt(formString(body.print_time_mins) || "0", 10) || 0;
  const extraCosts = parseFloat(formString(body.extra_costs) || "0") || 0;
  const featured = formString(body.featured) === "1" ? 1 : 0;
  const featuredOrder = parseInt(formString(body.featured_order) || "0", 10) || 0;
  const { categoryId, subcategoryId } = parseCategoryAndSub(body);

  db.run(`
    UPDATE products SET name = ?, description = ?, image_url = ?, makerworld_url = ?, filament_grams = ?, print_time_mins = ?, extra_costs = ?, use_default_pricing = ?, category_id = ?, subcategory_id = ?, featured = ?, featured_order = ? WHERE id = ?
  `, [formString(body.name), formString(body.description) || null, imageUrl || null, formString(body.makerworld_url) || null, filamentGrams, printTimeMins, extraCosts, useDefaultPricing, categoryId, subcategoryId, featured, featuredOrder, id]);

  replaceProductPriceTiers(id, useDefaultPricing ? [] : parsePriceTiers(body));

  return c.redirect("/admin/products");
});

adminRoutes.get("/herramientas/creador-disenios", (c) => {
  return c.html(AdminLayout("Creador de Diseños", `
    <div class="space-y-6">
      <div class="flex items-center justify-between border-b pb-4">
        <div>
          <h1 class="text-2xl font-bold text-gray-800">Creador de Diseños con IA</h1>
          <p class="text-sm text-gray-500 mt-1">Sube una imagen base, deja que el modelo la transforme con el prompt configurado y refina con sugerencias.</p>
        </div>
        <a href="/admin/config" class="text-sm font-semibold text-blue-600 hover:text-blue-800 underline">Editar prompt base ↗</a>
      </div>

      <div class="bg-white shadow rounded-lg p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Panel izquierdo: input -->
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-bold text-gray-700">Imagen base *</label>
            <input type="file" id="std-input-image" accept="image/*" class="mt-1 block w-full text-sm text-gray-600">
          </div>
          <div class="bg-gray-50 border border-gray-200 rounded p-2 flex items-center justify-center min-h-[220px]">
            <img id="std-input-preview" class="hidden max-h-[300px] max-w-full object-contain rounded" alt="">
            <span id="std-input-placeholder" class="text-xs text-gray-400">Vista previa</span>
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700">Descripción adicional (opcional)</label>
            <textarea id="std-initial-prompt" rows="3" placeholder="Ej: conservar la forma del logo y poner fondo azul claro" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm"></textarea>
            <p class="text-[10px] text-gray-500 mt-1">Se inyecta en el placeholder <code class="bg-gray-100 px-1 rounded">{userPrompt}</code> del prompt base.</p>
          </div>
          <div class="flex justify-end">
            <button type="button" id="std-generate" class="bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold px-5 py-2 rounded shadow">
              Generar diseño
            </button>
          </div>
        </div>

        <!-- Panel derecho: review -->
        <div class="space-y-4">
          <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center justify-center min-h-[300px] relative">
            <img id="std-preview" class="hidden max-h-[420px] max-w-full object-contain rounded" alt="">
            <div id="std-loading" class="hidden absolute inset-0 bg-white bg-opacity-90 flex flex-col items-center justify-center gap-2">
              <div class="animate-spin rounded-full h-10 w-10 border-4 border-purple-500 border-t-transparent"></div>
              <p id="std-loading-text" class="text-sm font-semibold text-gray-700">Generando diseño…</p>
              <p class="text-xs text-gray-500">15 a 60 segundos</p>
            </div>
            <span id="std-preview-placeholder" class="text-xs text-gray-400">El diseño generado aparecerá aquí</span>
          </div>
          <div id="std-review-controls" class="hidden space-y-3">
            <div>
              <label class="block text-sm font-bold text-gray-700">Sugiere cambios sobre el diseño</label>
              <textarea id="std-feedback" rows="3" placeholder="Ej: cambia el fondo a blanco puro" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm"></textarea>
            </div>
            <div class="flex flex-wrap justify-between gap-2">
              <button type="button" id="std-restart" class="bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm font-bold px-4 py-2 rounded">↺ Iniciar de cero</button>
              <div class="flex gap-2">
                <button type="button" id="std-refine" class="bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold px-4 py-2 rounded shadow">Aplicar sugerencia</button>
                <button type="button" id="std-accept" class="bg-green-600 hover:bg-green-700 text-white text-sm font-bold px-4 py-2 rounded shadow">✓ Aceptar diseño</button>
              </div>
            </div>
          </div>
          <div id="std-accepted" class="hidden bg-green-50 border border-green-200 rounded p-4 space-y-3">
            <p class="text-sm font-bold text-green-800">Diseño aceptado.</p>
            <div class="flex flex-wrap gap-2">
              <a id="std-download" href="#" download class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded inline-flex items-center gap-1.5">
                ⬇ Descargar PNG
              </a>
              <button type="button" id="std-copy-url" class="bg-gray-700 hover:bg-gray-900 text-white text-xs font-bold px-3 py-1.5 rounded inline-flex items-center gap-1.5">
                📋 Copiar URL
              </button>
              <span id="std-copy-feedback" class="text-xs text-green-700 self-center"></span>
            </div>
            <p class="text-[11px] text-gray-600 break-all">URL: <code id="std-url-display" class="bg-white border rounded px-1.5 py-0.5"></code></p>
          </div>
          <div id="std-error" class="hidden bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3"></div>
        </div>
      </div>
    </div>

    <script>
      (() => {
        const inputEl = document.getElementById('std-input-image');
        const inputPreview = document.getElementById('std-input-preview');
        const inputPlaceholder = document.getElementById('std-input-placeholder');
        const promptEl = document.getElementById('std-initial-prompt');
        const previewImg = document.getElementById('std-preview');
        const previewPlaceholder = document.getElementById('std-preview-placeholder');
        const loadingBox = document.getElementById('std-loading');
        const loadingText = document.getElementById('std-loading-text');
        const reviewControls = document.getElementById('std-review-controls');
        const acceptedBox = document.getElementById('std-accepted');
        const errorBox = document.getElementById('std-error');
        const feedbackEl = document.getElementById('std-feedback');
        const downloadLink = document.getElementById('std-download');
        const copyBtn = document.getElementById('std-copy-url');
        const copyFb = document.getElementById('std-copy-feedback');
        const urlDisplay = document.getElementById('std-url-display');

        let baseImageDataUrl = '';
        let currentImageUrl = '';

        function fileToDataUrl(file) {
          return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            r.readAsDataURL(file);
          });
        }
        function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
        function clearError() { errorBox.textContent = ''; errorBox.classList.add('hidden'); }

        function setBusy(busy, text) {
          loadingBox.classList.toggle('hidden', !busy);
          if (text) loadingText.textContent = text;
        }
        function setPreview(url) {
          previewImg.src = url;
          previewImg.classList.remove('hidden');
          previewPlaceholder.classList.add('hidden');
        }
        function resetPreview() {
          previewImg.removeAttribute('src');
          previewImg.classList.add('hidden');
          previewPlaceholder.classList.remove('hidden');
          reviewControls.classList.add('hidden');
          acceptedBox.classList.add('hidden');
        }
        function restartAll() {
          baseImageDataUrl = '';
          currentImageUrl = '';
          inputEl.value = '';
          inputPreview.removeAttribute('src');
          inputPreview.classList.add('hidden');
          inputPlaceholder.classList.remove('hidden');
          promptEl.value = '';
          feedbackEl.value = '';
          clearError();
          resetPreview();
        }

        inputEl.addEventListener('change', async () => {
          const file = inputEl.files && inputEl.files[0];
          if (!file) { baseImageDataUrl = ''; inputPreview.classList.add('hidden'); inputPlaceholder.classList.remove('hidden'); return; }
          try {
            baseImageDataUrl = await fileToDataUrl(file);
            inputPreview.src = baseImageDataUrl;
            inputPreview.classList.remove('hidden');
            inputPlaceholder.classList.add('hidden');
            clearError();
          } catch (err) { showError(err.message || String(err)); }
        });

        document.getElementById('std-generate').addEventListener('click', async () => {
          if (!baseImageDataUrl) { showError('Sube una imagen base primero.'); return; }
          clearError();
          resetPreview();
          setBusy(true, 'Generando diseño…');
          try {
            const res = await fetch('/admin/design/generate', {
              method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
              body: JSON.stringify({ image: baseImageDataUrl, userPrompt: promptEl.value.trim() }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
            currentImageUrl = data.imageUrl;
            setPreview(currentImageUrl);
            reviewControls.classList.remove('hidden');
          } catch (err) {
            showError(err.message || String(err));
          } finally { setBusy(false); }
        });

        document.getElementById('std-refine').addEventListener('click', async () => {
          const fb = feedbackEl.value.trim();
          if (!fb) { showError('Escribe el cambio que quieres aplicar.'); return; }
          if (!currentImageUrl) { showError('No hay imagen previa.'); return; }
          clearError();
          setBusy(true, 'Aplicando sugerencia…');
          try {
            const res = await fetch('/admin/design/refine', {
              method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
              body: JSON.stringify({ imageUrl: currentImageUrl, feedback: fb }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
            currentImageUrl = data.imageUrl;
            setPreview(currentImageUrl);
            feedbackEl.value = '';
          } catch (err) {
            showError(err.message || String(err));
          } finally { setBusy(false); }
        });

        document.getElementById('std-restart').addEventListener('click', restartAll);
        document.getElementById('std-accept').addEventListener('click', () => {
          if (!currentImageUrl) return;
          reviewControls.classList.add('hidden');
          acceptedBox.classList.remove('hidden');
          const absoluteUrl = new URL(currentImageUrl, window.location.origin).href;
          downloadLink.href = currentImageUrl;
          downloadLink.download = currentImageUrl.split('/').pop() || 'diseno.png';
          urlDisplay.textContent = absoluteUrl;
        });
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(urlDisplay.textContent || '');
            copyFb.textContent = '¡Copiado!';
            setTimeout(() => copyFb.textContent = '', 2000);
          } catch (err) {
            copyFb.textContent = 'Error al copiar';
          }
        });
      })();
    </script>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.get("/quotes/new", (c) => {
  const config = getConfig();
  const products = getProducts();
  const defaultShippingProvider = config.shipping_provider || "Estafeta";
  const defaultShippingPrice = parseFloat(config.shipping_price || "0") || 0;
  const defaultWhatsapp = config.quote_whatsapp_number || "";

  const productOptionsHtml = products.map((p) => `<option value="${p.id}" data-name="${escapeHtml(p.name)}" data-image="${escapeHtml(p.image_url || '')}">${escapeHtml(p.name)}</option>`).join("");

  return c.html(AdminLayout("Nueva cotización manual", `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <a href="/admin/quotes" class="bg-gray-200 hover:bg-gray-300 text-gray-800 px-4 py-2 rounded-md text-sm font-semibold transition-colors">
          ← Volver a lista
        </a>
        <h1 class="text-2xl font-bold text-gray-800">Nueva cotización manual</h1>
      </div>

      <form action="/admin/quotes/new" method="post" enctype="multipart/form-data" class="space-y-6" id="manual-quote-form">
        <div class="bg-white shadow rounded-lg p-6 space-y-4">
          <h2 class="text-lg font-bold text-gray-800 border-b pb-2">Datos del cliente</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700">Nombre del cliente *</label>
              <input type="text" name="customer_name" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Código Postal *</label>
              <input type="text" name="postal_code" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">WhatsApp</label>
              <input type="text" name="whatsapp_number" value="${escapeHtml(defaultWhatsapp)}" placeholder="Opcional" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Paquetería</label>
              <input type="text" name="shipping_provider" value="${escapeHtml(defaultShippingProvider)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>
            <div>
              <label class="block text-sm font-semibold text-gray-700">Costo de envío (MXN)</label>
              <input type="number" name="shipping_cost" min="0" step="0.01" value="${defaultShippingPrice.toFixed(2)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
              <p class="text-xs text-gray-500 mt-1">Pon 0 para envío gratis.</p>
            </div>
          </div>
        </div>

        <div class="bg-white shadow rounded-lg p-6 space-y-4">
          <div class="flex items-center justify-between border-b pb-2">
            <h2 class="text-lg font-bold text-gray-800">Piezas / Productos</h2>
            <button type="button" id="add-item-btn" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold px-3 py-1.5 rounded shadow-sm">
              + Agregar otra pieza
            </button>
          </div>
          <p class="text-xs text-gray-500">Puedes elegir un producto del catálogo o capturar una pieza personalizada con su propio nombre, precio e imagen.</p>

          <div id="items-container" class="space-y-4"></div>
        </div>

        <div class="bg-white shadow rounded-lg p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div class="text-sm text-gray-700">
            <div>Subtotal: <span id="sum-subtotal" class="font-mono font-semibold">$0.00</span></div>
            <div>Piezas: <span id="sum-pieces" class="font-mono font-semibold">0</span></div>
            <div>Envío: <span id="sum-shipping" class="font-mono font-semibold">$0.00</span></div>
            <div class="text-base font-bold text-gray-900 mt-1">Total: <span id="sum-total" class="font-mono">$0.00</span></div>
          </div>
          <button type="submit" class="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-md font-bold shadow-md transition-colors">
            Guardar cotización
          </button>
        </div>
      </form>
    </div>

    <template id="item-template">
      <div class="border border-gray-200 rounded-lg p-4 bg-gray-50 grid grid-cols-1 md:grid-cols-12 gap-3 items-end item-row">
        <div class="md:col-span-4">
          <label class="block text-xs font-bold text-gray-600 uppercase">Producto del catálogo (opcional)</label>
          <select name="item_product_id" class="js-product-select mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white">
            <option value="">— Pieza personalizada —</option>
            ${productOptionsHtml}
          </select>
        </div>
        <div class="md:col-span-4">
          <label class="block text-xs font-bold text-gray-600 uppercase">Nombre / descripción *</label>
          <input type="text" name="item_name" required class="js-name mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
        </div>
        <div class="md:col-span-1">
          <label class="block text-xs font-bold text-gray-600 uppercase">Cant. *</label>
          <input type="number" name="item_quantity" min="1" step="1" value="1" required class="js-qty mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
        </div>
        <div class="md:col-span-2">
          <label class="block text-xs font-bold text-gray-600 uppercase">P. Unitario *</label>
          <input type="number" name="item_unit_price" min="0" step="0.01" value="0" required class="js-price mt-1 block w-full px-2 py-1.5 border border-gray-300 rounded text-sm">
        </div>
        <div class="md:col-span-1 text-right">
          <button type="button" class="js-remove text-red-600 hover:text-red-800 text-xs font-bold">Eliminar</button>
        </div>
        <div class="md:col-span-6">
          <label class="block text-xs font-bold text-gray-600 uppercase">Imagen de la pieza (opcional)</label>
          <input type="file" name="item_image" accept="image/*" class="js-image mt-1 block w-full text-xs text-gray-600">
          <input type="hidden" name="item_image_url" class="js-image-url" value="">
          <button type="button" class="js-design-btn mt-2 inline-flex items-center gap-1.5 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold px-3 py-1.5 rounded shadow-sm">
            <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg>
            Crear diseño con IA
          </button>
          <p class="text-[10px] text-gray-500 mt-0.5">Si seleccionas un producto del catálogo, se usa su imagen automáticamente.</p>
        </div>
        <div class="md:col-span-3">
          <div class="text-xs text-gray-500">Subtotal</div>
          <div class="js-subtotal font-mono font-semibold text-sm">$0.00</div>
        </div>
        <div class="md:col-span-3">
          <img class="js-preview hidden h-16 w-16 object-cover rounded border bg-white" alt="">
        </div>
      </div>
    </template>

    <!-- Design creator modal -->
    <div id="design-modal" class="fixed inset-0 bg-black bg-opacity-60 z-50 hidden items-center justify-center p-4">
      <div class="bg-white rounded-lg shadow-2xl max-w-3xl w-full max-h-[95vh] overflow-y-auto">
        <div class="flex items-center justify-between border-b px-6 py-4">
          <h3 class="text-lg font-bold text-gray-900">Creador de diseños con IA</h3>
          <button type="button" id="design-close" class="text-gray-500 hover:text-gray-800 text-2xl leading-none">&times;</button>
        </div>

        <!-- Step 1: subir imagen base + descripción opcional -->
        <div id="design-step-initial" class="p-6 space-y-4">
          <div>
            <label class="block text-sm font-bold text-gray-700">Imagen base *</label>
            <input type="file" id="design-input-image" accept="image/*" class="mt-1 block w-full text-sm text-gray-600">
            <p class="text-xs text-gray-500 mt-1">Esta imagen será transformada usando el prompt base configurado en <a href="/admin/config" target="_blank" class="text-blue-600 underline">Configuraciones</a>.</p>
          </div>
          <div class="bg-gray-50 border border-gray-200 rounded p-2 flex items-center justify-center min-h-[160px]">
            <img id="design-input-preview" class="hidden max-h-[220px] max-w-full object-contain rounded" alt="">
            <span id="design-input-placeholder" class="text-xs text-gray-400">Vista previa de la imagen base</span>
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700">Descripción adicional (opcional)</label>
            <textarea id="design-initial-prompt" rows="3" placeholder="Ej: que conserve la forma del gato y agrega un fondo azul claro" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm"></textarea>
            <p class="text-xs text-gray-500 mt-1">Se inyecta en el placeholder <code class="bg-gray-100 px-1 rounded">{userPrompt}</code> del prompt base. Si lo dejas vacío, se usa solo el prompt configurado.</p>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" id="design-generate" class="bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold px-5 py-2 rounded shadow">
              Generar diseño
            </button>
          </div>
        </div>

        <!-- Step 2: review + iterate -->
        <div id="design-step-review" class="p-6 space-y-4 hidden">
          <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center justify-center min-h-[320px]">
            <img id="design-preview" class="max-h-[460px] max-w-full object-contain rounded" alt="Diseño generado">
          </div>
          <div>
            <label class="block text-sm font-bold text-gray-700">Sugiere cambios sobre el diseño</label>
            <textarea id="design-feedback" rows="3" placeholder="Ej: que el gato sea blanco, agregar un moño rojo en el cuello" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md text-sm"></textarea>
          </div>
          <div class="flex flex-wrap justify-between items-center gap-2">
            <button type="button" id="design-restart" class="bg-gray-200 hover:bg-gray-300 text-gray-800 text-sm font-bold px-4 py-2 rounded">
              ↺ Iniciar de cero
            </button>
            <div class="flex gap-2">
              <button type="button" id="design-refine" class="bg-purple-600 hover:bg-purple-700 text-white text-sm font-bold px-4 py-2 rounded shadow">
                Aplicar sugerencia
              </button>
              <button type="button" id="design-accept" class="bg-green-600 hover:bg-green-700 text-white text-sm font-bold px-4 py-2 rounded shadow">
                ✓ Aceptar y guardar
              </button>
            </div>
          </div>
        </div>

        <!-- Loading overlay -->
        <div id="design-loading" class="hidden p-6 text-center space-y-3">
          <div class="inline-block animate-spin rounded-full h-10 w-10 border-4 border-purple-500 border-t-transparent"></div>
          <p id="design-loading-text" class="text-sm font-semibold text-gray-700">Generando diseño…</p>
          <p class="text-xs text-gray-500">Esto puede tardar entre 15 y 60 segundos.</p>
        </div>

        <!-- Error -->
        <div id="design-error" class="hidden m-6 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded"></div>
      </div>
    </div>

    <script>
      (() => {
        const container = document.getElementById('items-container');
        const template = document.getElementById('item-template');
        const addBtn = document.getElementById('add-item-btn');
        const sumSubtotalEl = document.getElementById('sum-subtotal');
        const sumPiecesEl = document.getElementById('sum-pieces');
        const sumShippingEl = document.getElementById('sum-shipping');
        const sumTotalEl = document.getElementById('sum-total');
        const shippingInput = document.querySelector('input[name="shipping_cost"]');
        const fmt = (n) => '$' + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);

        function recalc() {
          let subtotal = 0;
          let pieces = 0;
          container.querySelectorAll('.item-row').forEach((row) => {
            const qty = parseFloat(row.querySelector('.js-qty').value) || 0;
            const price = parseFloat(row.querySelector('.js-price').value) || 0;
            const s = qty * price;
            row.querySelector('.js-subtotal').textContent = fmt(s);
            subtotal += s;
            pieces += qty;
          });
          const shipping = parseFloat(shippingInput.value) || 0;
          sumSubtotalEl.textContent = fmt(subtotal);
          sumPiecesEl.textContent = String(pieces);
          sumShippingEl.textContent = fmt(shipping);
          sumTotalEl.textContent = fmt(subtotal + shipping);
        }

        function addItem() {
          const node = template.content.cloneNode(true);
          const row = node.querySelector('.item-row');
          row.querySelector('.js-remove').addEventListener('click', () => {
            row.remove();
            recalc();
          });
          row.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', recalc));
          const select = row.querySelector('.js-product-select');
          const nameInput = row.querySelector('.js-name');
          const preview = row.querySelector('.js-preview');
          select.addEventListener('change', () => {
            const opt = select.options[select.selectedIndex];
            if (opt && opt.value) {
              nameInput.value = opt.dataset.name || nameInput.value;
              const img = opt.dataset.image;
              if (img) {
                preview.src = img;
                preview.classList.remove('hidden');
              } else {
                preview.classList.add('hidden');
                preview.removeAttribute('src');
              }
            } else {
              preview.classList.add('hidden');
              preview.removeAttribute('src');
            }
          });
          const fileInput = row.querySelector('.js-image');
          const imageUrlInput = row.querySelector('.js-image-url');
          fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) {
              const url = URL.createObjectURL(file);
              preview.src = url;
              preview.classList.remove('hidden');
              // Subir un archivo invalida cualquier diseño previo en la URL oculta
              imageUrlInput.value = '';
            }
          });
          const designBtn = row.querySelector('.js-design-btn');
          designBtn.addEventListener('click', () => openDesignModal(row));
          container.appendChild(node);
          recalc();
        }

        addBtn.addEventListener('click', addItem);
        shippingInput.addEventListener('input', recalc);
        addItem();

        // ── Design creator modal ──
        const modal = document.getElementById('design-modal');
        const stepInitial = document.getElementById('design-step-initial');
        const stepReview = document.getElementById('design-step-review');
        const loading = document.getElementById('design-loading');
        const loadingText = document.getElementById('design-loading-text');
        const errorBox = document.getElementById('design-error');
        const initialPrompt = document.getElementById('design-initial-prompt');
        const inputImageEl = document.getElementById('design-input-image');
        const inputPreview = document.getElementById('design-input-preview');
        const inputPlaceholder = document.getElementById('design-input-placeholder');
        const feedback = document.getElementById('design-feedback');
        const previewImg = document.getElementById('design-preview');
        let activeRow = null;
        let currentImageUrl = '';
        let baseImageDataUrl = '';

        function showStep(which) {
          stepInitial.classList.toggle('hidden', which !== 'initial');
          stepReview.classList.toggle('hidden', which !== 'review');
          loading.classList.toggle('hidden', which !== 'loading');
        }
        function showError(msg) {
          errorBox.textContent = msg;
          errorBox.classList.remove('hidden');
        }
        function clearError() {
          errorBox.textContent = '';
          errorBox.classList.add('hidden');
        }

        function fileToDataUrl(file) {
          return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ''));
            r.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            r.readAsDataURL(file);
          });
        }

        inputImageEl.addEventListener('change', async () => {
          const file = inputImageEl.files && inputImageEl.files[0];
          if (!file) { baseImageDataUrl = ''; inputPreview.classList.add('hidden'); inputPlaceholder.classList.remove('hidden'); return; }
          try {
            baseImageDataUrl = await fileToDataUrl(file);
            inputPreview.src = baseImageDataUrl;
            inputPreview.classList.remove('hidden');
            inputPlaceholder.classList.add('hidden');
            clearError();
          } catch (err) {
            showError(err.message || String(err));
          }
        });

        function openDesignModal(row) {
          activeRow = row;
          currentImageUrl = '';
          baseImageDataUrl = '';
          initialPrompt.value = '';
          inputImageEl.value = '';
          inputPreview.removeAttribute('src');
          inputPreview.classList.add('hidden');
          inputPlaceholder.classList.remove('hidden');
          feedback.value = '';
          previewImg.removeAttribute('src');
          clearError();
          showStep('initial');
          modal.classList.remove('hidden');
          modal.classList.add('flex');
        }
        function closeDesignModal() {
          modal.classList.add('hidden');
          modal.classList.remove('flex');
          activeRow = null;
          currentImageUrl = '';
          baseImageDataUrl = '';
        }

        document.getElementById('design-close').addEventListener('click', closeDesignModal);
        modal.addEventListener('click', (e) => { if (e.target === modal) closeDesignModal(); });

        document.getElementById('design-generate').addEventListener('click', async () => {
          if (!baseImageDataUrl) { showError('Sube una imagen base primero.'); return; }
          const userPrompt = initialPrompt.value.trim();
          clearError();
          loadingText.textContent = 'Generando diseño…';
          showStep('loading');
          try {
            const res = await fetch('/admin/design/generate', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ image: baseImageDataUrl, userPrompt }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
            currentImageUrl = data.imageUrl;
            previewImg.src = currentImageUrl;
            showStep('review');
          } catch (err) {
            showStep('initial');
            showError(err.message || String(err));
          }
        });

        document.getElementById('design-refine').addEventListener('click', async () => {
          const fb = feedback.value.trim();
          if (!fb) { showError('Escribe el cambio que quieres aplicar.'); return; }
          if (!currentImageUrl) { showError('No hay imagen previa.'); return; }
          clearError();
          loadingText.textContent = 'Aplicando sugerencia…';
          showStep('loading');
          try {
            const res = await fetch('/admin/design/refine', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ imageUrl: currentImageUrl, feedback: fb }),
            });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
            currentImageUrl = data.imageUrl;
            previewImg.src = currentImageUrl;
            feedback.value = '';
            showStep('review');
          } catch (err) {
            showStep('review');
            showError(err.message || String(err));
          }
        });

        document.getElementById('design-restart').addEventListener('click', () => {
          currentImageUrl = '';
          previewImg.removeAttribute('src');
          feedback.value = '';
          clearError();
          showStep('initial');
        });

        document.getElementById('design-accept').addEventListener('click', () => {
          if (!activeRow || !currentImageUrl) { closeDesignModal(); return; }
          const imageUrlInput = activeRow.querySelector('.js-image-url');
          const fileInput = activeRow.querySelector('.js-image');
          const rowPreview = activeRow.querySelector('.js-preview');
          imageUrlInput.value = currentImageUrl;
          // Limpiar cualquier archivo subido para que el backend use la URL del diseño
          fileInput.value = '';
          rowPreview.src = currentImageUrl;
          rowPreview.classList.remove('hidden');
          closeDesignModal();
        });
      })();
    </script>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/quotes/new", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody({ all: true }) as Record<string, unknown>;
  const customerName = formString(body.customer_name).trim();
  const postalCode = formString(body.postal_code).trim();
  const whatsappNumber = formString(body.whatsapp_number).trim();
  const shippingProvider = formString(body.shipping_provider).trim() || "Estafeta";
  const shippingCost = parseFloat(formString(body.shipping_cost)) || 0;

  if (!customerName || !postalCode) {
    return c.redirect("/admin/quotes/new");
  }

  const productIds = formStringArray(body.item_product_id);
  const names = formStringArray(body.item_name);
  const quantities = formStringArray(body.item_quantity);
  const prices = formStringArray(body.item_unit_price);
  const imageUrls = formStringArray(body.item_image_url);
  const imageFiles = Array.isArray(body.item_image) ? body.item_image : (body.item_image ? [body.item_image] : []);

  const itemCount = Math.max(names.length, quantities.length, prices.length, productIds.length);
  const items: QuoteItemInput[] = [];
  let subtotal = 0;
  let totalPieces = 0;

  for (let i = 0; i < itemCount; i++) {
    const name = (names[i] || "").trim();
    const qty = parseInt(quantities[i] || "0", 10) || 0;
    const price = parseFloat(prices[i] || "0") || 0;
    if (!name || qty <= 0) continue;
    const productIdRaw = (productIds[i] || "").trim();
    const productId = productIdRaw ? parseInt(productIdRaw, 10) || null : null;

    let customImageUrl: string | null = null;
    const fileVal = imageFiles[i];
    if (fileVal instanceof File && fileVal.size > 0) {
      customImageUrl = await saveImageUpload(fileVal, "quote-items", "qitem");
    } else {
      const designUrl = (imageUrls[i] || "").trim();
      if (designUrl) customImageUrl = designUrl;
    }

    const lineSubtotal = qty * price;
    subtotal += lineSubtotal;
    totalPieces += qty;
    items.push({
      product_id: productId,
      product_name: name,
      quantity: qty,
      unit_price: price,
      subtotal: lineSubtotal,
      pricing_min_volume: null,
      pricing_max_volume: null,
      delivery_time: null,
      custom_image_url: customImageUrl,
    });
  }

  if (items.length === 0) {
    return c.redirect("/admin/quotes/new");
  }

  const grandTotal = subtotal + shippingCost;
  const quoteId = createQuote({
    customer_name: customerName,
    postal_code: postalCode,
    total_pieces: totalPieces,
    subtotal,
    shipping_provider: shippingProvider,
    shipping_cost: shippingCost,
    shipping_free_threshold: null,
    grand_total: grandTotal,
    whatsapp_number: whatsappNumber,
    message: "Cotización creada manualmente desde el panel administrativo.",
    items,
  });

  return c.redirect(`/admin/quotes/${quoteId}`);
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
          ${quote.client_token ? `
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
            <h2 class="text-xs font-bold text-blue-800 uppercase tracking-wider">Link del portal para el cliente</h2>
            <div class="flex items-center gap-2">
              <code class="flex-1 text-xs bg-white border border-blue-200 rounded px-2 py-1.5 text-blue-900 truncate" id="portal-link-val">/portal/${escapeHtml(quote.client_token)}</code>
              <button type="button" onclick="navigator.clipboard.writeText(location.origin+document.getElementById('portal-link-val').textContent);this.textContent='✓ Copiado'" class="text-xs bg-blue-600 hover:bg-blue-700 text-white font-bold px-3 py-1.5 rounded whitespace-nowrap transition-colors">Copiar</button>
            </div>
            <p class="text-[10px] text-blue-600">Envía este link al cliente para que vea el progreso de su pedido.</p>
          </div>
          ` : ""}

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
        <h2 class="text-lg font-bold text-gray-800 border-b pb-3 mb-4">Parámetros de Impresión por Pieza</h2>
        <p class="text-xs text-gray-500 mb-4">Sobreescribe los gramos y minutos por pieza para esta cotización específica. Los valores en azul indican que ya se sobreescribió el valor por defecto del producto.</p>
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b">
                <th class="px-4 py-2 text-left text-xs font-bold text-gray-600 uppercase">Producto</th>
                <th class="px-4 py-2 text-left text-xs font-bold text-gray-600 uppercase">Cant</th>
                <th class="px-4 py-2 text-left text-xs font-bold text-gray-600 uppercase">g / pza</th>
                <th class="px-4 py-2 text-left text-xs font-bold text-gray-600 uppercase">min / pza</th>
                <th class="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              ${items.map((item) => {
                const gDef = item.product_filament_grams ?? 0;
                const tDef = item.product_print_time_mins ?? 0;
                const g = item.override_filament_grams ?? gDef;
                const t = item.override_print_time_mins ?? tDef;
                const gOverridden = item.override_filament_grams !== null;
                const tOverridden = item.override_print_time_mins !== null;
                return `
                  <tr>
                    <td class="px-4 py-2 font-medium text-gray-900">${escapeHtml(item.product_name)}</td>
                    <td class="px-4 py-2 text-gray-500">${item.quantity}</td>
                    <td class="px-4 py-2" colspan="3">
                      <form action="/admin/quotes/${quote.id}/items/${item.id}/print-values" method="post" class="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="return_to" value="/admin/quotes/${quote.id}">
                        <input type="number" name="filament_grams" value="${g}" step="0.1" min="0" placeholder="${gDef}"
                          class="w-20 border rounded px-2 py-1 text-sm ${gOverridden ? 'border-blue-400 bg-blue-50 text-blue-900' : 'border-gray-300'}">
                        <input type="number" name="print_time_mins" value="${t}" step="1" min="0" placeholder="${tDef}"
                          class="w-20 border rounded px-2 py-1 text-sm ${tOverridden ? 'border-blue-400 bg-blue-50 text-blue-900' : 'border-gray-300'}">
                        <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs px-3 py-1.5 rounded transition-colors">Guardar</button>
                        ${(gOverridden || tOverridden) ? `<span class="text-xs text-blue-600 font-semibold">sobreescrito</span>` : `<span class="text-xs text-gray-400">por defecto del producto</span>`}
                      </form>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
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
            <div class="flex flex-wrap items-center gap-3">
              <div class="flex items-center">
                <input type="checkbox" id="has_cargo_extra" name="has_cargo_extra" value="1" class="h-4 w-4 text-blue-600 border-gray-300 rounded">
                <label for="has_cargo_extra" class="ml-2 block text-sm font-bold text-gray-700">¿Agregar cargo extra / Zona Extendida?</label>
              </div>
              <span id="ze-badge" class="text-xs font-bold px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">Verificando CP ${escapeHtml(quote.postal_code)}…</span>
              <button type="button" id="ze-recheck" class="text-xs font-semibold text-blue-600 hover:text-blue-800 underline ml-auto">Volver a verificar</button>
            </div>
            <p id="ze-detail" class="text-xs text-gray-500"></p>
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
        const badge = document.getElementById('ze-badge');
        const detail = document.getElementById('ze-detail');
        const recheck = document.getElementById('ze-recheck');
        const postalCode = ${JSON.stringify(quote.postal_code || "")};

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

        function setBadge(text, cls) {
          if (!badge) return;
          badge.textContent = text;
          badge.className = 'text-xs font-bold px-2.5 py-1 rounded-full border ' + cls;
        }

        async function checkZonaExtendida() {
          if (!postalCode) {
            setBadge('Sin CP', 'bg-gray-100 text-gray-600 border-gray-200');
            return;
          }
          setBadge('Verificando CP ' + postalCode + '…', 'bg-gray-100 text-gray-600 border-gray-200');
          if (detail) detail.textContent = '';
          try {
            const res = await fetch('/admin/zona-extendida/' + encodeURIComponent(postalCode), { credentials: 'same-origin' });
            const data = await res.json();
            if (!res.ok || data.error) {
              setBadge('Error al verificar', 'bg-red-50 text-red-700 border-red-200');
              if (detail) detail.textContent = data.error || 'No se pudo consultar zonaextendida.com';
              return;
            }
            if (!data.found) {
              setBadge('CP no encontrado en zonaextendida.com', 'bg-yellow-50 text-yellow-800 border-yellow-200');
              if (detail) detail.textContent = data.message || '';
              return;
            }
            const isExt = !!(data.estafeta && data.estafeta.extended);
            const place = [data.municipio, data.estado].filter(Boolean).join(', ');
            if (isExt) {
              setBadge('Estafeta: SÍ es Zona Extendida', 'bg-orange-100 text-orange-800 border-orange-300');
              if (detail) detail.textContent = 'CP ' + data.cp + ' · ' + place + ' · Se activó el cargo extra automáticamente.';
              if (checkbox && !checkbox.checked) {
                checkbox.checked = true;
                toggle();
              }
            } else {
              setBadge('Estafeta: NO es Zona Extendida', 'bg-green-100 text-green-800 border-green-300');
              if (detail) detail.textContent = 'CP ' + data.cp + ' · ' + place + ' · No requiere cargo extra.';
              if (checkbox && checkbox.checked) {
                checkbox.checked = false;
                toggle();
              }
            }
          } catch (err) {
            setBadge('Error de red', 'bg-red-50 text-red-700 border-red-200');
            if (detail) detail.textContent = String(err);
          }
        }

        recheck?.addEventListener('click', checkZonaExtendida);
        checkZonaExtendida();
      })();
    </script>
  `, c.get("session") as SessionData | undefined));
});

const VALID_QUOTE_STATUSES = ["no_despachado", "despachado", "produccion", "finalizado", "spam"];

adminRoutes.post("/quotes/:id/status", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const status = formString(body.status);
  if (!VALID_QUOTE_STATUSES.includes(status)) {
    return c.text("Estado de cotización no válido.", 400);
  }
  updateQuoteStatus(id, status);
  if (status === "despachado") {
    generateClientToken(id);
    return c.redirect("/admin/production?tab=pagos");
  }
  return c.redirect(`/admin/quotes/${id}`);
});

adminRoutes.post("/quotes/:id/items/:itemId/print-values", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const quoteId = parseInt(c.req.param("id"), 10);
  const itemId = parseInt(c.req.param("itemId"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const filamentGrams = formString(body.filament_grams) !== "" ? parseFloat(formString(body.filament_grams)) : null;
  const printTimeMins = formString(body.print_time_mins) !== "" ? parseInt(formString(body.print_time_mins), 10) : null;
  // Solo rutas internas (evita open redirect): debe empezar con "/" pero no "//".
  const rawReturn = formString(body.return_to);
  const returnTo = /^\/(?!\/)/.test(rawReturn) ? rawReturn : `/admin/quotes/${quoteId}`;
  updateQuoteItemPrintValues(itemId, filamentGrams, printTimeMins);
  return c.redirect(returnTo);
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

  const itemsForGallery = items.map((item) => ({
    name: item.product_name,
    quantity: item.quantity,
    imageUrl: item.product_image_url || item.custom_image_url || null,
  }));

  const galleryCardsHtml = itemsForGallery.map((it) => `
    <div class="border border-gray-300 rounded-md overflow-hidden bg-white flex flex-col">
      <div class="bg-gray-50 flex items-center justify-center" style="height: 220px;">
        ${it.imageUrl
          ? `<img src="${escapeHtml(it.imageUrl)}" alt="${escapeHtml(it.name)}" style="max-height: 100%; max-width: 100%; object-fit: contain;">`
          : `<div class="text-gray-300 text-xs uppercase tracking-wide">Sin imagen</div>`}
      </div>
      <div class="p-3 border-t border-gray-200">
        <div class="text-sm font-bold text-gray-900 leading-tight">${escapeHtml(it.name)}</div>
        <div class="text-xs text-gray-600 mt-1 font-semibold">Cantidad: <span class="text-gray-900">${it.quantity}</span></div>
      </div>
    </div>
  `).join("");

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
          ${adminFontFace("Uploaded Body Font", config.font_body_file)}
          ${adminFontFace("Uploaded Heading Font", config.font_heading_file)}
          @media print {
            .no-print { display: none !important; }
            body { background: white; color: black; }
            .print-border { border: 1px solid #000 !important; }
            .page-break { page-break-before: always; break-before: page; }
          }
          .page-break { margin-top: 2.5rem; padding-top: 2rem; border-top: 2px dashed #d1d5db; }
          @media print {
            .page-break { margin-top: 0; padding-top: 0; border-top: none; }
          }
          body { font-family: ${adminFontStack("Uploaded Body Font", config.font_body_file, adminCssValue(config.font_body, "system-ui, -apple-system, sans-serif"))}; }
          h1, h2, h3, h4 { font-family: ${adminFontStack("Uploaded Heading Font", config.font_heading_file, adminCssValue(config.font_heading, "system-ui, -apple-system, sans-serif"))}; }
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

            <!-- Second page: product gallery -->
            <section class="page-break">
              <div class="flex items-center justify-between border-b border-gray-300 pb-3 mb-6">
                <div>
                  <h2 class="text-lg font-black text-gray-900 tracking-wide uppercase">Productos cotizados</h2>
                  <p class="text-xs text-gray-500">Cotización ${escapeHtml(quoteFolio(quote))} · ${escapeHtml(quote.customer_name)}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-500 uppercase font-semibold">Total piezas</p>
                  <p class="text-lg font-black text-gray-900">${quote.total_pieces}</p>
                </div>
              </div>
              ${itemsForGallery.length > 0
                ? `<div class="grid grid-cols-2 sm:grid-cols-3 gap-4">${galleryCardsHtml}</div>`
                : `<p class="text-sm text-gray-500 text-center py-8">No hay productos en esta cotización.</p>`}
            </section>
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
                  const stockPct = Math.max(0, Math.min(100, (f.stock_grams / 1000) * 100));
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
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/production-settings/printers", requireRole(["superusuario", "admin", "editor"]), async (c) => {
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

adminRoutes.post("/production-settings/printers/:id/delete", requireRole(["superusuario", "admin", "editor"]), (c) => {
  const id = parseInt(c.req.param("id"), 10);
  deletePrinter(id);
  return c.redirect("/admin/production-settings");
});

adminRoutes.post("/production-settings/filaments", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const color = formString(body.color).trim();
  const price = parseFloat(formString(body.price)) || 0;
  const stockGrams = parseFloat(formString(body.stock_grams)) || 1000;
  if (color) {
    createFilament(color, price, stockGrams);
  }
  return c.redirect("/admin/production-settings");
});

adminRoutes.post("/production-settings/filaments/:id/delete", requireRole(["superusuario", "admin", "editor"]), (c) => {
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
      const g = item.override_filament_grams ?? item.product_filament_grams ?? 0;
      const t = item.override_print_time_mins ?? item.product_print_time_mins ?? 0;
      const e = item.product_extra_costs || 0;
      const hasOverride = item.override_filament_grams !== null || item.override_print_time_mins !== null;
      totalGrams += item.quantity * g;
      totalMins += item.quantity * t;
      totalExtraCosts += item.quantity * e;

      return `
        <div class="text-xs text-gray-700 bg-gray-50 border rounded p-2">
          <div class="flex justify-between items-start gap-2">
            <div>
              <span class="font-bold text-gray-900">${escapeHtml(item.product_name)}</span> (x${item.quantity})
              <div class="font-semibold text-gray-700 mt-0.5">${(g * item.quantity).toFixed(1)}g total · ${formatPrintTime(t * item.quantity)} total</div>
            </div>
            <div class="text-right text-gray-500">extra: ${money(e)}</div>
          </div>
          <form action="/admin/quotes/${quote.id}/items/${item.id}/print-values" method="post" class="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-dashed border-gray-200">
            <input type="hidden" name="return_to" value="/admin/production?tab=produccion">
            <label class="text-[10px] font-bold text-gray-500 uppercase">g/pza:</label>
            <input type="number" name="filament_grams" value="${g}" step="0.1" min="0" class="w-16 border border-gray-300 rounded px-1 py-0.5 text-xs bg-white ${hasOverride && item.override_filament_grams !== null ? 'border-blue-400' : ''}">
            <label class="text-[10px] font-bold text-gray-500 uppercase">min/pza:</label>
            <input type="number" name="print_time_mins" value="${t}" step="1" min="0" class="w-16 border border-gray-300 rounded px-1 py-0.5 text-xs bg-white ${hasOverride && item.override_print_time_mins !== null ? 'border-blue-400' : ''}">
            <button type="submit" class="bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold text-[10px] px-2 py-0.5 rounded transition-colors">Guardar</button>
            ${hasOverride ? `<span class="text-[10px] text-blue-600 font-semibold">· sobreescrito</span>` : ''}
          </form>
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
          <form action="/admin/production/${quote.id}/proof" method="post" enctype="multipart/form-data" class="space-y-3">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div class="sm:col-span-2">
                <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Comprobante de Anticipo *</label>
                <input type="file" name="payment_proof" accept="image/*" required class="block w-full text-xs text-gray-500 bg-white border border-gray-300 rounded p-1">
              </div>
              <div>
                <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Monto del Anticipo *</label>
                <input type="number" name="payment_amount" step="0.01" min="0.01" required placeholder="$0.00" value="${quote.grand_total > 0 ? (quote.grand_total / 2).toFixed(2) : ""}" class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
              </div>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <div>
                <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Método de pago</label>
                <select name="payment_method" class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
                  <option value="transferencia">Transferencia</option>
                  <option value="efectivo">Efectivo</option>
                  <option value="tarjeta">Tarjeta</option>
                  <option value="paypal">PayPal</option>
                  <option value="mercadopago">MercadoPago</option>
                  <option value="otro">Otro</option>
                </select>
              </div>
              <div>
                <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Referencia (opcional)</label>
                <input type="text" name="payment_reference" placeholder="No. operación..." class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
              </div>
            </div>
            <button type="submit" class="bg-green-600 hover:bg-green-700 text-white font-bold text-xs px-4 py-2.5 rounded shadow-sm whitespace-nowrap w-full sm:w-auto transition-colors">
              Registrar Anticipo e Iniciar Producción
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
            <div class="pt-3 border-t space-y-2">
              <span class="text-xs text-green-700 font-bold bg-green-50 border border-green-200 px-3 py-1 rounded-full">&#10003; Finalizada</span>
              ${quote.payment_proof_url_final ? `<div class="mt-2"><a href="${escapeHtml(quote.payment_proof_url_final)}" target="_blank" class="text-xs text-blue-600 hover:underline">Ver comprobante de liquidación</a></div>` : ""}
              <form action="/admin/production/${quote.id}/tracking" method="post" class="mt-3 pt-3 border-t border-dashed border-gray-200 space-y-2">
                <div class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Datos de envío (portal del cliente)</div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">Número de guía</label>
                    <input type="text" name="tracking_number" value="${escapeHtml(quote.shipping_tracking_number ?? "")}" placeholder="Ej. 1234567890" class="block w-full text-xs bg-white border border-gray-300 rounded px-2 py-1.5">
                  </div>
                  <div>
                    <label class="block text-[10px] text-gray-500 mb-0.5">URL de rastreo del carrier</label>
                    <input type="text" name="tracking_url" value="${escapeHtml(quote.shipping_tracking_url ?? "")}" placeholder="https://rastreo.estafeta.com/..." class="block w-full text-xs bg-white border border-gray-300 rounded px-2 py-1.5">
                  </div>
                </div>
                <button type="submit" class="bg-gray-700 hover:bg-gray-800 text-white font-bold text-xs px-3 py-1.5 rounded transition-colors">Guardar datos de envío</button>
              </form>
            </div>
          ` : `
            <div class="pt-3 border-t space-y-3">
              <form action="/admin/production/${quote.id}/progress" method="post" class="space-y-2">
                <div class="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Progreso de impresión (portal del cliente)</div>
                ${items.map((item) => `
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-700 flex-1 truncate">${escapeHtml(item.product_name)}</span>
                    <input type="number" name="qty_${item.id}" value="${item.printed_quantity ?? 0}" min="0" max="${item.quantity}" class="w-20 border border-gray-300 rounded px-1.5 py-0.5 text-xs bg-white text-right">
                    <span class="text-[10px] text-gray-400">/ ${item.quantity}</span>
                  </div>
                `).join("")}
                <button type="submit" class="bg-blue-100 hover:bg-blue-200 text-blue-800 font-bold text-xs px-3 py-1.5 rounded transition-colors">Actualizar progreso</button>
              </form>
            </div>
            <div class="pt-3 border-t space-y-3">
              <div class="text-xs text-purple-800 font-bold uppercase tracking-wider flex items-center gap-1">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                Liquidación y Finalización
              </div>
              <form action="/admin/production/${quote.id}/finish" method="post" enctype="multipart/form-data" class="space-y-2.5">
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div class="sm:col-span-2">
                    <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Comprobante de Liquidación *</label>
                    <input type="file" name="final_proof" accept="image/*" required class="block w-full text-xs text-gray-500 bg-white border border-gray-300 rounded p-1">
                  </div>
                  <div>
                    <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Monto Liquidación *</label>
                    <input type="number" name="final_amount" step="0.01" min="0" required placeholder="$0.00" class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
                  </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Método de pago</label>
                    <select name="final_method" class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
                      <option value="transferencia">Transferencia</option>
                      <option value="efectivo">Efectivo</option>
                      <option value="tarjeta">Tarjeta</option>
                      <option value="paypal">PayPal</option>
                      <option value="mercadopago">MercadoPago</option>
                      <option value="otro">Otro</option>
                    </select>
                  </div>
                  <div>
                    <label class="block text-[10px] font-bold text-gray-500 uppercase mb-1">Referencia (opcional)</label>
                    <input type="text" name="final_reference" placeholder="No. operación..." class="block w-full text-xs bg-white border border-gray-300 rounded p-1.5">
                  </div>
                </div>
                <button type="submit" class="bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs px-4 py-2.5 rounded shadow-sm whitespace-nowrap w-full sm:w-auto transition-colors">
                  Registrar Liquidación y Finalizar
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
  `, c.get("session") as SessionData | undefined));
});

// Production proof and schedule actions
adminRoutes.post("/production/:id/proof", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const file = formFile(body.payment_proof);
  if (file) {
    const fileUrl = await saveImageUpload(file, "payments", "proof");
    updateQuotePaymentProof(id, fileUrl);

    // Register anticipo payment
    const amount = parseFloat(String(body.payment_amount || "0"));
    if (amount > 0) {
      createPayment({
        quote_id: id,
        amount,
        payment_method: String(body.payment_method || "transferencia"),
        reference: String(body.payment_reference || ""),
        date: new Date().toISOString().slice(0, 10),
        notes: "Anticipo",
      });
    }
  }
  return c.redirect("/admin/production?tab=produccion");
});

adminRoutes.post("/production/:id/schedule", requireRole(["superusuario", "admin", "editor"]), async (c) => {
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

  // Reprograma + ajusta stock de filamento de forma atómica (ver applyQuoteSchedule).
  applyQuoteSchedule(id, printerId, scheduledStart, entries);

  return c.redirect("/admin/production?tab=produccion");
});

adminRoutes.post("/production/:id/finish", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;

  // Save final payment proof
  const file = formFile(body.final_proof);
  if (file) {
    const fileUrl = await saveImageUpload(file, "payments", "liquidacion");
    db.run(`UPDATE quotes SET payment_proof_url_final = ? WHERE id = ?`, [fileUrl, id]);
  }

  // Register liquidation payment
  const amount = parseFloat(String(body.final_amount || "0"));
  if (amount > 0) {
    createPayment({
      quote_id: id,
      amount,
      payment_method: String(body.final_method || "transferencia"),
      reference: String(body.final_reference || ""),
      date: new Date().toISOString().slice(0, 10),
      notes: "Liquidación",
    });
  }

  updateQuoteStatus(id, "finalizado");
  return c.redirect("/admin/production?tab=finalizadas");
});

adminRoutes.post("/production/:id/progress", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  const updates: { id: number; qty: number }[] = [];
  for (const [key, val] of Object.entries(body)) {
    const m = key.match(/^qty_(\d+)$/);
    if (m) updates.push({ id: parseInt(m[1], 10), qty: parseInt(String(val), 10) || 0 });
  }
  updatePrintedQuantities(id, updates);
  return c.redirect("/admin/production?tab=produccion");
});

adminRoutes.post("/production/:id/tracking", requireRole(["superusuario", "admin", "editor"]), async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.parseBody() as Record<string, unknown>;
  updateShippingInfo(id, formString(body.tracking_number), formString(body.tracking_url));
  return c.redirect("/admin/production?tab=finalizadas");
});

// ── Finance Module Routes ────────────────────────────────────────────────────

const financeNav = (active: string) => `
  <div class="flex flex-wrap gap-2 mb-6">
    <a href="/admin/finanzas" class="px-4 py-2 text-sm font-bold rounded-md transition-all ${active === "dashboard" ? "bg-blue-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-200"}">Dashboard</a>
    <a href="/admin/finanzas/ingresos" class="px-4 py-2 text-sm font-bold rounded-md transition-all ${active === "ingresos" ? "bg-green-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-200"}">Ingresos</a>
    <a href="/admin/finanzas/gastos" class="px-4 py-2 text-sm font-bold rounded-md transition-all ${active === "gastos" ? "bg-red-500 text-white shadow-sm" : "text-gray-600 hover:bg-gray-200"}">Gastos</a>
    <a href="/admin/finanzas/reportes" class="px-4 py-2 text-sm font-bold rounded-md transition-all ${active === "reportes" ? "bg-purple-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-200"}">Reportes</a>
  </div>
`;

const kpiCard = (label: string, value: string, color: string, sub = "") => `
  <div class="bg-white rounded-lg shadow p-5 border-l-4 border-${color}">
    <p class="text-xs font-bold text-gray-500 uppercase tracking-wider">${label}</p>
    <p class="text-2xl font-black mt-1" style="color: var(--heading-text)">${value}</p>
    ${sub ? `<p class="text-xs text-gray-500 mt-1">${sub}</p>` : ""}
  </div>
`;

// Dashboard
adminRoutes.get("/finanzas", requireRole(["superusuario", "admin"]), (c) => {
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  const summary = getFinancialSummary(from, to);

  const maxBar = Math.max(...summary.monthlyRevenue.map(r => r.total), ...summary.monthlyExpenses.map(r => r.total), 1);

  const monthNames: Record<string, string> = { "01": "Ene", "02": "Feb", "03": "Mar", "04": "Abr", "05": "May", "06": "Jun", "07": "Jul", "08": "Ago", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dic" };
  const formatMonth = (m: string) => { const parts = m.split("-"); return `${monthNames[parts[1] || ""] || parts[1] || ""} ${(parts[0] || "").slice(2)}`; };

  // Merge months for chart
  const allMonths = new Set([...summary.monthlyRevenue.map(r => r.month), ...summary.monthlyExpenses.map(r => r.month)]);
  const sortedMonths = [...allMonths].sort();
  const revenueMap = new Map(summary.monthlyRevenue.map(r => [r.month, r.total]));
  const expenseMap = new Map(summary.monthlyExpenses.map(r => [r.month, r.total]));

  const chartBars = sortedMonths.map(month => {
    const rev = revenueMap.get(month) || 0;
    const exp = expenseMap.get(month) || 0;
    const revH = Math.round((rev / maxBar) * 120);
    const expH = Math.round((exp / maxBar) * 120);
    return `
      <div class="flex flex-col items-center gap-1" style="min-width:48px">
        <div class="flex items-end gap-1" style="height:130px">
          <div class="w-4 rounded-t" style="height:${revH}px;background:var(--brand-primary,#22c55e)" title="Ingresos: ${money(rev)}"></div>
          <div class="w-4 rounded-t bg-red-400" style="height:${expH}px" title="Gastos: ${money(exp)}"></div>
        </div>
        <span class="text-[10px] text-gray-500 font-medium">${formatMonth(month)}</span>
      </div>
    `;
  }).join("");

  const expensePie = summary.expensesByCategory.map(cat => {
    const pct = summary.totalExpenses > 0 ? Math.round((cat.total / summary.totalExpenses) * 100) : 0;
    return `
      <div class="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
        <span class="text-sm">${cat.category_icon} ${escapeHtml(cat.category_name)}</span>
        <div class="flex items-center gap-2">
          <div class="w-20 bg-gray-200 rounded-full h-2"><div class="h-2 rounded-full bg-red-400" style="width:${pct}%"></div></div>
          <span class="text-sm font-bold w-24 text-right">${money(cat.total)}</span>
          <span class="text-xs text-gray-500 w-10 text-right">${pct}%</span>
        </div>
      </div>
    `;
  }).join("");

  return c.html(AdminLayout("Finanzas", `
    <h1 class="text-2xl font-black mb-2">Finanzas</h1>
    ${financeNav("dashboard")}

    <form class="flex flex-wrap items-end gap-3 mb-6 bg-white p-4 rounded-lg shadow-sm">
      <div>
        <label class="block text-xs font-bold text-gray-500 mb-1">Desde</label>
        <input type="date" name="from" value="${escapeHtml(from)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
      </div>
      <div>
        <label class="block text-xs font-bold text-gray-500 mb-1">Hasta</label>
        <input type="date" name="to" value="${escapeHtml(to)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
      </div>
      <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-bold">Filtrar</button>
      <a href="/admin/finanzas" class="text-sm text-gray-500 hover:text-gray-800 py-2">Limpiar</a>
    </form>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      ${kpiCard("Ingresos Totales", money(summary.totalRevenue), "green-500", `${summary.paidQuoteCount} pagos recibidos`)}
      ${kpiCard("Gastos Totales", money(summary.totalExpenses), "red-500", `${summary.expensesByCategory.length} categorías`)}
      ${kpiCard("Costo Producción", money(summary.totalProductionCost), "yellow-500", "Filamento + energía")}
      ${kpiCard("Utilidad Neta", money(summary.netProfit), summary.netProfit >= 0 ? "green-600" : "red-600", `Margen: ${summary.totalRevenue > 0 ? Math.round((summary.netProfit / summary.totalRevenue) * 100) : 0}%`)}
    </div>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      ${kpiCard("Cotizaciones", String(summary.quoteCount), "blue-500", `${summary.paidQuoteCount} pagadas`)}
      ${kpiCard("Ingresos Pendientes", money(summary.pendingRevenue), "yellow-500", "Por cobrar")}
      ${kpiCard("Ticket Promedio", money(summary.paidQuoteCount > 0 ? summary.totalRevenue / summary.paidQuoteCount : 0), "indigo-500", "Por pago")}
      ${kpiCard("Gasto Promedio Mensual", money(summary.monthlyExpenses.length > 0 ? summary.totalExpenses / summary.monthlyExpenses.length : 0), "orange-500", `${summary.monthlyExpenses.length} meses`)}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
      <div class="bg-white rounded-lg shadow p-5">
        <h3 class="font-bold text-sm text-gray-700 mb-4">Ingresos vs Gastos por Mes</h3>
        <div class="flex items-center gap-4 mb-3 text-xs">
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="background:var(--brand-primary,#22c55e)"></span> Ingresos</span>
          <span class="flex items-center gap-1"><span class="w-3 h-3 rounded bg-red-400"></span> Gastos</span>
        </div>
        ${sortedMonths.length > 0 ? `<div class="flex items-end gap-2 overflow-x-auto pb-2">${chartBars}</div>` : `<p class="text-sm text-gray-500">Sin datos aún. Registra ingresos y gastos para ver la gráfica.</p>`}
      </div>
      <div class="bg-white rounded-lg shadow p-5">
        <h3 class="font-bold text-sm text-gray-700 mb-4">Gastos por Categoría</h3>
        ${expensePie || `<p class="text-sm text-gray-500">Sin gastos registrados.</p>`}
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="bg-white rounded-lg shadow p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-sm text-gray-700">Últimos Ingresos</h3>
          <a href="/admin/finanzas/ingresos" class="text-xs text-blue-600 hover:underline font-medium">Ver todos →</a>
        </div>
        ${(() => {
          const recent = getPayments({ limit: 5 });
          if (recent.length === 0) return `<p class="text-sm text-gray-500">Sin pagos registrados.</p>`;
          return recent.map(p => `
            <div class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
              <div>
                <p class="text-sm font-medium">${p.quote_id ? `#${p.quote_id} - ${escapeHtml(p.customer_name || "")}` : escapeHtml(p.notes || "Pago manual")}</p>
                <p class="text-xs text-gray-500">${p.date} · ${escapeHtml(p.payment_method)}</p>
              </div>
              <span class="text-sm font-bold text-green-600">+${money(p.amount)}</span>
            </div>
          `).join("");
        })()}
      </div>
      <div class="bg-white rounded-lg shadow p-5">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-bold text-sm text-gray-700">Últimos Gastos</h3>
          <a href="/admin/finanzas/gastos" class="text-xs text-blue-600 hover:underline font-medium">Ver todos →</a>
        </div>
        ${(() => {
          const recent = getExpenses({ limit: 5 });
          if (recent.length === 0) return `<p class="text-sm text-gray-500">Sin gastos registrados.</p>`;
          return recent.map(e => `
            <div class="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
              <div>
                <p class="text-sm font-medium">${e.category_icon || "📋"} ${escapeHtml(e.description)}</p>
                <p class="text-xs text-gray-500">${e.date} · ${escapeHtml(e.category_name || "Sin categoría")}</p>
              </div>
              <span class="text-sm font-bold text-red-500">-${money(e.amount)}</span>
            </div>
          `).join("");
        })()}
      </div>
    </div>
  `, c.get("session") as SessionData | undefined));
});

// Ingresos (Payments)
adminRoutes.get("/finanzas/ingresos", requireRole(["superusuario", "admin"]), (c) => {
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  const payments = getPayments({ from: from || undefined, to: to || undefined });
  const totalIncome = payments.reduce((s, p) => s + p.amount, 0);
  const anticipos = payments.filter(p => (p.notes || "").includes("Anticipo"));
  const liquidaciones = payments.filter(p => (p.notes || "").includes("Liquidación"));

  return c.html(AdminLayout("Ingresos", `
    <h1 class="text-2xl font-black mb-2">Ingresos / Pagos</h1>
    ${financeNav("ingresos")}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2">
        <form class="flex flex-wrap items-end gap-3 mb-4 bg-white p-4 rounded-lg shadow-sm">
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1">Desde</label>
            <input type="date" name="from" value="${escapeHtml(from)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1">Hasta</label>
            <input type="date" name="to" value="${escapeHtml(to)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
          </div>
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-bold">Filtrar</button>
        </form>

        <div class="bg-white rounded-lg shadow-sm mb-4 p-4 flex items-center justify-between">
          <span class="text-sm font-bold text-gray-600">Total ingresos: <span class="text-green-600 text-lg">${money(totalIncome)}</span></span>
          <span class="text-sm text-gray-500">${payments.length} registros</span>
        </div>

        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b text-xs text-gray-500 uppercase">
                <th class="px-4 py-3 text-left">Fecha</th>
                <th class="px-4 py-3 text-left">Concepto</th>
                <th class="px-4 py-3 text-left">Cotización</th>
                <th class="px-4 py-3 text-left">Método</th>
                <th class="px-4 py-3 text-left">Referencia</th>
                <th class="px-4 py-3 text-right">Monto</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              ${payments.length === 0 ? `<tr><td colspan="7" class="px-4 py-8 text-center text-gray-500">Sin pagos registrados. Los pagos se crean desde el Panel de Producción.</td></tr>` : payments.map(p => {
                const isAnticipo = (p.notes || "").includes("Anticipo");
                const isLiquidacion = (p.notes || "").includes("Liquidación");
                const badge = isAnticipo ? `<span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-yellow-100 text-yellow-800">Anticipo</span>`
                  : isLiquidacion ? `<span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-purple-100 text-purple-800">Liquidación</span>`
                  : `<span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-gray-100 text-gray-600">${escapeHtml(p.notes || "Pago")}</span>`;
                return `
                <tr class="border-b border-gray-100 hover:bg-gray-50">
                  <td class="px-4 py-3 font-mono text-xs">${p.date}</td>
                  <td class="px-4 py-3">${badge}</td>
                  <td class="px-4 py-3">${p.quote_id ? `<a href="/admin/quotes/${p.quote_id}" class="text-blue-600 hover:underline font-medium">#${p.quote_id}</a> ${escapeHtml(p.customer_name || "")}` : `—`}</td>
                  <td class="px-4 py-3"><span class="inline-block px-2 py-0.5 rounded text-xs font-bold bg-gray-100">${escapeHtml(p.payment_method)}</span></td>
                  <td class="px-4 py-3 text-xs text-gray-600">${escapeHtml(p.reference || "—")}</td>
                  <td class="px-4 py-3 text-right font-bold text-green-600">${money(p.amount)}</td>
                  <td class="px-4 py-3 text-right">
                    <form action="/admin/finanzas/ingresos/${p.id}/delete" method="post" onsubmit="return confirm('¿Eliminar este pago?')">
                      <button type="submit" class="text-red-500 hover:text-red-700 text-xs font-bold">Eliminar</button>
                    </form>
                  </td>
                </tr>
              `}).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="space-y-4">
        <div class="bg-white rounded-lg shadow p-5">
          <h3 class="font-bold text-sm text-gray-700 mb-3">Resumen</h3>
          <div class="space-y-2">
            <div class="flex justify-between text-sm"><span class="text-gray-500">Total cobrado</span><span class="font-bold text-green-600">${money(totalIncome)}</span></div>
            <div class="flex justify-between text-sm"><span class="text-gray-500">Anticipos</span><span class="font-medium">${money(anticipos.reduce((s, p) => s + p.amount, 0))} (${anticipos.length})</span></div>
            <div class="flex justify-between text-sm"><span class="text-gray-500">Liquidaciones</span><span class="font-medium">${money(liquidaciones.reduce((s, p) => s + p.amount, 0))} (${liquidaciones.length})</span></div>
          </div>
        </div>
        <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p class="text-xs text-blue-800 font-medium">Los pagos se registran automáticamente desde el <a href="/admin/production" class="underline font-bold">Panel de Producción</a>:</p>
          <ul class="text-xs text-blue-700 mt-2 space-y-1 list-disc list-inside">
            <li><strong>Anticipo</strong> — al subir comprobante e iniciar producción</li>
            <li><strong>Liquidación</strong> — al subir comprobante y finalizar pedido</li>
          </ul>
        </div>
      </div>
    </div>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/finanzas/ingresos/:id/delete", requireRole(["superusuario", "admin"]), (c) => {
  deletePayment(parseInt(c.req.param("id"), 10));
  return c.redirect("/admin/finanzas/ingresos");
});

// Gastos (Expenses)
adminRoutes.get("/finanzas/gastos", requireRole(["superusuario", "admin"]), (c) => {
  const from = c.req.query("from") || "";
  const to = c.req.query("to") || "";
  const catFilter = parseInt(c.req.query("category") || "0", 10) || undefined;
  const expenses = getExpenses({ from: from || undefined, to: to || undefined, categoryId: catFilter });
  const categories = getExpenseCategories();
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  return c.html(AdminLayout("Gastos", `
    <h1 class="text-2xl font-black mb-2">Gastos</h1>
    ${financeNav("gastos")}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2">
        <form class="flex flex-wrap items-end gap-3 mb-4 bg-white p-4 rounded-lg shadow-sm">
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1">Desde</label>
            <input type="date" name="from" value="${escapeHtml(from)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1">Hasta</label>
            <input type="date" name="to" value="${escapeHtml(to)}" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-500 mb-1">Categoría</label>
            <select name="category" class="px-3 py-2 border border-gray-300 rounded-md text-sm">
              <option value="">Todas</option>
              ${categories.map(cat => `<option value="${cat.id}" ${catFilter === cat.id ? "selected" : ""}>${cat.icon} ${escapeHtml(cat.name)}</option>`).join("")}
            </select>
          </div>
          <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-bold">Filtrar</button>
        </form>

        <div class="bg-white rounded-lg shadow-sm mb-4 p-4 flex items-center justify-between">
          <span class="text-sm font-bold text-gray-600">Total gastos: <span class="text-red-500 text-lg">${money(totalExpenses)}</span></span>
          <span class="text-sm text-gray-500">${expenses.length} registros</span>
        </div>

        <div class="bg-white rounded-lg shadow overflow-hidden">
          <table class="min-w-full text-sm">
            <thead>
              <tr class="bg-gray-50 border-b text-xs text-gray-500 uppercase">
                <th class="px-4 py-3 text-left">Fecha</th>
                <th class="px-4 py-3 text-left">Categoría</th>
                <th class="px-4 py-3 text-left">Descripción</th>
                <th class="px-4 py-3 text-left">Método</th>
                <th class="px-4 py-3 text-right">Monto</th>
                <th class="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              ${expenses.length === 0 ? `<tr><td colspan="6" class="px-4 py-8 text-center text-gray-500">Sin gastos registrados</td></tr>` : expenses.map(e => `
                <tr class="border-b border-gray-100 hover:bg-gray-50">
                  <td class="px-4 py-3 font-mono text-xs">${e.date}</td>
                  <td class="px-4 py-3 text-xs"><span class="inline-block px-2 py-0.5 rounded bg-gray-100 font-medium">${e.category_icon || "📋"} ${escapeHtml(e.category_name || "Sin cat.")}</span></td>
                  <td class="px-4 py-3">${escapeHtml(e.description)}${e.notes ? `<span class="text-xs text-gray-400 ml-1">(${escapeHtml(e.notes)})</span>` : ""}${e.recurring ? ` <span class="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-bold">Recurrente</span>` : ""}</td>
                  <td class="px-4 py-3 text-xs">${escapeHtml(e.payment_method || "—")}</td>
                  <td class="px-4 py-3 text-right font-bold text-red-500">${money(e.amount)}</td>
                  <td class="px-4 py-3 text-right">
                    <form action="/admin/finanzas/gastos/${e.id}/delete" method="post" onsubmit="return confirm('¿Eliminar este gasto?')">
                      <button type="submit" class="text-red-500 hover:text-red-700 text-xs font-bold">Eliminar</button>
                    </form>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div class="space-y-5">
        <div class="bg-white rounded-lg shadow p-5 sticky top-4">
          <h3 class="font-bold text-sm text-gray-700 mb-4">Registrar Gasto</h3>
          <form action="/admin/finanzas/gastos" method="post" class="space-y-3">
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Categoría</label>
              <select name="category_id" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
                ${categories.map(cat => `<option value="${cat.id}">${cat.icon} ${escapeHtml(cat.name)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Descripción *</label>
              <input type="text" name="description" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="Ej: Rollo PLA Negro 1kg">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Monto *</label>
              <input type="number" name="amount" step="0.01" min="0.01" required class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="0.00">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Fecha *</label>
              <input type="date" name="date" required value="${new Date().toISOString().slice(0, 10)}" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Método de pago</label>
              <select name="payment_method" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm">
                <option value="transferencia">Transferencia</option>
                <option value="efectivo">Efectivo</option>
                <option value="tarjeta">Tarjeta</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-bold text-gray-500 mb-1">Notas</label>
              <input type="text" name="notes" class="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" placeholder="Opcional">
            </div>
            <div class="flex items-center gap-2">
              <input type="checkbox" name="recurring" id="recurring_check" value="1" class="rounded">
              <label for="recurring_check" class="text-xs text-gray-600">Gasto recurrente (mensual)</label>
            </div>
            <button type="submit" class="w-full bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded-md text-sm font-bold">Registrar Gasto</button>
          </form>
        </div>

        <div class="bg-white rounded-lg shadow p-5">
          <h3 class="font-bold text-sm text-gray-700 mb-3">Categorías</h3>
          <div class="space-y-1 mb-3">
            ${categories.map(cat => `
              <div class="flex items-center justify-between py-1">
                <span class="text-sm">${cat.icon} ${escapeHtml(cat.name)}</span>
                <form action="/admin/finanzas/categorias/${cat.id}/delete" method="post" onsubmit="return confirm('¿Eliminar categoría?')">
                  <button type="submit" class="text-red-400 hover:text-red-600 text-xs">✕</button>
                </form>
              </div>
            `).join("")}
          </div>
          <form action="/admin/finanzas/categorias" method="post" class="flex gap-2">
            <input type="text" name="name" required placeholder="Nueva categoría" class="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs">
            <input type="text" name="icon" placeholder="Emoji" class="w-12 px-2 py-1.5 border border-gray-300 rounded text-xs text-center">
            <button type="submit" class="bg-gray-200 hover:bg-gray-300 px-3 py-1.5 rounded text-xs font-bold">+</button>
          </form>
        </div>
      </div>
    </div>
  `, c.get("session") as SessionData | undefined));
});

adminRoutes.post("/finanzas/gastos", requireRole(["superusuario", "admin"]), async (c) => {
  const body = await c.req.parseBody();
  const amount = parseFloat(String(body.amount || "0"));
  if (amount <= 0 || !String(body.description || "").trim()) return c.redirect("/admin/finanzas/gastos");
  createExpense({
    category_id: parseInt(String(body.category_id || "0"), 10) || null,
    description: String(body.description || "").trim(),
    amount,
    date: String(body.date || new Date().toISOString().slice(0, 10)),
    payment_method: String(body.payment_method || ""),
    notes: String(body.notes || ""),
    recurring: body.recurring === "1" ? 1 : 0,
  });
  return c.redirect("/admin/finanzas/gastos");
});

adminRoutes.post("/finanzas/gastos/:id/delete", requireRole(["superusuario", "admin"]), (c) => {
  deleteExpense(parseInt(c.req.param("id"), 10));
  return c.redirect("/admin/finanzas/gastos");
});

adminRoutes.post("/finanzas/categorias", requireRole(["superusuario", "admin"]), async (c) => {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  if (!name) return c.redirect("/admin/finanzas/gastos");
  createExpenseCategory(name, String(body.icon || "📋").trim());
  return c.redirect("/admin/finanzas/gastos");
});

adminRoutes.post("/finanzas/categorias/:id/delete", requireRole(["superusuario", "admin"]), (c) => {
  deleteExpenseCategory(parseInt(c.req.param("id"), 10));
  return c.redirect("/admin/finanzas/gastos");
});

// Reportes
adminRoutes.get("/finanzas/reportes", requireRole(["superusuario", "admin"]), (c) => {
  const rawYear = c.req.query("year") || "";
  // Solo años de 4 dígitos en rango razonable; cualquier otra cosa cae al actual.
  const year = /^\d{4}$/.test(rawYear) && +rawYear >= 2000 && +rawYear <= 2100 ? rawYear : String(new Date().getFullYear());
  const yearNum = parseInt(year, 10);

  // Monthly P&L for the selected year
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, "0");
    const from = `${year}-${month}-01`;
    const lastDay = new Date(yearNum, i + 1, 0).getDate();
    const to = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
    const summary = getFinancialSummary(from, to);
    return { month: `${year}-${month}`, label: new Date(yearNum, i).toLocaleString("es-MX", { month: "long" }), ...summary };
  });

  const yearTotalRevenue = months.reduce((s, m) => s + m.totalRevenue, 0);
  const yearTotalExpenses = months.reduce((s, m) => s + m.totalExpenses, 0);
  const yearTotalProdCost = months.reduce((s, m) => s + m.totalProductionCost, 0);
  const yearNetProfit = yearTotalRevenue - yearTotalExpenses - yearTotalProdCost;

  // Top products by revenue
  const topProducts = db.query<{ product_name: string; total_qty: number; total_revenue: number }, [string, string]>(`
    SELECT qi.product_name, SUM(qi.quantity) as total_qty, SUM(qi.subtotal) as total_revenue
    FROM quote_items qi
    JOIN quotes q ON q.id = qi.quote_id
    WHERE q.status IN ('despachado','produccion','finalizado')
      AND q.created_at >= ? AND q.created_at <= ?
    GROUP BY qi.product_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `).all(`${year}-01-01`, `${year}-12-31`);

  // Top customers by revenue
  const topCustomers = db.query<{ customer_name: string; quote_count: number; total_revenue: number }, [string, string]>(`
    SELECT customer_name, COUNT(*) as quote_count, SUM(grand_total) as total_revenue
    FROM quotes
    WHERE status IN ('despachado','produccion','finalizado')
      AND created_at >= ? AND created_at <= ?
    GROUP BY customer_name
    ORDER BY total_revenue DESC
    LIMIT 10
  `).all(`${year}-01-01`, `${year}-12-31`);

  return c.html(AdminLayout("Reportes Financieros", `
    <h1 class="text-2xl font-black mb-2">Reportes Financieros</h1>
    ${financeNav("reportes")}

    <form class="flex items-end gap-3 mb-6 bg-white p-4 rounded-lg shadow-sm">
      <div>
        <label class="block text-xs font-bold text-gray-500 mb-1">Año</label>
        <select name="year" class="px-3 py-2 border border-gray-300 rounded-md text-sm font-bold">
          ${[yearNum - 2, yearNum - 1, yearNum, yearNum + 1].map(y => `<option value="${y}" ${y === yearNum ? "selected" : ""}>${y}</option>`).join("")}
        </select>
      </div>
      <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-bold">Ver</button>
    </form>

    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
      ${kpiCard(`Ingresos ${year}`, money(yearTotalRevenue), "green-500")}
      ${kpiCard(`Gastos ${year}`, money(yearTotalExpenses), "red-500")}
      ${kpiCard(`Costo Producción ${year}`, money(yearTotalProdCost), "yellow-500")}
      ${kpiCard(`Utilidad ${year}`, money(yearNetProfit), yearNetProfit >= 0 ? "green-600" : "red-600", `Margen: ${yearTotalRevenue > 0 ? Math.round((yearNetProfit / yearTotalRevenue) * 100) : 0}%`)}
    </div>

    <div class="bg-white rounded-lg shadow overflow-hidden mb-8">
      <h3 class="font-bold text-sm text-gray-700 p-4 border-b">Estado de Resultados Mensual — ${year}</h3>
      <div class="overflow-x-auto">
        <table class="min-w-full text-xs">
          <thead>
            <tr class="bg-gray-50 border-b text-gray-500 uppercase font-bold">
              <th class="px-3 py-2 text-left">Mes</th>
              <th class="px-3 py-2 text-right">Ingresos</th>
              <th class="px-3 py-2 text-right">Gastos</th>
              <th class="px-3 py-2 text-right">Costo Prod.</th>
              <th class="px-3 py-2 text-right">Utilidad</th>
              <th class="px-3 py-2 text-right">Margen</th>
              <th class="px-3 py-2 text-right">Cotizaciones</th>
              <th class="px-3 py-2 text-right">Pagadas</th>
            </tr>
          </thead>
          <tbody>
            ${months.map(m => {
              const net = m.totalRevenue - m.totalExpenses - m.totalProductionCost;
              const margin = m.totalRevenue > 0 ? Math.round((net / m.totalRevenue) * 100) : 0;
              const hasData = m.totalRevenue > 0 || m.totalExpenses > 0;
              return `
                <tr class="border-b border-gray-100 ${hasData ? "" : "opacity-40"}">
                  <td class="px-3 py-2 font-medium capitalize">${m.label}</td>
                  <td class="px-3 py-2 text-right font-mono text-green-600">${money(m.totalRevenue)}</td>
                  <td class="px-3 py-2 text-right font-mono text-red-500">${money(m.totalExpenses)}</td>
                  <td class="px-3 py-2 text-right font-mono text-yellow-600">${money(m.totalProductionCost)}</td>
                  <td class="px-3 py-2 text-right font-mono font-bold ${net >= 0 ? "text-green-700" : "text-red-600"}">${money(net)}</td>
                  <td class="px-3 py-2 text-right"><span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${margin >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${margin}%</span></td>
                  <td class="px-3 py-2 text-right">${m.quoteCount}</td>
                  <td class="px-3 py-2 text-right font-bold">${m.paidQuoteCount}</td>
                </tr>
              `;
            }).join("")}
            <tr class="bg-gray-50 font-bold border-t-2 border-gray-300">
              <td class="px-3 py-2">TOTAL</td>
              <td class="px-3 py-2 text-right font-mono text-green-600">${money(yearTotalRevenue)}</td>
              <td class="px-3 py-2 text-right font-mono text-red-500">${money(yearTotalExpenses)}</td>
              <td class="px-3 py-2 text-right font-mono text-yellow-600">${money(yearTotalProdCost)}</td>
              <td class="px-3 py-2 text-right font-mono ${yearNetProfit >= 0 ? "text-green-700" : "text-red-600"}">${money(yearNetProfit)}</td>
              <td class="px-3 py-2 text-right"><span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${yearNetProfit >= 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}">${yearTotalRevenue > 0 ? Math.round((yearNetProfit / yearTotalRevenue) * 100) : 0}%</span></td>
              <td class="px-3 py-2 text-right">${months.reduce((s, m) => s + m.quoteCount, 0)}</td>
              <td class="px-3 py-2 text-right">${months.reduce((s, m) => s + m.paidQuoteCount, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <h3 class="font-bold text-sm text-gray-700 p-4 border-b">Top Productos por Ingreso — ${year}</h3>
        <table class="min-w-full text-sm">
          <thead>
            <tr class="bg-gray-50 border-b text-xs text-gray-500 uppercase">
              <th class="px-4 py-2 text-left">Producto</th>
              <th class="px-4 py-2 text-right">Piezas</th>
              <th class="px-4 py-2 text-right">Ingresos</th>
            </tr>
          </thead>
          <tbody>
            ${topProducts.length === 0 ? `<tr><td colspan="3" class="px-4 py-6 text-center text-gray-500">Sin datos</td></tr>` : topProducts.map((p, i) => `
              <tr class="border-b border-gray-100">
                <td class="px-4 py-2"><span class="font-mono text-xs text-gray-400 mr-2">${i + 1}.</span>${escapeHtml(p.product_name)}</td>
                <td class="px-4 py-2 text-right font-mono">${p.total_qty.toLocaleString()}</td>
                <td class="px-4 py-2 text-right font-bold text-green-600">${money(p.total_revenue)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <div class="bg-white rounded-lg shadow overflow-hidden">
        <h3 class="font-bold text-sm text-gray-700 p-4 border-b">Top Clientes por Ingreso — ${year}</h3>
        <table class="min-w-full text-sm">
          <thead>
            <tr class="bg-gray-50 border-b text-xs text-gray-500 uppercase">
              <th class="px-4 py-2 text-left">Cliente</th>
              <th class="px-4 py-2 text-right">Cotizaciones</th>
              <th class="px-4 py-2 text-right">Ingresos</th>
            </tr>
          </thead>
          <tbody>
            ${topCustomers.length === 0 ? `<tr><td colspan="3" class="px-4 py-6 text-center text-gray-500">Sin datos</td></tr>` : topCustomers.map((c, i) => `
              <tr class="border-b border-gray-100">
                <td class="px-4 py-2"><span class="font-mono text-xs text-gray-400 mr-2">${i + 1}.</span>${escapeHtml(c.customer_name)}</td>
                <td class="px-4 py-2 text-right font-mono">${c.quote_count}</td>
                <td class="px-4 py-2 text-right font-bold text-green-600">${money(c.total_revenue)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `, c.get("session") as SessionData | undefined));
});

export { adminRoutes };
