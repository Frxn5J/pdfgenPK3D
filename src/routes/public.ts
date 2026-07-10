import { Hono } from "hono";
import { createHash } from "crypto";
import { join } from "path";
import * as fs from "fs";
import sharp from "sharp";
import { createQuote, getConfig, getProducts, getFeaturedProducts, getDefaultPriceTiers, getProductPriceTiers, updateQuoteMessage, getCategories, getSubcategories, type Category, type Subcategory, type Product } from "../db/schema";
import { buildManifest, serviceWorkerJs, renderAppIconSvg, pwaHeadTags, pwaRegisterScript, sendPushToAll } from "../pwa";
import { imgTag } from "../lib/html";
import { cleanText } from "../lib/text";
import { buildHeadMeta, buildJsonLd, resolveOrigin, escXml, type SeoProduct } from "../lib/seo";
import { resolveImageBytes } from "../lib/images";

const publicRoutes = new Hono();

// ── Optimizador de imágenes (/img) ──────────────────────────────────────────
// Redimensiona y convierte a WebP con caché en disco. Acepta rutas locales de
// /uploads y URLs externas SOLO si son la imagen de algún producto (evita que
// el endpoint funcione como proxy abierto). Ante cualquier fallo redirige al
// original para no romper la página.
const IMG_WIDTHS = new Set([400, 800]);
const imgCacheDir = join(process.cwd(), "data", "cache", "img");
const optimizedImageSrc = (src: string, w: 400 | 800) =>
  /^(\/uploads\/|https?:\/\/)/i.test(src) ? `/img?src=${encodeURIComponent(src)}&w=${w}` : src;

publicRoutes.get("/img", async (c) => {
  const src = (c.req.query("src") || "").trim();
  const w = Number(c.req.query("w") || 800);
  if (!src || !IMG_WIDTHS.has(w)) return c.text("Solicitud inválida", 400);
  const isLocal = src.startsWith("/uploads/");
  if (!isLocal) {
    if (!/^https?:\/\//i.test(src)) return c.text("Solicitud inválida", 400);
    const isProductImage = getProducts().some((p) => p.image_url === src);
    if (!isProductImage) return c.text("No encontrado", 404);
  }
  const cachePath = join(imgCacheDir, `${createHash("sha1").update(`${src}|${w}`).digest("hex")}.webp`);
  try {
    if (!fs.existsSync(cachePath)) {
      const { bytes } = await resolveImageBytes(src);
      const out = await sharp(bytes).resize({ width: w, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
      fs.mkdirSync(imgCacheDir, { recursive: true });
      fs.writeFileSync(cachePath, out);
    }
    return c.body(new Uint8Array(fs.readFileSync(cachePath)), 200, {
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
    });
  } catch {
    // src ya validado (local o imagen de producto): el redirect no es abierto
    return c.redirect(src, 302);
  }
});
const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";

// ── Rate limiting de cotizaciones públicas (en memoria) ─────────────────────
// Frena spam/DoS del endpoint público POST /api/quotes (que persiste en DB y
// dispara push a todos los admins): máx. QUOTE_MAX por IP dentro de la ventana.
const QUOTE_MAX = 10;
const QUOTE_WINDOW_MS = 10 * 60 * 1000;
const quoteHits = new Map<string, number[]>();
const quoteClientIp = (c: any): string =>
  (c.req.header("x-forwarded-for") || "").split(",")[0]?.trim() ||
  c.req.header("x-real-ip") || "unknown";
const quoteRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const recent = (quoteHits.get(ip) || []).filter((t) => now - t < QUOTE_WINDOW_MS);
  recent.push(now);
  quoteHits.set(ip, recent);
  return recent.length > QUOTE_MAX;
};

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => htmlEntities[char] || char);

const safeJson = (value: unknown) => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026");

const cssValue = (value: unknown, fallback: string) => {
  const normalized = String(value ?? fallback).replace(/[;\r\n]/g, " ").replace(/<\/style/gi, "").trim();
  return normalized || fallback;
};

const cssUrl = (value: unknown) => String(value ?? "").replace(/[)"'\\\r\n<>]/g, "").trim();

const fontFace = (family: string, url: unknown) => {
  const safeUrl = cssUrl(url);
  if (!safeUrl) return "";
  return `@font-face { font-family: "${family}"; src: url("${safeUrl}"); font-display: swap; }`;
};

const uploadedFontStack = (family: string, url: unknown, fallback: string) => cssUrl(url) ? `"${family}", ${fallback}` : fallback;
const customCss = (value: unknown) => String(value ?? "").replace(/<\/style/gi, "<\\/style");

const choice = (value: unknown, allowed: string[], fallback: string) => {
  const normalized = String(value ?? "");
  return allowed.includes(normalized) ? normalized : fallback;
};

const opacity = (value: unknown, fallback = "0.45") => {
  const parsed = Number.parseFloat(String(value ?? fallback));
  if (Number.isNaN(parsed)) return fallback;
  return String(Math.min(1, Math.max(0, parsed)));
};

const renderParagraphs = (text: string | undefined, className = "theme-copy") => String(text ?? "")
  .split("\n")
  .map((line) => line.trim() ? `<p class="${className}">${escapeHtml(line)}</p>` : `<div class="copy-spacer"></div>`)
  .join("");

const hasHtmlTags = (value: string) => /<[a-z][\s\S]*>/i.test(value);

// Sanitiza HTML enriquecido autorizado (welcome/contact) antes de renderizarlo
// en el catálogo público. No hay DOM en el servidor, así que es un saneado
// conservador por blocklist: elimina elementos ejecutables, atributos on* y
// esquemas de URL peligrosos. Mitiga XSS almacenado por config.
const sanitizeRichHtml = (html: string): string => {
  let out = html;
  // Elementos peligrosos + su contenido.
  out = out.replace(/<\s*(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  // Etiquetas peligrosas sueltas / self-closing.
  out = out.replace(/<\s*\/?\s*(script|style|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, "");
  // Atributos de evento (onclick, onerror, …).
  out = out.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // URLs javascript:/vbscript:/data: en atributos.
  out = out.replace(/(href|src|xlink:href)\s*=\s*("|')?\s*(javascript|vbscript|data)\s*:/gi, "$1=$2#");
  return out;
};

const renderAdminHtml = (text: string | undefined, className = "theme-copy") => {
  const value = String(text ?? "");
  if (!hasHtmlTags(value)) return renderParagraphs(value, className);
  return `<div class="rich-content ${className}">${sanitizeRichHtml(value)}</div>`;
};

const formatVolume = (min: number, max: number | null) => max ? `${min} a ${max} piezas` : `${min} o más piezas`;
const currency = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const normalizeWhatsappNumber = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  return digits || "524961266304";
};

const numberConfig = (value: unknown, fallback: number) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const integerConfig = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getShippingSettings = (config: Record<string, string>) => {
  const freeMinPieces = integerConfig(config.free_shipping_min_pieces, 501);
  return {
    provider: String(config.shipping_provider || "Estafeta").trim() || "Estafeta",
    price: Math.max(0, numberConfig(config.shipping_price, 150)),
    freeMinPieces: freeMinPieces > 0 ? freeMinPieces : null,
  };
};

const shippingForPieces = (config: Record<string, string>, totalPieces: number) => {
  const settings = getShippingSettings(config);
  const cost = settings.freeMinPieces && totalPieces >= settings.freeMinPieces ? 0 : settings.price;
  return { ...settings, cost };
};

const tierForQuantity = <T extends { min_volume: number; max_volume: number | null }>(tiers: T[], totalPieces: number) => {
  const sorted = [...tiers].sort((a, b) => a.min_volume - b.min_volume);
  if (sorted.length === 0) return null;
  return sorted.find((tier) => totalPieces >= tier.min_volume && (!tier.max_volume || totalPieces <= tier.max_volume)) || sorted[0];
};

const buildThemeCss = (config: Record<string, string>) => {
  const imageFit = choice(config.product_image_fit, ["cover", "contain"], "cover");
  const bodyFontFallback = cssValue(config.font_body, defaultFontFamily);
  const headingFontFallback = cssValue(config.font_heading, defaultFontFamily);

  return `
    ${fontFace("Uploaded Body Font", config.font_body_file)}
    ${fontFace("Uploaded Heading Font", config.font_heading_file)}

    :root {
      --brand-primary: ${cssValue(config.color_primary, "#ef4444")};
      --brand-secondary: ${cssValue(config.color_secondary, "#1f2937")};
      --brand-accent: ${cssValue(config.color_accent, "#f87171")};
      --cover-bg: ${cssValue(config.bg_cover, "#1f2937")};
      --cover-text: ${cssValue(config.color_cover_text, "#ffffff")};
      --welcome-bg: ${cssValue(config.bg_welcome, "#ffffff")};
      --products-bg: ${cssValue(config.bg_products, "#f9fafb")};
      --contact-bg: ${cssValue(config.bg_contact, "#1f2937")};
      --contact-text: ${cssValue(config.color_contact_text, "#ffffff")};
      --card-bg: ${cssValue(config.bg_card, "#ffffff")};
      --card-border: ${cssValue(config.color_card_border, "#e5e7eb")};
      --table-header-bg: ${cssValue(config.bg_table_header, "#f3f4f6")};
      --table-header-text: ${cssValue(config.color_table_header_text, "#4b5563")};
      --body-text: ${cssValue(config.color_body_text, "#374151")};
      --heading-text: ${cssValue(config.color_heading_text, "#111827")};
      --muted-text: ${cssValue(config.color_muted_text, "#6b7280")};
      --font-body: ${uploadedFontStack("Uploaded Body Font", config.font_body_file, bodyFontFallback)};
      --font-heading: ${uploadedFontStack("Uploaded Heading Font", config.font_heading_file, headingFontFallback)};
      --radius: ${cssValue(config.border_radius, "0.75rem")};
      --button-radius: ${cssValue(config.button_radius, "0.75rem")};
      --card-shadow: ${cssValue(config.card_shadow, "0 18px 45px rgba(15, 23, 42, 0.12)")};
      --shape-color: ${cssValue(config.decorative_shape_color, "rgba(239, 68, 68, 0.12)")};
      --shape-opacity: ${opacity(config.decorative_shape_opacity)};
      --shape-blur: ${cssValue(config.decorative_shape_blur, "0px")};
      --ln-font-heading: 'Montserrat', 'Montserrat-fallback', sans-serif;
      --ln-font-body: 'Montserrat', 'Montserrat-fallback', sans-serif;
    }

    /* Fallback con métricas de Montserrat sobre Arial: el texto ocupa el mismo
       espacio antes y después del swap de la webfont (anti-CLS). */
    @font-face {
      font-family: 'Montserrat-fallback';
      src: local('Arial');
      size-adjust: 112.84%;
      ascent-override: 85.79%;
      descent-override: 22.25%;
      line-gap-override: 0%;
    }

    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body.catalog-body {
      margin: 0;
      background: var(--products-bg);
      color: var(--body-text);
      font-family: var(--font-body);
      line-height: 1.55;
      --section-y: 4.5rem;
      --section-x: 1.25rem;
      --product-gap: 2rem;
      --card-padding: 1.5rem;
    }
    body.density-compact { --section-y: 3rem; --product-gap: 1.25rem; --card-padding: 1rem; }
    body.density-spacious { --section-y: 6rem; --product-gap: 3rem; --card-padding: 2rem; }
    h1, h2, h3, h4 { color: var(--heading-text); font-family: var(--font-heading); line-height: 1.08; }
    a { color: inherit; }
    .page-section { position: relative; overflow: hidden; padding: var(--section-y) var(--section-x); }
    .page-shell { position: relative; z-index: 1; width: min(1120px, 100%); margin: 0 auto; }
    .page-break { break-after: page; page-break-after: always; }
    .page-break-inside-avoid { break-inside: avoid; page-break-inside: avoid; }

    .action-bar { position: fixed; top: 1rem; right: 1rem; z-index: 20; display: flex; gap: .65rem; align-items: center; }
    .theme-button, .admin-link, .cart-button, .quote-button {
      border: 0;
      border-radius: var(--button-radius);
      background: var(--brand-primary);
      color: white;
      box-shadow: 0 10px 25px rgba(15, 23, 42, .16);
      cursor: pointer;
      font-weight: 700;
      padding: .75rem 1rem;
      text-decoration: none;
      transition: transform .2s ease, box-shadow .2s ease, filter .2s ease;
    }
    .admin-link { background: color-mix(in srgb, var(--brand-secondary) 86%, white); font-size: .9rem; }
    .theme-button:hover, .admin-link:hover, .cart-button:hover, .quote-button:hover { transform: translateY(-1px); filter: brightness(.98); box-shadow: 0 14px 30px rgba(15, 23, 42, .2); }
    .quote-button:disabled { cursor: not-allowed; opacity: .55; transform: none; }

    .cover-section { min-height: 100vh; display: grid; place-items: center; background: var(--cover-bg); color: var(--cover-text); text-align: center; }
    .cover-section h1 { color: var(--cover-text); font-size: clamp(3rem, 10vw, 7.5rem); margin: 1.5rem 0 .75rem; letter-spacing: -.07em; }
    .cover-subtitle { color: var(--cover-text); font-size: clamp(1rem, 2.6vw, 1.55rem); font-weight: 700; letter-spacing: .28em; opacity: .78; text-transform: uppercase; }
    .logo-image { display: block; width: min(280px, 70vw); max-height: 240px; object-fit: contain; margin: 0 auto; }
    .logo-fallback { width: min(220px, 58vw); aspect-ratio: 1; border-radius: 999px; display: grid; place-items: center; margin: 0 auto; background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.28); color: var(--cover-text); font-size: 2rem; font-weight: 800; }

    .welcome-section { background: var(--welcome-bg); }
    .welcome-section .page-shell { width: min(920px, 100%); }
    .theme-copy { margin: 0 0 1rem; font-size: clamp(1rem, 2vw, 1.12rem); color: var(--body-text); }
    .rich-content { color: var(--body-text); font-size: clamp(1rem, 2vw, 1.12rem); }
    .rich-content > :first-child { margin-top: 0; }
    .rich-content > :last-child { margin-bottom: 0; }
    .rich-content p, .rich-content ul, .rich-content ol, .rich-content table, .rich-content blockquote { margin: 0 0 1rem; }
    .rich-content ul, .rich-content ol { padding-left: 1.5rem; }
    .rich-content a { color: var(--brand-primary); text-decoration: underline; }
    .rich-content strong, .rich-content b { color: inherit; font-weight: 800; }
    .rich-content table { min-width: 0; }
    .rich-content img { max-width: 100%; height: auto; border-radius: var(--radius); }
    .copy-spacer { height: .7rem; }
    .section-title { margin: 0 0 2rem; text-align: center; font-size: clamp(2rem, 6vw, 3.5rem); letter-spacing: -.04em; }
    .subsection-title { margin: 3rem 0 1.25rem; font-size: clamp(1.45rem, 4vw, 2rem); }

    .pricing-table-wrap, .product-table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--card-border); background: var(--card-bg); box-shadow: var(--card-shadow); }
    table { width: 100%; border-collapse: collapse; min-width: 520px; }
    th { background: var(--table-header-bg); color: var(--table-header-text); font-size: .76rem; letter-spacing: .08em; padding: .9rem 1rem; text-align: left; text-transform: uppercase; }
    td { border-top: 1px solid var(--card-border); padding: 1rem; color: var(--body-text); }
    .price-text { color: var(--brand-primary); font-weight: 800; }
    .pricing-note { color: var(--muted-text); font-size: .92rem; margin-top: 1rem; }

    .products-section { background: var(--products-bg); }
    .products-group { margin-top: 2.5rem; }
    .products-group:first-of-type { margin-top: 0; }
    .category-title { color: var(--heading-text); font-size: 1.6rem; margin: 0 0 1.5rem; padding-bottom: .55rem; border-bottom: 2px solid var(--brand-primary); display: inline-block; }
    .category-title-orphan { color: var(--muted-text); border-bottom-color: var(--card-border); }
    .subcategory-title { color: var(--heading-text); font-size: 1.15rem; font-weight: 600; margin: 1.75rem 0 1rem; padding-left: .6rem; border-left: 3px solid var(--brand-primary); opacity: .85; }
    .products-grid + .subcategory-title { margin-top: 2rem; }
    .products-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--product-gap); }
    .theme-card { background: var(--card-bg); border: 1px solid transparent; border-radius: var(--radius); box-shadow: var(--card-shadow); overflow: hidden; transition: transform .2s ease, box-shadow .2s ease; }
    .theme-card:hover { transform: translateY(-3px); }
    body.card-style-bordered .theme-card { border-color: var(--card-border); box-shadow: none; }
    body.card-style-minimal .theme-card { border-color: transparent; box-shadow: none; background: transparent; }
    .product-image, .product-image-fallback { width: 100%; height: 260px; display: block; }
    .product-image { object-fit: ${imageFit}; background: var(--card-bg); }
    .product-image-fallback { display: grid; place-items: center; color: var(--muted-text); background: color-mix(in srgb, var(--products-bg) 80%, white); }
    .product-content { padding: var(--card-padding); }
    .product-title { margin: 0 0 .65rem; font-size: 1.35rem; }
    .product-description { color: var(--muted-text); margin: 0 0 1.35rem; }
    .product-table { min-width: 0; }
    .product-table th, .product-table td { padding: .75rem; }
    .empty-products { text-align: center; color: var(--muted-text); grid-column: 1 / -1; padding: 3rem 0; }

    .cart-control { display: grid; grid-template-columns: 110px 1fr; gap: .75rem; margin-top: 1.25rem; align-items: center; }
    .cart-quantity { width: 100%; border: 1px solid var(--card-border); border-radius: var(--button-radius); padding: .75rem .85rem; font: inherit; color: var(--body-text); background: white; }
    .quote-cart { background: color-mix(in srgb, var(--products-bg) 88%, white); border-top: 1px solid var(--card-border); padding: 2rem var(--section-x); }
    .cart-panel { width: min(1120px, 100%); margin: 0 auto; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); box-shadow: var(--card-shadow); padding: 1.25rem; }
    .cart-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .cart-header h2 { margin: 0; font-size: clamp(1.45rem, 4vw, 2.2rem); }
    .cart-lines { display: grid; gap: .75rem; }
    .cart-line { display: grid; grid-template-columns: 1fr auto; gap: 1rem; align-items: center; padding: .85rem; border: 1px solid var(--card-border); border-radius: var(--radius); }
    .cart-line-title { margin: 0 0 .25rem; font-weight: 800; color: var(--heading-text); }
    .cart-line-meta { margin: 0; color: var(--muted-text); font-size: .9rem; }
    .cart-line-actions { display: flex; align-items: center; gap: .5rem; }
    .cart-line-actions input { width: 86px; border: 1px solid var(--card-border); border-radius: var(--button-radius); padding: .55rem; }
    .remove-cart-item { border: 0; background: transparent; color: var(--brand-primary); cursor: pointer; font-weight: 800; }
    .cart-empty { color: var(--muted-text); padding: 1rem; border: 1px dashed var(--card-border); border-radius: var(--radius); text-align: center; }
    .cart-totals { display: grid; gap: .35rem; margin: 1rem 0; color: var(--body-text); }
    .cart-total-row { display: flex; justify-content: space-between; gap: 1rem; }
    .cart-total-row strong { color: var(--heading-text); }
    .quote-actions { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; justify-content: flex-end; }
    .quote-note { color: var(--muted-text); font-size: .9rem; margin: 0; }
    .customer-modal { position: fixed; inset: 0; z-index: 50; display: none; align-items: center; justify-content: center; padding: 1rem; background: rgba(15, 23, 42, .58); }
    .customer-modal.open { display: flex; }
    .modal-card { width: min(440px, 100%); background: white; border-radius: var(--radius); padding: 1.25rem; box-shadow: 0 25px 70px rgba(15, 23, 42, .28); }
    .modal-card h2 { margin: 0 0 .5rem; }
    .modal-card label { display: block; font-weight: 800; color: var(--heading-text); margin-top: 1rem; }
    .modal-card input { width: 100%; border: 1px solid var(--card-border); border-radius: var(--button-radius); padding: .8rem; margin-top: .35rem; font: inherit; }
    .modal-actions { display: flex; justify-content: flex-end; gap: .75rem; margin-top: 1.25rem; }
    .secondary-button { border: 1px solid var(--card-border); border-radius: var(--button-radius); background: white; color: var(--body-text); padding: .75rem 1rem; cursor: pointer; font-weight: 800; }

    .contact-section { background: var(--contact-bg); color: var(--contact-text); text-align: center; }
    .contact-section h1, .contact-section h2, .contact-section h3, .contact-section h4, .contact-section p { color: var(--contact-text); }
    .contact-section .page-shell { width: min(860px, 100%); }

    /* ── Landing page (legacy — kept for backward compat) ── */
    .landing-featured-card { display: block; text-decoration: none; color: inherit; }

    /* ── Landing redesign v2 ── */
    .ln-nav { position: fixed; top: 0; width: 100%; z-index: 50; background: color-mix(in srgb, var(--cover-bg) 92%, transparent); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid color-mix(in srgb, var(--cover-text) 12%, transparent); }
    .ln-nav-inner { display: flex; justify-content: space-between; align-items: center; padding: 1rem 2rem; max-width: 1440px; margin: 0 auto; gap: 1rem; }
    .ln-brand { display: flex; align-items: center; gap: .5rem; text-decoration: none; color: var(--cover-text); font-family: var(--font-heading); font-size: 1.125rem; font-weight: 700; }
    .ln-brand img { width: 2rem; height: 2rem; object-fit: contain; }
    .ln-nav-links { display: flex; gap: 2rem; align-items: center; }
    .ln-nav-links a { text-decoration: none; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: color-mix(in srgb, var(--cover-text) 60%, transparent); transition: color .15s; }
    .ln-nav-links a:hover { color: var(--cover-text); }
    .ln-nav-cta { display: inline-flex; align-items: center; justify-content: center; background: var(--brand-primary); color: white; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; padding: .625rem 1.25rem; border-radius: var(--button-radius); text-decoration: none; transition: filter .15s, transform .1s; white-space: nowrap; }
    .ln-nav-cta:hover { filter: brightness(.88); }
    .ln-nav-cta:active { transform: scale(.97); }

    .ln-nav-inner { font-family: var(--ln-font-body); }
    .ln-main { padding-top: 72px; font-family: var(--ln-font-body); }

    .ln-hero { min-height: calc(100vh - 72px); display: grid; place-items: center; padding: 4rem 2rem; background: var(--cover-bg); color: var(--cover-text); position: relative; overflow: hidden; }
    .ln-hero-grid-bg { position: absolute; inset: 0; pointer-events: none; opacity: .07; background-image: linear-gradient(to right, var(--cover-text) 1px, transparent 1px), linear-gradient(to bottom, var(--cover-text) 1px, transparent 1px); background-size: 40px 40px; }
    .ln-hero-inner { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; align-items: center; width: min(1440px, 100%); margin: 0 auto; }
    .ln-hero-text { display: flex; flex-direction: column; gap: 1.5rem; }
    .ln-hero h1 { color: var(--cover-text); font-family: var(--ln-font-heading); font-size: clamp(1.9rem, 4.5vw, 2.75rem); line-height: 1.2; letter-spacing: -.02em; margin: 0; }
    .ln-hero h1 span { color: color-mix(in srgb, var(--cover-text) 52%, transparent); }
    .ln-hero-sub { color: color-mix(in srgb, var(--cover-text) 70%, transparent); font-size: 1.075rem; line-height: 1.6; margin: 0; }
    .ln-hero-actions { display: flex; flex-wrap: wrap; gap: 1rem; }
    .ln-btn-primary { display: inline-flex; align-items: center; gap: .5rem; background: var(--brand-primary); color: white; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; padding: 1rem 2rem; border-radius: var(--button-radius); text-decoration: none; transition: filter .15s, transform .1s; }
    .ln-btn-primary:hover { filter: brightness(.88); }
    .ln-btn-primary:active { transform: scale(.97); }
    .ln-btn-outline { display: inline-flex; align-items: center; justify-content: center; background: transparent; color: var(--cover-text); font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; padding: 1rem 2rem; border-radius: var(--button-radius); border: 1px solid color-mix(in srgb, var(--cover-text) 28%, transparent); text-decoration: none; transition: background .15s; }
    .ln-btn-outline:hover { background: color-mix(in srgb, var(--cover-text) 8%, transparent); }
    .ln-btn-solid { display: inline-flex; align-items: center; gap: .5rem; background: var(--brand-primary); color: white; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; padding: .75rem 1.5rem; border-radius: var(--button-radius); text-decoration: none; transition: filter .15s, transform .1s; white-space: nowrap; }
    .ln-btn-solid:hover { filter: brightness(.88); }
    .ln-btn-solid:active { transform: scale(.97); }
    .ln-hero-trust { display: flex; flex-wrap: wrap; gap: 1.5rem; padding-top: 2rem; border-top: 1px solid color-mix(in srgb, var(--cover-text) 12%, transparent); }
    .ln-trust-item { display: flex; align-items: center; gap: .5rem; font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: color-mix(in srgb, var(--cover-text) 52%, transparent); }
    .ln-trust-item .msi { font-size: 1rem; }
    .ln-hero-img-wrap { position: relative; border-radius: var(--radius); overflow: hidden; aspect-ratio: 4/3; border: 1px solid color-mix(in srgb, var(--cover-text) 12%, transparent); background: color-mix(in srgb, var(--cover-bg) 60%, black); }
    .ln-hero-img-wrap img { width: 100%; height: 100%; object-fit: cover; }
    .ln-hero-logo-fallback { width: 100%; height: 100%; display: grid; place-items: center; color: color-mix(in srgb, var(--cover-text) 28%, transparent); font-size: 4rem; font-family: var(--ln-font-heading); font-weight: 700; }

    .ln-section-dark { padding: 5rem 2rem; background: color-mix(in srgb, var(--cover-bg) 88%, black); border-top: 1px solid color-mix(in srgb, var(--cover-text) 10%, transparent); color: var(--cover-text); }
    .ln-section-light { padding: 5rem 2rem; background: var(--products-bg); color: var(--body-text); }
    .ln-section-mid { padding: 5rem 2rem; background: var(--welcome-bg); color: var(--body-text); }
    .ln-inner { width: min(1440px, 100%); margin: 0 auto; }
    .ln-inner-narrow { width: min(820px, 100%); margin: 0 auto; }

    .ln-heading-dark { color: var(--cover-text); font-family: var(--ln-font-heading); font-size: clamp(1.6rem, 3.5vw, 2.4rem); letter-spacing: -.02em; margin: 0 0 .75rem; }
    .ln-heading-light { color: var(--heading-text); font-family: var(--ln-font-heading); font-size: clamp(1.6rem, 3.5vw, 2.4rem); letter-spacing: -.02em; margin: 0 0 .75rem; text-align: center; }
    .ln-sub-dark { color: color-mix(in srgb, var(--cover-text) 62%, transparent); font-size: 1rem; margin: 0 0 2.5rem; max-width: 60ch; }
    .ln-sub-light { color: var(--muted-text); font-size: 1rem; margin: 0 0 2.5rem; text-align: center; }

    /* Pricing table */
    .ln-table-wrap { overflow-x: auto; border: 1px solid color-mix(in srgb, var(--cover-text) 14%, transparent); border-radius: var(--radius); background: color-mix(in srgb, var(--cover-bg) 70%, black); }
    .ln-table { width: 100%; border-collapse: collapse; min-width: 440px; }
    .ln-table thead tr { background: color-mix(in srgb, var(--cover-bg) 55%, black); }
    .ln-table th { padding: .9rem 1.5rem; text-align: left; font-size: .68rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: color-mix(in srgb, var(--cover-text) 55%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--cover-text) 14%, transparent); background: transparent; }
    .ln-table td { padding: 1rem 1.5rem; color: var(--cover-text); font-size: .9rem; font-weight: 500; border-top: 1px solid color-mix(in srgb, var(--cover-text) 8%, transparent); }
    .ln-table tr:hover td { background: color-mix(in srgb, var(--cover-text) 4%, transparent); }
    .ln-price-hi { color: var(--cover-text); font-weight: 700; }
    .ln-price-lo { color: color-mix(in srgb, var(--cover-text) 52%, transparent); font-style: italic; }
    .ln-table-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1.25rem; }
    .ln-table-note { display: flex; align-items: center; gap: .5rem; font-size: .68rem; letter-spacing: .05em; color: color-mix(in srgb, var(--cover-text) 52%, transparent); }
    .ln-table-note strong { color: var(--cover-text); }
    .ln-table-note .msi { font-size: 1rem; }

    /* Process steps */
    .ln-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin-top: 3rem; }
    .ln-step { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; border: 1px solid color-mix(in srgb, var(--cover-text) 12%, transparent); border-radius: var(--radius); background: color-mix(in srgb, var(--cover-bg) 65%, black); }
    .ln-step-num { width: 2rem; height: 2rem; border-radius: 50%; background: var(--brand-primary); color: white; display: grid; place-items: center; font-size: .72rem; font-weight: 700; flex-shrink: 0; }
    .ln-step h3 { color: var(--cover-text); margin: 0; font-size: 1rem; font-weight: 600; }
    .ln-step p { color: color-mix(in srgb, var(--cover-text) 58%, transparent); margin: 0; font-size: .9rem; line-height: 1.6; }
    .ln-steps-cta { text-align: center; margin-top: 2.5rem; }

    /* Location */
    .ln-location-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4rem; align-items: center; }
    .ln-location-items { display: flex; flex-direction: column; gap: .75rem; margin-top: 1.5rem; }
    .ln-location-item { display: flex; align-items: flex-start; gap: .75rem; padding: 1rem; border-radius: var(--radius); border: 1px solid var(--card-border); background: var(--card-bg); }
    .ln-location-item .msi { color: var(--brand-primary); flex-shrink: 0; margin-top: .1rem; }
    .ln-location-item-body { display: flex; flex-direction: column; gap: .15rem; }
    .ln-location-label { font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: var(--muted-text); }
    .ln-location-value { color: var(--body-text); font-size: .95rem; }
    .ln-location-value a { color: var(--brand-primary); text-decoration: none; }
    .ln-map-placeholder { border-radius: var(--radius); aspect-ratio: 4/3; border: 1px solid var(--card-border); background: var(--products-bg); display: grid; place-items: center; color: var(--muted-text); text-align: center; padding: 2rem; }
    .ln-map-link { display: inline-flex; align-items: center; gap: .5rem; color: var(--brand-primary); text-decoration: none; font-weight: 600; margin-top: .75rem; font-size: .9rem; }

    /* FAQ */
    .ln-faq-list { display: flex; flex-direction: column; margin-top: 2.5rem; }
    details.ln-faq-item { border-bottom: 1px solid color-mix(in srgb, var(--cover-text) 10%, transparent); }
    details.ln-faq-item:first-child { border-top: 1px solid color-mix(in srgb, var(--cover-text) 10%, transparent); }
    details.ln-faq-item summary { cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; padding: 1.2rem 0; gap: 1rem; color: var(--cover-text); font-weight: 600; font-size: .95rem; }
    details.ln-faq-item summary::-webkit-details-marker { display: none; }
    details.ln-faq-item summary::after { content: "+"; flex-shrink: 0; width: 1.5rem; height: 1.5rem; display: grid; place-items: center; border: 1px solid color-mix(in srgb, var(--cover-text) 24%, transparent); border-radius: 50%; font-size: .9rem; color: color-mix(in srgb, var(--cover-text) 52%, transparent); }
    details.ln-faq-item[open] summary::after { content: "−"; }
    .ln-faq-answer { padding: 0 0 1.2rem; color: color-mix(in srgb, var(--cover-text) 62%, transparent); font-size: .9rem; line-height: 1.7; margin: 0; }

    /* CTA banner */
    .ln-cta-banner { padding: 5rem 2rem; background: var(--brand-primary); color: white; text-align: center; }
    .ln-cta-banner h2 { color: white; font-family: var(--ln-font-heading); font-size: clamp(1.6rem, 3.5vw, 2.4rem); letter-spacing: -.02em; margin: 0 0 .75rem; }
    .ln-cta-banner p { color: rgba(255,255,255,.84); margin: 0 0 2rem; max-width: 52ch; margin-left: auto; margin-right: auto; font-size: 1.05rem; }
    .ln-cta-btn { display: inline-flex; align-items: center; gap: .5rem; background: white; color: var(--brand-primary); font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; padding: 1rem 2rem; border-radius: var(--button-radius); text-decoration: none; transition: filter .15s, transform .1s; }
    .ln-cta-btn:hover { filter: brightness(.96); }
    .ln-cta-btn:active { transform: scale(.97); }

    /* Footer */
    .ln-footer { padding: 4rem 2rem; background: color-mix(in srgb, var(--cover-bg) 92%, black); border-top: 1px solid color-mix(in srgb, var(--cover-text) 10%, transparent); color: var(--cover-text); font-family: var(--ln-font-body); }
    .ln-footer-inner { width: min(1440px, 100%); margin: 0 auto; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 2rem; }
    .ln-footer-brand { display: flex; flex-direction: column; gap: 1rem; }
    .ln-footer-brand-name { display: flex; align-items: center; gap: .5rem; font-family: var(--font-heading); font-size: 1.1rem; font-weight: 700; color: var(--cover-text); }
    .ln-footer-brand-name img { width: 1.5rem; height: 1.5rem; object-fit: contain; filter: grayscale(1) brightness(2); }
    .ln-footer-tagline { font-size: .78rem; color: color-mix(in srgb, var(--cover-text) 52%, transparent); line-height: 1.5; margin: 0; }
    .ln-footer-copy { font-size: .7rem; color: color-mix(in srgb, var(--cover-text) 38%, transparent); margin: auto 0 0; }
    .ln-footer-col { display: flex; flex-direction: column; gap: .75rem; }
    .ln-footer-col-title { font-size: .62rem; letter-spacing: .08em; text-transform: uppercase; font-weight: 700; color: color-mix(in srgb, var(--cover-text) 42%, transparent); margin: 0; }
    .ln-footer-col a { font-size: .92rem; color: color-mix(in srgb, var(--cover-text) 65%, transparent); text-decoration: none; transition: color .15s; display: flex; align-items: center; gap: .4rem; }
    .ln-footer-col a:hover { color: var(--cover-text); }
    .ln-footer-col a .msi { font-size: 1rem; }

    /* Material Symbols helper */
    .msi { font-family: 'Material Symbols Outlined'; font-variation-settings: 'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24; font-style: normal; display: inline-block; vertical-align: middle; line-height: 1; }

    .theme-shapes { position: absolute; inset: 0; pointer-events: none; opacity: var(--shape-opacity); filter: blur(var(--shape-blur)); z-index: 0; }
    .theme-shapes span { position: absolute; display: block; background: var(--shape-color); }
    .shape-organic .shape-one { width: 380px; height: 380px; top: -120px; right: -90px; border-radius: 42% 58% 63% 37% / 42% 40% 60% 58%; }
    .shape-organic .shape-two { width: 260px; height: 260px; bottom: 8%; left: -90px; border-radius: 62% 38% 42% 58% / 48% 55% 45% 52%; }
    .shape-organic .shape-three { width: 120px; height: 120px; right: 18%; bottom: 18%; border-radius: 999px; }
    .shape-circles span { border-radius: 999px; }
    .shape-circles .shape-one { width: 320px; height: 320px; top: -80px; right: -80px; }
    .shape-circles .shape-two { width: 180px; height: 180px; bottom: 14%; left: 6%; }
    .shape-circles .shape-three { width: 90px; height: 90px; right: 22%; bottom: 10%; }
    .shape-diagonal .shape-one { width: 90vw; height: 26vh; top: 5%; left: -18vw; transform: rotate(-12deg); }
    .shape-diagonal .shape-two { width: 70vw; height: 18vh; bottom: 12%; right: -20vw; transform: rotate(-12deg); }
    .shape-diagonal .shape-three { display: none; }
    .shape-dots { background-image: radial-gradient(var(--shape-color) 1.8px, transparent 1.8px); background-size: 28px 28px; }
    .shape-dots span { display: none; }

    @media (max-width: 900px) {
      .products-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .cart-line { grid-template-columns: 1fr; }
      .ln-hero-inner { grid-template-columns: 1fr; }
      .ln-hero-img-wrap { display: none; }
      .ln-steps { grid-template-columns: 1fr; }
      .ln-location-grid { grid-template-columns: 1fr; }
      .ln-map-placeholder { display: none; }
      .ln-footer-inner { grid-template-columns: 1fr 1fr; gap: 2rem 3rem; }
      .ln-nav-links { display: none; }
    }
    @media (max-width: 640px) {
      body.catalog-body { --section-x: 1rem; }
      .action-bar { left: 1rem; right: 1rem; justify-content: space-between; }
      .theme-button, .admin-link { padding: .65rem .85rem; }
      .products-grid { grid-template-columns: 1fr; }
      .product-image, .product-image-fallback { height: 220px; }
      table { min-width: 440px; }
      .cart-control { grid-template-columns: 1fr; }
      .quote-actions { justify-content: stretch; }
      .quote-button, .secondary-button { width: 100%; }
      .ln-hero { padding: 3rem 1rem; }
      .ln-hero-actions { flex-direction: column; }
      .ln-btn-primary, .ln-btn-outline { text-align: center; justify-content: center; }
      .ln-section-dark, .ln-section-light, .ln-section-mid { padding: 3.5rem 1rem; }
      .ln-footer-inner { grid-template-columns: 1fr; }
      .ln-nav-inner { padding: 1rem; }
      .ln-nav-cta { display: none; }
    }
    @media print {
      .no-print, .quote-cart, .customer-modal { display: none !important; }
      body.catalog-body { background: white; color: #111827; }
      .page-section { min-height: 100vh; box-shadow: none !important; }
      .theme-card, .pricing-table-wrap, .product-table-wrap { box-shadow: none !important; }
      .theme-shapes { opacity: .18; }
      .products-group-page-break { break-before: page; page-break-before: always; }
      .category-title { break-after: avoid; page-break-after: avoid; }
      .subcategory-title { break-after: avoid; page-break-after: avoid; break-inside: avoid; }
    }

    :root[data-theme="dark"] {
      --cover-bg: ${cssValue(config.dark_bg_cover, "#0c1117")};
      --cover-text: ${cssValue(config.dark_color_cover_text, "#f1f5f9")};
      --welcome-bg: ${cssValue(config.dark_bg_welcome, "#111827")};
      --products-bg: ${cssValue(config.dark_bg_products, "#1f2937")};
      --card-bg: ${cssValue(config.dark_bg_card, "#1e293b")};
      --card-border: ${cssValue(config.dark_color_card_border, "#374151")};
      --table-header-bg: ${cssValue(config.dark_bg_table_header, "#374151")};
      --table-header-text: ${cssValue(config.dark_color_table_header_text, "#d1d5db")};
      --body-text: ${cssValue(config.dark_color_body_text, "#e2e8f0")};
      --heading-text: ${cssValue(config.dark_color_heading_text, "#f8fafc")};
      --muted-text: ${cssValue(config.dark_color_muted_text, "#94a3b8")};
    }

    [data-theme="dark"] .ln-cta-banner {
      background: ${cssValue(config.dark_bg_cta, "#1e3a5f")};
    }

    [data-theme="dark"] .ln-section-dark {
      background: ${cssValue(config.dark_bg_section_dark, "#0f172a")};
      border-top-color: ${cssValue(config.dark_color_card_border, "#374151")};
      color: ${cssValue(config.dark_color_body_text, "#e2e8f0")};
    }
    [data-theme="dark"] .ln-table-wrap { background: var(--card-bg); border-color: var(--card-border); }
    [data-theme="dark"] .ln-table thead tr { background: var(--table-header-bg); }
    [data-theme="dark"] .ln-table th { color: var(--table-header-text); border-bottom-color: var(--card-border); }
    [data-theme="dark"] .ln-table td { color: var(--body-text); border-top-color: var(--card-border); }
    [data-theme="dark"] .ln-table tr:hover td { background: var(--table-header-bg); }
    [data-theme="dark"] .ln-step { background: var(--card-bg); border-color: var(--card-border); }
    [data-theme="dark"] .ln-step h3 { color: var(--heading-text); }
    [data-theme="dark"] .ln-step p { color: var(--muted-text); }
    [data-theme="dark"] details.ln-faq-item { border-bottom-color: var(--card-border); }
    [data-theme="dark"] details.ln-faq-item:first-child { border-top-color: var(--card-border); }
    [data-theme="dark"] details.ln-faq-item summary { color: var(--heading-text); }
    [data-theme="dark"] details.ln-faq-item summary::after { border-color: var(--card-border); }
    [data-theme="dark"] .ln-faq-answer { color: var(--muted-text); }
    [data-theme="dark"] .ln-table-note { color: var(--muted-text); }
    [data-theme="dark"] .ln-table-note strong { color: var(--heading-text); }

    .ln-carousel { position: relative; overflow: hidden; }
    .ln-carousel-slide { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.7s ease; }
    .ln-carousel-slide.active { opacity: 1; position: relative; }
    .ln-carousel-slide:first-child { position: relative; }

    ${customCss(config.custom_css)}
  `.trim();
};

const renderShapes = (config: Record<string, string>) => {
  if (config.decorative_shapes_enabled !== "1") return "";
  const style = choice(config.decorative_shape_style, ["organic", "circles", "diagonal", "dots"], "organic");
  return `<div class="theme-shapes shape-${style}" aria-hidden="true"><span class="shape-one"></span><span class="shape-two"></span><span class="shape-three"></span></div>`;
};

// `seo` opcional: cuando se provee, headMeta YA incluye <title> + meta/OG/canonical
// y jsonLd el bloque structured-data. Cuando falta (solo /imprimir), se emite un
// <title> legacy + noindex para no indexar la vista imprimible (contenido duplicado).
// `lcpImage` precarga la imagen principal (logo/hero) para mejorar LCP.
const Layout = (
  title: string,
  content: string,
  config: Record<string, string>,
  seo?: { headMeta: string; jsonLd: string },
  lcpImage?: string,
  extraHead?: string,
) => {
  const cardStyle = choice(config.card_style, ["flat", "bordered", "minimal"], "flat");
  const density = choice(config.layout_density, ["compact", "comfortable", "spacious"], "comfortable");
  const imageFit = choice(config.product_image_fit, ["cover", "contain"], "cover");

  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${seo ? seo.headMeta : `<title>${escapeHtml(title)}</title>\n    <meta name="robots" content="noindex">`}
    ${pwaHeadTags(config)}
    ${lcpImage ? `<link rel="preload" as="image" href="${escapeHtml(lcpImage)}" fetchpriority="high">` : ""}
    <style>${buildThemeCss(config)}</style>
    ${seo ? seo.jsonLd : ""}
    ${extraHead || ""}
</head>
<body class="catalog-body density-${density} card-style-${cardStyle} image-fit-${imageFit}">
    ${config.dark_mode_enabled !== "0" ? `<script>(function(){
  var s=localStorage.getItem('theme');
  var d=window.matchMedia('(prefers-color-scheme:dark)').matches;
  var t=s||(d?'dark':'light');
  document.documentElement.setAttribute('data-theme',t);
  console.log('[dm] init: ls='+s+' prefers='+d+' applied='+t);
})();</script>` : ""}
    ${content}
    ${pwaRegisterScript()}
</body>
</html>
`;
};

// SeoProduct[] desde las entradas catálogo (precio low/high = min/max de tiers).
const toSeoProducts = (
  entries: Array<{ product: Product; priceTiers: ReturnType<typeof getDefaultPriceTiers> }>,
): SeoProduct[] =>
  entries.map(({ product, priceTiers }) => {
    const prices = priceTiers.map((t) => Number(t.price)).filter((n) => Number.isFinite(n));
    return {
      id: product.id,
      name: product.name,
      description: product.description,
      image_url: product.image_url,
      priceLow: prices.length ? prices[0] : null,
      priceHigh: prices.length ? Math.max(...prices) : null,
    };
  });

// Resuelve el destino de un botón del landing: WhatsApp o ruta interna segura.
const landingTarget = (config: Record<string, string>, target: string | undefined) => {
  if (target === "whatsapp") {
    return `https://wa.me/${normalizeWhatsappNumber(config.quote_whatsapp_number || "4961266304")}`;
  }
  return target && target.startsWith("/") ? target : "/catalogo";
};

// Acceso discreto al panel admin: 5 toques rápidos sobre un elemento [data-admin-gate].
const adminGateScript = () => `
  <script>
  (function () {
    var gates = document.querySelectorAll('[data-admin-gate]');
    if (!gates.length) return;
    var taps = 0, timer = null;
    function onTap() {
      taps++;
      clearTimeout(timer);
      timer = setTimeout(function () { taps = 0; }, 1500);
      if (taps >= 5) { taps = 0; window.location.href = atob('L2FkbWluL2xvZ2lu'); }
    }
    gates.forEach(function (g) { g.addEventListener('click', onTap); });
  })();
  </script>
`;

const getCatalogData = () => {
  const config = getConfig();
  const defaultPriceTiers = getDefaultPriceTiers();
  const products = getProducts();
  const categories = getCategories();
  const subcategories = getSubcategories();
  const productsWithTiers = products.map((product) => ({
    product,
    priceTiers: product.use_default_pricing ? defaultPriceTiers : getProductPriceTiers(product.id),
  }));
  return { config, defaultPriceTiers, productsWithTiers, categories, subcategories };
};

// Agrupa productos por categoría (orden por sort_order). Productos sin
// categoría caen en un grupo final con label "Sin categoría". Si no hay
// categorías definidas, devuelve un único grupo plano sin label.
type CatalogProduct = ReturnType<typeof getCatalogData>["productsWithTiers"][number];
type CatalogSubgroup = { subcategory: Subcategory | null; products: CatalogProduct[] };
type CatalogGroup = { category: Category | null; subgroups: CatalogSubgroup[] };
const groupCatalog = (
  productsWithTiers: CatalogProduct[],
  categories: Category[],
  subcategories: Subcategory[],
): CatalogGroup[] => {
  if (categories.length === 0) return [{ category: null, subgroups: [{ subcategory: null, products: productsWithTiers }] }];
  const byCat = new Map<number, CatalogProduct[]>();
  const orphans: CatalogProduct[] = [];
  for (const entry of productsWithTiers) {
    if (entry.product.category_id == null) { orphans.push(entry); continue; }
    const list = byCat.get(entry.product.category_id) || [];
    list.push(entry);
    byCat.set(entry.product.category_id, list);
  }
  const subsByCat = new Map<number, Subcategory[]>();
  for (const s of subcategories) {
    const list = subsByCat.get(s.category_id) || [];
    list.push(s);
    subsByCat.set(s.category_id, list);
  }

  const groups: CatalogGroup[] = [];
  for (const category of categories) {
    const list = byCat.get(category.id) || [];
    // Saltamos categorías sin productos para no mostrar secciones vacías al público.
    if (list.length === 0) continue;
    const categorySubs = subsByCat.get(category.id) || [];
    const knownSubIds = new Set(categorySubs.map((s) => s.id));
    const bySub = new Map<number, CatalogProduct[]>();
    const noSub: CatalogProduct[] = [];
    for (const entry of list) {
      const sid = entry.product.subcategory_id;
      // subcategory_id nulo, o que ya no pertenece a la categoría → bucket sin subcategoría.
      if (sid == null || !knownSubIds.has(sid)) { noSub.push(entry); continue; }
      const l = bySub.get(sid) || [];
      l.push(entry);
      bySub.set(sid, l);
    }
    const subgroups: CatalogSubgroup[] = [];
    // Los productos sin subcategoría van primero, sin subtítulo.
    if (noSub.length > 0) subgroups.push({ subcategory: null, products: noSub });
    for (const sub of categorySubs) {
      const l = bySub.get(sub.id) || [];
      if (l.length > 0) subgroups.push({ subcategory: sub, products: l });
    }
    groups.push({ category, subgroups });
  }
  if (orphans.length > 0) groups.push({ category: null, subgroups: [{ subcategory: null, products: orphans }] });
  return groups;
};

type QuoteLine = {
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  tier: { min_volume: number; max_volume: number | null; delivery_time: string } | null;
};

const buildQuoteMessage = (input: {
  quoteId?: number;
  customerName: string;
  postalCode: string;
  requiresInvoice?: boolean;
  totalPieces: number;
  lines: QuoteLine[];
  subtotal: number;
  iva?: number;
  shippingProvider: string;
  shippingCost: number;
  grandTotal: number;
}) => {
  const hasMissingPrice = input.lines.some((line) => !line.tier);
  const lines = input.lines.map((line, index) => {
    const unit = line.tier ? currency.format(line.unitPrice) : "A cotizar";
    const subtotal = line.tier ? currency.format(line.subtotal) : "A cotizar";
    const delivery = line.tier?.delivery_time ? ` · Entrega: ${line.tier.delivery_time}` : "";
    return `${index + 1}. ${line.productName} - ${line.quantity} piezas - ${unit} c/u - ${subtotal}${delivery}`;
  }).join("\n");
  const ivaLine = input.requiresInvoice ? `IVA (16%): ${hasMissingPrice ? "A cotizar" : currency.format(input.iva || 0)}\n` : "";

  return `Hola PIXKEY3D, quiero cotizar este pedido:\n\n${input.quoteId ? `Folio: #${input.quoteId}\n` : ""}Nombre: ${input.customerName}\nCódigo postal: ${input.postalCode}${input.requiresInvoice ? "\nRequiere factura: Sí" : ""}\n\nProductos:\n${lines}\n\nTotal de piezas: ${input.totalPieces}\nSubtotal estimado: ${hasMissingPrice ? "A cotizar" : currency.format(input.subtotal)}\n${ivaLine}Envío estimado (${input.shippingProvider}): ${input.shippingCost > 0 ? currency.format(input.shippingCost) : "Gratis"}\nTotal estimado: ${hasMissingPrice ? "A cotizar" : currency.format(input.grandTotal)}\n\nQuedo pendiente de la cotización final con envío.`;
};

const renderCoverSection = (config: Record<string, string>) => `
  <section class="page-section cover-section page-break">
      ${renderShapes(config)}
      <div class="page-shell">
          ${config.company_logo
            ? `<img src="${escapeHtml(optimizedImageSrc(config.company_logo, 400))}" alt="Logo ${escapeHtml(config.company_name)}" class="logo-image" decoding="async" fetchpriority="high" data-admin-gate>`
            : `<div class="logo-fallback" data-admin-gate>Logo</div>`
          }
          <h1 data-admin-gate>${escapeHtml(config.company_name || "PIXKEY3D")}</h1>
          <p class="cover-subtitle">${escapeHtml(config.cover_subtitle || "Catálogo de Productos")}</p>
      </div>
  </section>
  ${adminGateScript()}
`;

const renderWelcomeSection = (config: Record<string, string>, defaultPriceTiers: ReturnType<typeof getDefaultPriceTiers>) => `
  <section class="page-section welcome-section page-break">
      ${renderShapes(config)}
      <div class="page-shell">
          ${renderAdminHtml(config.welcome_text)}
          <h2 class="subsection-title">Precios y tiempos de entrega por volumen</h2>
          <div class="pricing-table-wrap">
              <table>
                  <thead>
                      <tr>
                          <th>Volumen de Piezas</th>
                          <th>Precio por Unidad</th>
                          <th>Tiempo de Entrega</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${defaultPriceTiers.map((tier) => `
                      <tr>
                          <td>${escapeHtml(formatVolume(tier.min_volume, tier.max_volume))}</td>
                          <td class="price-text">$${tier.price.toFixed(2)} MXN</td>
                          <td>${escapeHtml(tier.delivery_time)}</td>
                      </tr>
                      `).join("")}
                  </tbody>
              </table>
          </div>
          <p class="pricing-note">* Los precios aplican por pieza según el volumen total del pedido. El tiempo de entrega inicia una vez confirmado y pagado el pedido. Para 501+ piezas contáctanos para acordar fecha y condiciones.</p>
      </div>
  </section>
`;

const renderProductCard = (
  product: ReturnType<typeof getProducts>[number],
  priceTiers: ReturnType<typeof getDefaultPriceTiers>,
  interactive = false,
) => `
  <article class="theme-card page-break-inside-avoid">
      ${product.image_url
        ? imgTag({ src: optimizedImageSrc(product.image_url, 800), alt: product.name, w: 400, h: 260, className: "product-image", lazy: true })
        : `<div class="product-image-fallback">Sin imagen</div>`
      }
      <div class="product-content">
          <h3 class="product-title">${escapeHtml(product.name)}</h3>
          <p class="product-description">${escapeHtml(product.description || "")}</p>
          <h4>Tabla de Precios</h4>
          <div class="product-table-wrap">
              <table class="product-table">
                  <thead>
                      <tr>
                          <th>Volumen</th>
                          <th>Precio unitario</th>
                      </tr>
                  </thead>
                  <tbody>
                      ${priceTiers.map((tier) => `
                      <tr>
                          <td>${escapeHtml(formatVolume(tier.min_volume, tier.max_volume))}</td>
                          <td class="price-text">$${tier.price.toFixed(2)}</td>
                      </tr>
                      `).join("")}
                  </tbody>
              </table>
          </div>
          ${interactive ? `
          <div class="cart-control">
              <input class="cart-quantity" data-quantity-for="${product.id}" type="number" min="1" step="1" value="25" aria-label="Cantidad para ${escapeHtml(product.name)}">
              <button type="button" class="cart-button" data-add-to-cart="${product.id}">Agregar al carrito</button>
          </div>
          ` : ""}
      </div>
  </article>
`;

const renderProductsSection = (
  config: Record<string, string>,
  productsWithTiers: ReturnType<typeof getCatalogData>["productsWithTiers"],
  categories: Category[],
  subcategories: Subcategory[],
  interactive = false,
) => {
  const groups = groupCatalog(productsWithTiers, categories, subcategories);
  const groupedRender = (group: CatalogGroup, isFirst: boolean) => {
    // Solo el primer grupo lleva el título global de la sección. Los demás
    // grupos abren con su propio título de categoría dentro del shell.
    const categoryTitle = group.category
      ? `<h3 class="category-title">${escapeHtml(group.category.name)}</h3>`
      : (categories.length > 0
          ? `<h3 class="category-title category-title-orphan">Sin categoría</h3>`
          : "");
    // Dentro de cada categoría: subsecciones por subcategoría. Los productos sin
    // subcategoría van primero, sin subtítulo.
    const subgroupsHtml = group.subgroups.map((sg) => {
      const subTitle = sg.subcategory
        ? `<h4 class="subcategory-title">${escapeHtml(sg.subcategory.name)}</h4>`
        : "";
      return `
          ${subTitle}
          <div class="products-grid">
              ${sg.products.map(({ product, priceTiers }) => renderProductCard(product, priceTiers, interactive)).join("")}
          </div>
      `;
    }).join("");
    return `
      <div class="products-group${isFirst ? "" : " products-group-page-break"}">
          ${categoryTitle}
          ${subgroupsHtml}
      </div>
    `;
  };
  return `
  <section class="page-section products-section">
      ${renderShapes(config)}
      <div class="page-shell">
          <h2 class="section-title">${escapeHtml(config.products_title || "Nuestros Productos")}</h2>
          ${productsWithTiers.length === 0
            ? '<p class="empty-products">No hay productos en el catálogo aún.</p>'
            : groups.map((g, i) => groupedRender(g, i === 0)).join("")}
      </div>
  </section>
`;
};

const renderContactSection = (config: Record<string, string>) => `
  <section class="page-section contact-section page-break">
      ${renderShapes(config)}
      <div class="page-shell">
          ${renderAdminHtml(config.contact_text, "theme-copy contact-copy")}
      </div>
  </section>
`;

// ── Landing page v2 ────────────────────────────────────────────────────────────

const msi = (name: string, cls = "") =>
  `<span class="material-symbols-outlined${cls ? ` ${cls}` : ""}" aria-hidden="true">${escapeHtml(name)}</span>`;

const waHref = (config: Record<string, string>, msg = "") => {
  const num = normalizeWhatsappNumber(config.quote_whatsapp_number || "");
  return `https://wa.me/${num}${msg ? `?text=${encodeURIComponent(msg)}` : ""}`;
};

const renderLandingNav = (config: Record<string, string>) => {
  const logo = config.landing_logo || config.company_logo;
  const name = escapeHtml(config.company_name || "PIXKEY3D");
  return `
<header class="ln-nav" role="banner">
  <div class="ln-nav-inner">
    <a class="ln-brand" href="/" data-admin-gate>
      ${logo ? `<img src="${escapeHtml(optimizedImageSrc(logo, 400))}" alt="${name}" width="32" height="32">` : ""}
      ${name}
    </a>
    <nav class="ln-nav-links" aria-label="Navegación principal">
      <a href="#catalogo">Catálogo</a>
      <a href="#precios">Precios</a>
      <a href="#proceso">Proceso</a>
      <a href="#ubicacion">Ubicación</a>
      <a href="#faq">FAQ</a>
    </nav>
    <a class="ln-nav-cta" href="${escapeHtml(waHref(config))}" target="_blank" rel="noopener noreferrer">
      Cotizar por WhatsApp
    </a>
    ${config.dark_mode_enabled !== "0" ? `<button id="dm-toggle" aria-label="Cambiar tema" style="background:none;border:0;cursor:pointer;color:var(--cover-text);padding:.5rem;display:flex;align-items:center;line-height:1" onclick="(function(){
  var cur=document.documentElement.getAttribute('data-theme');
  var t=cur==='dark'?'light':'dark';
  console.log('[dm] toggle: '+cur+' → '+t);
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('theme',t);
  var after=document.documentElement.getAttribute('data-theme');
  console.log('[dm] html[data-theme] after='+after);
  var cs=getComputedStyle(document.documentElement);
  console.log('[dm] --welcome-bg='+cs.getPropertyValue('--welcome-bg').trim());
  console.log('[dm] --body-text='+cs.getPropertyValue('--body-text').trim());
  this.querySelector('span').textContent=t==='dark'?'light_mode':'dark_mode';
}).call(this)">${msi("dark_mode")}</button>` : ""}
  </div>
</header>`;
};

const renderLandingHero = (config: Record<string, string>) => {
  const heroImg = config.landing_hero_image || config.company_logo;
  const title = config.landing_hero_title || config.company_name || "Llaveros y Figuras 3D Personalizados";
  const subtitle = config.landing_hero_subtitle || "Producción en impresión 3D para empresas y eventos. Precios de mayoreo desde $25 MXN, envíos a todo México por Estafeta y recolección local en SLP.";
  const ctaHref = landingTarget(config, config.landing_hero_cta_target);
  const ctaLabel = config.landing_hero_cta_label || "Ver catálogo completo ↓";
  const isExternal = ctaHref.startsWith("http");

  const isCarousel = config.landing_hero_mode === "carousel";
  const carouselImgs = isCarousel
    ? [1, 2, 3, 4, 5].map((i) => config[`landing_hero_carousel_image_${i}`]).filter(Boolean)
    : [];
  const carouselInterval = parseInt(config.landing_hero_carousel_interval || "4000", 10) || 4000;

  const imgColumn = isCarousel
    ? `<div class="ln-hero-img-wrap ln-carousel" id="ln-carousel" aria-hidden="true">
      ${carouselImgs.length === 0
        ? `<div class="ln-hero-logo-fallback">3D</div>`
        : carouselImgs.map((src, i) =>
            `<img src="${escapeHtml(optimizedImageSrc(src as string, 800))}" alt="" class="ln-carousel-slide${i === 0 ? " active" : ""}" decoding="async" ${i === 0 ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"'} width="800" height="600">`
          ).join("")}
    </div>
    ${carouselImgs.length > 1 ? `<script>(function(){var s=document.querySelectorAll('#ln-carousel .ln-carousel-slide'),c=0;setInterval(function(){s[c].classList.remove('active');c=(c+1)%s.length;s[c].classList.add('active');},${carouselInterval});})();</script>` : ""}`
    : `<div class="ln-hero-img-wrap" aria-hidden="true">
      ${heroImg
        ? `<img src="${escapeHtml(optimizedImageSrc(heroImg, 800))}" alt="" decoding="async" fetchpriority="high" loading="eager" width="800" height="600">`
        : `<div class="ln-hero-logo-fallback">3D</div>`}
    </div>`;

  return `
<section class="ln-hero" id="inicio">
  <div class="ln-hero-grid-bg" aria-hidden="true"></div>
  <div class="ln-hero-inner">
    <div class="ln-hero-text">
      <h1>${escapeHtml(title)}</h1>
      <p class="ln-hero-sub">${escapeHtml(subtitle)}</p>
      <div class="ln-hero-actions">
        <a class="ln-btn-primary" href="${escapeHtml(waHref(config))}" target="_blank" rel="noopener noreferrer">
          ${msi("chat")} Cotizar por WhatsApp
        </a>
        <a class="ln-btn-outline" href="${escapeHtml(ctaHref)}"${isExternal ? ' target="_blank" rel="noopener"' : ""}>
          ${escapeHtml(ctaLabel)}
        </a>
      </div>
      <div class="ln-hero-trust" aria-label="Características clave">
        <div class="ln-trust-item">${msi("inventory_2", "msi")} <span>Min. 25 piezas</span></div>
        <div class="ln-trust-item">${msi("local_shipping", "msi")} <span>Envío Nacional</span></div>
        <div class="ln-trust-item">${msi("schedule", "msi")} <span>Lun–Sáb 9–18h</span></div>
      </div>
    </div>
    ${imgColumn}
  </div>
</section>`;
};

const renderLandingPricing = (config: Record<string, string>, tiers: ReturnType<typeof getDefaultPriceTiers>) => {
  const shipping = getShippingSettings(config);
  const sortedTiers = [...tiers].sort((a, b) => a.min_volume - b.min_volume);
  const tiersHtml = sortedTiers.length === 0
    ? `<tr><td colspan="3" style="text-align:center;padding:2rem;color:inherit;opacity:.5">Sin niveles configurados.</td></tr>`
    : sortedTiers.map((t) => `
      <tr>
        <td class="ln-price-hi">${escapeHtml(formatVolume(t.min_volume, t.max_volume))}</td>
        <td class="ln-price-hi">${t.max_volume === null ? `<span class="ln-price-lo">Cotizar proyecto</span>` : `${currency.format(Number(t.price))}`}</td>
        <td>${escapeHtml(t.delivery_time || "—")}</td>
      </tr>`).join("");

  const freeNote = shipping.freeMinPieces
    ? ` · <strong>Gratis desde ${shipping.freeMinPieces} piezas</strong>`
    : "";

  return `
<section class="ln-section-dark" id="precios">
  <div class="ln-inner">
    <h2 class="ln-heading-dark">¿Cuánto cuestan los llaveros 3D al mayoreo?</h2>
    <p class="ln-sub-dark">Precios escalonados por volumen. Materiales de alta calidad, precisión de grado industrial.</p>
    <div class="ln-table-wrap">
      <table class="ln-table">
        <thead>
          <tr><th>Cantidad</th><th>Precio por pieza</th><th>Tiempo de producción</th></tr>
        </thead>
        <tbody>${tiersHtml}</tbody>
      </table>
    </div>
    <div class="ln-table-footer">
      <p class="ln-table-note">${msi("info", "msi")} Envío ${currency.format(shipping.price)} MXN vía ${escapeHtml(shipping.provider)}${freeNote}</p>
      <a class="ln-btn-solid" href="${escapeHtml(waHref(config, "Hola, me interesa una cotización empresarial"))}" target="_blank" rel="noopener noreferrer">
        Solicitar cotización empresarial
      </a>
    </div>
  </div>
</section>`;
};

const renderLandingFeatured = (
  config: Record<string, string>,
  featured: Array<{ product: Product; priceTiers: ReturnType<typeof getDefaultPriceTiers> }>,
) => {
  if (featured.length === 0) return "";
  return `
<section class="ln-section-light" id="catalogo">
  <div class="ln-inner">
    <h2 class="ln-heading-light">${escapeHtml(config.landing_featured_title || "Nuestros Productos")}</h2>
    <div class="products-grid" style="margin-top:2rem;">
      ${featured.map(({ product }) => `
      <a class="theme-card landing-featured-card" href="/catalogo">
        ${product.image_url
          ? imgTag({ src: optimizedImageSrc(product.image_url, 800), alt: product.name, w: 400, h: 260, className: "product-image", lazy: true })
          : `<div class="product-image-fallback">Sin imagen</div>`}
        <div class="product-content">
          <h3 class="product-title">${escapeHtml(product.name)}</h3>
          ${product.description ? `<p class="product-description">${escapeHtml(product.description)}</p>` : ""}
        </div>
      </a>`).join("")}
    </div>
    <div style="text-align:center;margin-top:2.5rem;">
      <a class="theme-button" href="/catalogo">Ver catálogo completo</a>
    </div>
  </div>
</section>`;
};

const renderLandingProcess = (config: Record<string, string>) => {
  const provider = escapeHtml(getShippingSettings(config).provider);
  return `
<section class="ln-section-dark" id="proceso">
  <div class="ln-inner">
    <h2 class="ln-heading-dark" style="text-align:center;">¿Cómo hacer tu pedido?</h2>
    <div class="ln-steps">
      <div class="ln-step">
        <div class="ln-step-num" aria-hidden="true">1</div>
        <h3>Elige tus productos</h3>
        <p>Selecciona del catálogo o solicita un diseño personalizado. Aceptamos archivos STL, OBJ y referencias visuales.</p>
      </div>
      <div class="ln-step">
        <div class="ln-step-num" aria-hidden="true">2</div>
        <h3>Cotiza por WhatsApp</h3>
        <p>Comparte cantidad y modelo. Respondemos en menos de 24 hrs con confirmación y tiempo de entrega exacto.</p>
      </div>
      <div class="ln-step">
        <div class="ln-step-num" aria-hidden="true">3</div>
        <h3>Recibe tu pedido</h3>
        <p>Producción y envío por ${provider} a domicilio, o retiro presencial en San Luis Potosí.</p>
      </div>
    </div>
    <div class="ln-steps-cta">
      <a class="ln-btn-solid" href="${escapeHtml(waHref(config))}" target="_blank" rel="noopener noreferrer">
        ${msi("chat")} Empezar cotización
      </a>
    </div>
  </div>
</section>`;
};

const renderLandingLocation = (config: Record<string, string>) => {
  const provider = escapeHtml(getShippingSettings(config).provider);
  const wa = waHref(config);
  const phone = normalizeWhatsappNumber(config.quote_whatsapp_number || "");
  const displayPhone = phone ? `+${phone}` : "";
  return `
<section class="ln-section-mid" id="ubicacion">
  <div class="ln-inner">
    <div class="ln-location-grid">
      <div>
        <h2 class="ln-heading-light" style="text-align:left;">Retiro y entrega local en San Luis Potosí</h2>
        <p class="ln-sub-light" style="text-align:left;">Fabricamos en San Luis Potosí, S.L.P. y enviamos a toda la república mexicana vía ${provider}. Los clientes locales pueden recoger en persona al terminar la producción.</p>
        <div class="ln-location-items">
          <div class="ln-location-item">
            ${msi("location_on", "msi")}
            <div class="ln-location-item-body">
              <span class="ln-location-label">Ubicación</span>
              <span class="ln-location-value">San Luis Potosí, S.L.P., México</span>
            </div>
          </div>
          <div class="ln-location-item">
            ${msi("schedule", "msi")}
            <div class="ln-location-item-body">
              <span class="ln-location-label">Horario</span>
              <span class="ln-location-value">Lunes a Sábado · 9:00 a 18:00 hrs</span>
            </div>
          </div>
          ${displayPhone ? `
          <div class="ln-location-item">
            ${msi("phone", "msi")}
            <div class="ln-location-item-body">
              <span class="ln-location-label">WhatsApp</span>
              <span class="ln-location-value"><a href="${escapeHtml(wa)}" target="_blank" rel="noopener">${escapeHtml(displayPhone)}</a></span>
            </div>
          </div>` : ""}
        </div>
      </div>
      <div class="ln-map-placeholder">
        ${msi("map")}
        <div style="margin-top:.75rem;">
          <p style="margin:0;font-size:.9rem;">San Luis Potosí, S.L.P.</p>
          <a class="ln-map-link" href="https://maps.google.com/?q=San+Luis+Potosi+SLP+Mexico" target="_blank" rel="noopener">
            ${msi("open_in_new")} Ver en Google Maps
          </a>
        </div>
      </div>
    </div>
  </div>
</section>`;
};

const renderLandingFaq = (config: Record<string, string>) => {
  const shipping = getShippingSettings(config);
  const faqs: Array<[string, string]> = [
    ["¿Cuál es el pedido mínimo de llaveros 3D personalizados?",
      "El pedido mínimo de PIXKEY3D es de 25 piezas. A partir de ese volumen puedes solicitar cotización. Para pedidos mayores el precio por pieza baja según la tabla de precios. Para proyectos especiales escríbenos y buscamos una solución."],
    ["¿De qué material están fabricados los llaveros y figuras?",
      "La mayoría de nuestros productos están fabricados en PLA de alta calidad, un material rígido, liviano y con excelente detalle de impresión. Para piezas que requieren mayor flexibilidad utilizamos PETG. El material exacto de cada producto se confirma al cotizar."],
    ["¿Puedo pedir un diseño personalizado que no está en el catálogo?",
      "Sí. Aceptamos diseños personalizados. Puedes enviarnos tu archivo en formato STL u OBJ, o compartir una referencia visual y cotizamos la factibilidad. Para diseños complejos puede aplicarse un costo adicional de modelado."],
    ["¿Cuánto tiempo tarda la producción y el envío?",
      `El tiempo de producción depende del volumen. El envío por ${shipping.provider} agrega 1 a 3 días hábiles según la zona del país. Los clientes en San Luis Potosí pueden recoger en persona al terminar la producción.`],
    ["¿Qué métodos de pago aceptan?",
      "Aceptamos transferencia bancaria (SPEI), depósito OXXO y pago en efectivo para clientes que recojan en San Luis Potosí. El proceso de pago se coordina directamente por WhatsApp al confirmar el pedido."],
    ["¿Hacen envíos a toda la república mexicana?",
      `Sí, enviamos a toda la república mexicana vía ${shipping.provider}. El costo de envío es de ${currency.format(shipping.price)} MXN${shipping.freeMinPieces ? ` y es gratuito en pedidos de ${shipping.freeMinPieces} piezas o más` : ""}.`],
    ["¿Tienen descuentos para distribuidores o revendedores?",
      "Sí, contamos con precios especiales por volumen para revendedores, empresas y mayoristas. Cuanto mayor el volumen, menor el precio por pieza. Para proyectos de gran volumen el precio es negociable. Contáctanos con tu estimado."],
    ["¿Qué pasa si mi pedido llega con defectos?",
      "La calidad de cada pieza se revisa antes del envío. En caso de que un producto llegue dañado o con defectos de fabricación, coordinamos la reposición o ajuste según el caso. Escríbenos por WhatsApp con fotos del daño dentro de los 5 días hábiles posteriores a la recepción."],
  ];
  return `
<section class="ln-section-dark" id="faq">
  <div class="ln-inner-narrow">
    <h2 class="ln-heading-dark" style="text-align:center;">Preguntas frecuentes</h2>
    <div class="ln-faq-list">
      ${faqs.map(([q, a]) => `
      <details class="ln-faq-item">
        <summary>${escapeHtml(q)}</summary>
        <p class="ln-faq-answer">${escapeHtml(a)}</p>
      </details>`).join("")}
    </div>
  </div>
</section>`;
};

const renderLandingCtaBanner = (config: Record<string, string>) => {
  const title = config.landing_cta_title || "¿Listo para hacer tu pedido?";
  const text = config.landing_cta_text || "Contáctanos por WhatsApp y te cotizamos en menos de 24 horas.";
  const label = config.landing_cta_button_label || "Cotizar por WhatsApp";
  const href = (!config.landing_cta_button_target || config.landing_cta_button_target === "whatsapp")
    ? waHref(config)
    : landingTarget(config, config.landing_cta_button_target);
  return `
<section class="ln-cta-banner">
  <h2>${escapeHtml(title)}</h2>
  <p>${escapeHtml(text)}</p>
  <a class="ln-cta-btn" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
    ${msi("chat")} ${escapeHtml(label)}
  </a>
</section>`;
};

const renderLandingFooter = (config: Record<string, string>) => {
  const logo = config.landing_logo || config.company_logo;
  const name = escapeHtml(config.company_name || "PIXKEY3D");
  const wa = waHref(config);
  const phone = normalizeWhatsappNumber(config.quote_whatsapp_number || "");
  const displayPhone = phone ? `+${phone}` : "";
  const year = new Date().getFullYear();
  return `
<footer class="ln-footer" role="contentinfo">
  <div class="ln-footer-inner">
    <div class="ln-footer-brand">
      <div class="ln-footer-brand-name">
        ${logo ? `<img src="${escapeHtml(optimizedImageSrc(logo, 400))}" alt="" width="24" height="24">` : ""}
        ${name}
      </div>
      <p class="ln-footer-tagline">Fabricación digital de precisión.<br>San Luis Potosí, México.</p>
      <p class="ln-footer-copy">© ${year} ${name}. Todos los derechos reservados.</p>
    </div>
    <div class="ln-footer-col">
      <p class="ln-footer-col-title">Catálogo</p>
      <a href="/catalogo">Ver catálogo</a>
      <a href="#precios">Precios por volumen</a>
      <a href="#catalogo">Productos destacados</a>
    </div>
    <div class="ln-footer-col">
      <p class="ln-footer-col-title">Contacto</p>
      ${displayPhone ? `<a href="${escapeHtml(wa)}" target="_blank" rel="noopener">${msi("phone", "msi")} ${escapeHtml(displayPhone)}</a>` : ""}
      <a href="#ubicacion">${msi("location_on", "msi")} San Luis Potosí, SLP</a>
      <a href="#proceso">${msi("schedule", "msi")} Lun–Sáb 9–18h</a>
    </div>
    <div class="ln-footer-col">
      <p class="ln-footer-col-title">Legal</p>
      <a href="/aviso-privacidad">Aviso de privacidad</a>
      <a href="/terminos">Términos y condiciones</a>
    </div>
  </div>
</footer>`;
};

const renderLanding = (origin: string) => {
  const config = getConfig();
  const defaultPriceTiers = getDefaultPriceTiers();
  const featured = getFeaturedProducts().map((product) => ({
    product,
    priceTiers: product.use_default_pricing ? defaultPriceTiers : getProductPriceTiers(product.id),
  }));
  const seoProducts = toSeoProducts(featured);

  const content = `
    ${renderLandingNav(config)}
    <main class="ln-main">
      ${renderLandingHero(config)}
      ${renderLandingPricing(config, defaultPriceTiers)}
      ${featured.length > 0 ? renderLandingFeatured(config, featured) : ""}
      ${renderLandingProcess(config)}
      ${renderLandingLocation(config)}
      ${renderLandingFaq(config)}
      ${renderLandingCtaBanner(config)}
    </main>
    ${renderLandingFooter(config)}
    ${adminGateScript()}
  `;
  const seo = {
    headMeta: buildHeadMeta({ pageType: "landing", config, origin, path: "/", products: seoProducts }),
    jsonLd: buildJsonLd({ pageType: "landing", config, origin, path: "/", products: seoProducts }),
  };
  // ponytail: icon_names subsetea Material Symbols (~5KB vs 3.8MB); agregar aquí cada icono nuevo que use la landing
  const montserratCss = "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap";
  const iconsCss = "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&icon_names=chat,dark_mode,info,inventory_2,local_shipping,location_on,map,open_in_new,phone,schedule&display=block";
  const extraHead = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${montserratCss}" rel="stylesheet" media="print" onload="this.media='all'"><link href="${iconsCss}" rel="stylesheet" media="print" onload="this.media='all'"><noscript><link href="${montserratCss}" rel="stylesheet"><link href="${iconsCss}" rel="stylesheet"></noscript>`;
  return Layout(config.company_name || "PIXKEY3D", content, config, seo, config.landing_hero_image || config.company_logo || undefined, extraHead);
};

const renderPrintableCatalog = (showActions: boolean) => {
  const { config, defaultPriceTiers, productsWithTiers, categories, subcategories } = getCatalogData();
  const content = `
    ${showActions ? `<div class="action-bar no-print">
        <button onclick="window.print()" class="theme-button" type="button">Imprimir / PDF</button>
        <a href="/admin" class="admin-link">Admin</a>
    </div>` : ""}
    ${renderCoverSection(config)}
    ${renderWelcomeSection(config, defaultPriceTiers)}
    ${renderProductsSection(config, productsWithTiers, categories, subcategories)}
    ${renderContactSection(config)}
  `;
  return Layout(`${config.company_name || "PIXKEY3D"} - Catálogo imprimible`, content, config);
};

const renderShopScript = (products: Array<{
  id: number;
  name: string;
  priceTiers: Array<{ min_volume: number; max_volume: number | null; price: number; delivery_time: string }>;
}>, whatsappNumber: string, shippingSettings: ReturnType<typeof getShippingSettings>) => `
<script>
(() => {
  const products = ${safeJson(products)};
  const whatsappNumber = ${safeJson(whatsappNumber)};
  const shippingSettings = ${safeJson(shippingSettings)};
  const productMap = new Map(products.map((product) => [String(product.id), product]));
  const cart = new Map();
  let customer = null;

  const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const escapeClientHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char] || char));
  const cartLines = document.getElementById('cart-lines');
  const cartEmpty = document.getElementById('cart-empty');
  const totalPiecesEl = document.getElementById('cart-total-pieces');
  const subtotalAmountEl = document.getElementById('cart-subtotal-amount');
  const shippingLabelEl = document.getElementById('cart-shipping-label');
  const shippingAmountEl = document.getElementById('cart-shipping-amount');
  const totalAmountEl = document.getElementById('cart-total-amount');
  const ivaRowEl = document.getElementById('iva-row');
  const ivaAmountEl = document.getElementById('cart-iva-amount');
  const grandLabelEl = document.getElementById('cart-grand-label');
  const invoiceCheckbox = document.getElementById('requires-invoice');
  const quoteStatus = document.getElementById('quote-status');
  const quoteButton = document.getElementById('quote-button');
  const clearButton = document.getElementById('clear-cart');
  const modal = document.getElementById('customer-modal');
  const customerForm = document.getElementById('customer-form');
  const cancelCustomer = document.getElementById('cancel-customer');

  const tierForQuantity = (tiers, totalPieces) => {
    const sorted = [...(tiers || [])].sort((a, b) => a.min_volume - b.min_volume);
    if (sorted.length === 0) return null;
    return sorted.find((tier) => totalPieces >= tier.min_volume && (!tier.max_volume || totalPieces <= tier.max_volume)) || sorted[0];
  };

  const shippingCostForPieces = (totalPieces) => {
    const threshold = Number(shippingSettings.freeMinPieces || 0);
    const price = Math.max(0, Number(shippingSettings.price || 0));
    return threshold > 0 && totalPieces >= threshold ? 0 : price;
  };

  const cartTotalPieces = () => Array.from(cart.values()).reduce((total, item) => total + item.quantity, 0);
  const cartDetails = () => {
    const totalPieces = cartTotalPieces();
    const lines = Array.from(cart.values()).map((item) => {
      const tier = tierForQuantity(item.product.priceTiers, totalPieces);
      const unitPrice = tier ? Number(tier.price) : 0;
      return { ...item, tier, unitPrice, subtotal: unitPrice * item.quantity };
    });
    const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
    const shippingCost = lines.length ? shippingCostForPieces(totalPieces) : 0;
    const hasMissingPrice = lines.some((line) => !line.tier);
    const needsInvoice = invoiceCheckbox instanceof HTMLInputElement && invoiceCheckbox.checked;
    const iva = needsInvoice ? Math.round(subtotal * 0.16 * 100) / 100 : 0;
    return { totalPieces, lines, subtotal, iva, needsInvoice, shippingCost, grandTotal: subtotal + iva + shippingCost, hasMissingPrice };
  };

  const renderCart = () => {
    const details = cartDetails();
    if (cartEmpty) cartEmpty.style.display = details.lines.length ? 'none' : 'block';
    if (quoteButton instanceof HTMLButtonElement) quoteButton.disabled = details.lines.length === 0;
    if (quoteStatus) quoteStatus.textContent = 'Antes de abrir WhatsApp te pediremos nombre y código postal.';
    if (totalPiecesEl) totalPiecesEl.textContent = String(details.totalPieces);
    if (subtotalAmountEl) subtotalAmountEl.textContent = details.hasMissingPrice ? 'A cotizar' : currency.format(details.subtotal);
    if (shippingLabelEl) shippingLabelEl.textContent = 'Envío estimado (' + (shippingSettings.provider || 'Estafeta') + ')';
    if (ivaRowEl) ivaRowEl.style.display = details.needsInvoice ? 'flex' : 'none';
    if (ivaAmountEl) ivaAmountEl.textContent = details.hasMissingPrice ? 'A cotizar' : currency.format(details.iva);
    if (grandLabelEl) grandLabelEl.textContent = details.needsInvoice ? 'Total estimado con IVA y envío' : 'Total estimado con envío';
    if (shippingAmountEl) shippingAmountEl.textContent = details.lines.length ? (details.shippingCost > 0 ? currency.format(details.shippingCost) : 'Gratis') : '$0.00';
    if (totalAmountEl) totalAmountEl.textContent = details.hasMissingPrice ? 'A cotizar' : currency.format(details.grandTotal);
    if (!cartLines) return;
    cartLines.innerHTML = details.lines.map((line) => {
      const tierText = line.tier ? (line.tier.min_volume + (line.tier.max_volume ? ' a ' + line.tier.max_volume : ' o más') + ' piezas') : 'Sin tabla';
      const subtotal = line.unitPrice ? currency.format(line.subtotal) : 'A cotizar';
      const unit = line.unitPrice ? currency.format(line.unitPrice) : 'A cotizar';
      return '<div class="cart-line">'
        + '<div><p class="cart-line-title">' + escapeClientHtml(line.product.name) + '</p>'
        + '<p class="cart-line-meta">' + line.quantity + ' piezas · ' + unit + ' c/u · rango ' + tierText + ' · subtotal ' + subtotal + '</p></div>'
        + '<div class="cart-line-actions"><input type="number" min="1" step="1" value="' + line.quantity + '" data-cart-qty="' + line.product.id + '">'
        + '<button type="button" class="remove-cart-item" data-remove-cart="' + line.product.id + '">Quitar</button></div>'
        + '</div>';
    }).join('');
  };

  const quoteMessage = () => {
    const details = cartDetails();
    const lines = details.lines.map((line, index) => {
      const unit = line.unitPrice ? currency.format(line.unitPrice) : 'A cotizar';
      const subtotal = line.unitPrice ? currency.format(line.subtotal) : 'A cotizar';
      const delivery = line.tier?.delivery_time ? ' · Entrega: ' + line.tier.delivery_time : '';
      return (index + 1) + '. ' + line.product.name + ' - ' + line.quantity + ' piezas - ' + unit + ' c/u - ' + subtotal + delivery;
    }).join('\\n');
    const ivaLine = details.needsInvoice ? 'IVA (16%): ' + (details.hasMissingPrice ? 'A cotizar' : currency.format(details.iva)) + '\\n' : '';
    return 'Hola PIXKEY3D, quiero cotizar este pedido:\\n\\n'
      + 'Nombre: ' + customer.name + '\\n'
      + 'Código postal: ' + customer.postalCode + '\\n'
      + (details.needsInvoice ? 'Requiere factura: Sí\\n' : '')
      + '\\nProductos:\\n' + lines + '\\n\\n'
      + 'Total de piezas: ' + details.totalPieces + '\\n'
      + 'Subtotal estimado: ' + (details.hasMissingPrice ? 'A cotizar' : currency.format(details.subtotal)) + '\\n'
      + ivaLine
      + 'Envío estimado (' + (shippingSettings.provider || 'Estafeta') + '): ' + (details.shippingCost > 0 ? currency.format(details.shippingCost) : 'Gratis') + '\\n'
      + 'Total estimado: ' + (details.hasMissingPrice ? 'A cotizar' : currency.format(details.grandTotal)) + '\\n\\n'
      + 'Quedo pendiente de la cotización final con envío.';
  };

  if (invoiceCheckbox) invoiceCheckbox.addEventListener('change', renderCart);

  const saveQuote = async () => {
    const details = cartDetails();
    const response = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerName: customer.name,
        postalCode: customer.postalCode,
        requiresInvoice: details.needsInvoice,
        items: details.lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No se pudo guardar la cotización.');
    return payload;
  };

  const openWhatsapp = (message, targetWindow) => {
    const url = 'https://wa.me/' + whatsappNumber + '?text=' + encodeURIComponent(message);
    if (targetWindow && !targetWindow.closed) {
      targetWindow.location.href = url;
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openQuote = async () => {
    if (cart.size === 0 || !customer) return;
    const fallbackMessage = quoteMessage();
    const whatsappWindow = window.open('', '_blank');
    if (whatsappWindow) whatsappWindow.document.write('<p>Preparando WhatsApp...</p>');
    const previousText = quoteButton instanceof HTMLButtonElement ? quoteButton.textContent : '';
    if (quoteButton instanceof HTMLButtonElement) {
      quoteButton.disabled = true;
      quoteButton.textContent = 'Guardando...';
    }
    if (quoteStatus) quoteStatus.textContent = 'Guardando cotización antes de abrir WhatsApp...';
    try {
      const payload = await saveQuote();
      if (quoteStatus) quoteStatus.textContent = payload.id ? 'Cotización guardada con folio #' + payload.id + '.' : 'Cotización guardada.';
      openWhatsapp(payload.message || fallbackMessage, whatsappWindow);
    } catch (error) {
      console.error('[quote] save failed', error);
      if (quoteStatus) quoteStatus.textContent = 'No se pudo guardar la cotización, pero se abrirá WhatsApp con el detalle.';
      openWhatsapp(fallbackMessage, whatsappWindow);
    } finally {
      if (quoteButton instanceof HTMLButtonElement) {
        quoteButton.disabled = cart.size === 0;
        quoteButton.textContent = previousText || 'Cotizar por WhatsApp';
      }
    }
  };

  document.addEventListener('click', (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const addButton = target?.closest('[data-add-to-cart]');
    if (addButton instanceof HTMLElement) {
      const id = String(addButton.dataset.addToCart || '');
      const product = productMap.get(id);
      const input = document.querySelector('[data-quantity-for="' + id + '"]');
      const quantity = Math.max(1, Number.parseInt(input instanceof HTMLInputElement ? input.value : '1', 10) || 1);
      if (!product) return;
      const existing = cart.get(id);
      cart.set(id, { product, quantity: (existing?.quantity || 0) + quantity });
      renderCart();
      document.getElementById('cotizacion')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const removeButton = target?.closest('[data-remove-cart]');
    if (removeButton instanceof HTMLElement) {
      cart.delete(String(removeButton.dataset.removeCart || ''));
      renderCart();
      return;
    }

    if (target?.id === 'clear-cart') {
      cart.clear();
      customer = null;
      renderCart();
      return;
    }

    if (target?.id === 'quote-button') {
      if (cart.size === 0) return;
      if (!customer) {
        modal?.classList.add('open');
        setTimeout(() => document.getElementById('customer-name')?.focus(), 0);
        return;
      }
      void openQuote();
      return;
    }

    if (target?.id === 'cancel-customer') {
      modal?.classList.remove('open');
    }
  });

  document.addEventListener('input', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (!input?.dataset.cartQty) return;
    const id = String(input.dataset.cartQty);
    const item = cart.get(id);
    if (!item) return;
    item.quantity = Math.max(1, Number.parseInt(input.value, 10) || 1);
    cart.set(id, item);
    renderCart();
  });

  customerForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const nameInput = document.getElementById('customer-name');
    const postalInput = document.getElementById('customer-postal-code');
    const name = nameInput instanceof HTMLInputElement ? nameInput.value.trim() : '';
    const postalCode = postalInput instanceof HTMLInputElement ? postalInput.value.trim() : '';
    if (!name || !postalCode) return;
    customer = { name, postalCode };
    modal?.classList.remove('open');
    void openQuote();
  });

  renderCart();
})();
</script>
`;

const renderCartSection = (config: Record<string, string>, productsWithTiers: ReturnType<typeof getCatalogData>["productsWithTiers"]) => {
  const products = productsWithTiers.map(({ product, priceTiers }) => ({
    id: product.id,
    name: product.name,
    priceTiers: priceTiers.map((tier) => ({
      min_volume: tier.min_volume,
      max_volume: tier.max_volume,
      price: tier.price,
      delivery_time: tier.delivery_time,
    })),
  }));
  const whatsappNumber = normalizeWhatsappNumber(config.quote_whatsapp_number || "4961266304");
  const shippingSettings = getShippingSettings(config);
  const shippingNote = shippingSettings.freeMinPieces
    ? `Envío estimado por ${shippingSettings.provider}: $${shippingSettings.price.toFixed(2)} MXN. Gratis desde ${shippingSettings.freeMinPieces} piezas.`
    : `Envío estimado por ${shippingSettings.provider}: $${shippingSettings.price.toFixed(2)} MXN.`;

  return `
    <section class="quote-cart" id="cotizacion">
      <div class="cart-panel">
        <div class="cart-header">
          <div>
            <h2>Carrito de cotización</h2>
            <p class="quote-note">Agrega productos y cantidades. Los precios se recalculan con el volumen total de piezas. ${escapeHtml(shippingNote)}</p>
          </div>
          <button type="button" class="secondary-button" id="clear-cart">Vaciar</button>
        </div>
        <div id="cart-empty" class="cart-empty">Tu carrito está vacío. Agrega productos para cotizar.</div>
        <div id="cart-lines" class="cart-lines"></div>
        <div class="cart-totals">
          <div class="cart-total-row" style="margin-bottom:.5rem">
            <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;font-size:.9rem">
              <input type="checkbox" id="requires-invoice"> ¿Requiere factura?
            </label>
          </div>
          <div class="cart-total-row"><span>Total de piezas</span><strong id="cart-total-pieces">0</strong></div>
          <div class="cart-total-row"><span>Subtotal estimado</span><strong id="cart-subtotal-amount">$0.00</strong></div>
          <div class="cart-total-row" id="iva-row" style="display:none"><span>IVA (16%)</span><strong id="cart-iva-amount">$0.00</strong></div>
          <div class="cart-total-row"><span id="cart-shipping-label">Envío estimado (${escapeHtml(shippingSettings.provider)})</span><strong id="cart-shipping-amount">$0.00</strong></div>
          <div class="cart-total-row"><span id="cart-grand-label">Total estimado con envío</span><strong id="cart-total-amount">$0.00</strong></div>
        </div>
        <div class="quote-actions">
          <p class="quote-note" id="quote-status" aria-live="polite">Antes de abrir WhatsApp te pediremos nombre y código postal.</p>
          <button type="button" class="quote-button" id="quote-button" disabled>Cotizar por WhatsApp</button>
        </div>
      </div>
    </section>
    <div class="customer-modal" id="customer-modal" aria-hidden="true">
      <form class="modal-card" id="customer-form">
        <h2>Datos para cotizar</h2>
        <p class="quote-note">Necesitamos estos datos antes de enviar tu solicitud por WhatsApp.</p>
        <label for="customer-name">Nombre</label>
        <input id="customer-name" name="customer_name" type="text" autocomplete="name" required>
        <label for="customer-postal-code">Código postal</label>
        <input id="customer-postal-code" name="postal_code" type="text" inputmode="numeric" autocomplete="postal-code" required>
        <div class="modal-actions">
          <button type="button" class="secondary-button" id="cancel-customer">Cancelar</button>
          <button type="submit" class="quote-button">Continuar a WhatsApp</button>
        </div>
      </form>
    </div>
    ${renderShopScript(products, whatsappNumber, shippingSettings)}
  `;
};

const renderInteractiveCatalog = (origin: string) => {
  const { config, defaultPriceTiers, productsWithTiers, categories, subcategories } = getCatalogData();
  const content = `
    ${renderCoverSection(config)}
    ${renderWelcomeSection(config, defaultPriceTiers)}
    ${renderProductsSection(config, productsWithTiers, categories, subcategories, true)}
    ${renderCartSection(config, productsWithTiers)}
    ${renderContactSection(config)}
  `;
  const seoProducts = toSeoProducts(productsWithTiers);
  const seo = {
    headMeta: buildHeadMeta({ pageType: "catalog", config, origin, path: "/catalogo", products: seoProducts }),
    jsonLd: buildJsonLd({ pageType: "catalog", config, origin, path: "/catalogo", products: seoProducts }),
  };
  return Layout(`${config.company_name || "PIXKEY3D"} - Catálogo`, content, config, seo, config.company_logo || undefined);
};

// El landing es ahora la homepage en "/". El catálogo se conserva en "/catalogo".
publicRoutes.get("/", (c) => c.html(renderLanding(resolveOrigin(c, getConfig()))));
publicRoutes.get("/robots.txt", (c) => {
  const origin = resolveOrigin(c, getConfig());
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /imprimir",
    "",
    "# Bots de IA — acceso permitido para indexación y citabilidad",
    "User-agent: GPTBot",
    "Allow: /",
    "",
    "User-agent: OAI-SearchBot",
    "Allow: /",
    "",
    "User-agent: ClaudeBot",
    "Allow: /",
    "",
    "User-agent: PerplexityBot",
    "Allow: /",
    "",
    "User-agent: CCBot",
    "Allow: /",
    "",
    "User-agent: anthropic-ai",
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  return c.body(body, 200, { "content-type": "text/plain; charset=utf-8" });
});
publicRoutes.get("/sitemap.xml", (c) => {
  const origin = resolveOrigin(c, getConfig());
  const lastmod = new Date().toISOString().slice(0, 10);
  // Solo URLs reales del sitio. Punto de extensión: agregar páginas de producto
  // aquí cuando existan rutas de detalle por producto.
  const urls = [
    { loc: `${origin}/`, priority: "1.0" },
    { loc: `${origin}/catalogo`, priority: "0.8" },
    { loc: `${origin}/aviso-privacidad`, priority: "0.3" },
    { loc: `${origin}/terminos`, priority: "0.3" },
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escXml(u.loc)}</loc><lastmod>${lastmod}</lastmod><priority>${u.priority}</priority></url>`)
    .join("\n")}\n</urlset>\n`;
  return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8" });
});

publicRoutes.get("/llms.txt", (c) => {
  const config = getConfig();
  const name = config.company_name || "PIXKEY3D";
  const origin = resolveOrigin(c, config);
  const shipping = getShippingSettings(config);
  const tiers = getDefaultPriceTiers().sort((a, b) => a.min_volume - b.min_volume);
  const tiersText = tiers.map((t) =>
    `  - ${formatVolume(t.min_volume, t.max_volume)}: ${t.max_volume === null ? "precio negociable" : `${currency.format(Number(t.price))} MXN`}${t.delivery_time ? ` (${t.delivery_time})` : ""}`
  ).join("\n");
  const body = `# ${name}

> Fabricación de llaveros y figuras 3D personalizados en San Luis Potosí, México.
> Producción bajo pedido con tecnología de impresión 3D de alta precisión.
> Precios especiales por volumen para revendedores, empresas y mayoristas.

## Productos

- Llaveros 3D personalizados (kawasaki, PS5, deportes, bandas, temáticos)
- Figuras 3D impresas (Dragon Ball, Marvel, Invincible, articuladas)
- Motores articulados funcionales
- Diseños personalizados a solicitud (formatos STL, OBJ)

## Precios por volumen

Pedido mínimo: 25 piezas.

${tiersText || "  - Consultar cotización directa"}

## Envíos

- Proveedor: ${shipping.provider}
- Costo estándar: ${currency.format(shipping.price)} MXN${shipping.freeMinPieces ? `\n- Envío gratuito en pedidos de ${shipping.freeMinPieces} piezas o más` : ""}
- Cobertura: toda la república mexicana
- Tiempo de tránsito: 1 a 3 días hábiles adicionales

## Ubicación

San Luis Potosí, S.L.P., México
Lunes a Sábado, 9:00 a 18:00 hrs
Recolección en persona disponible para clientes locales.

## Enlaces

- [Página principal](${origin}/): información general, precios por volumen y proceso de pedido
- [Catálogo de productos](${origin}/catalogo): catálogo completo con fotos y precios
- [Aviso de privacidad](${origin}/aviso-privacidad)
- [Términos y condiciones](${origin}/terminos)

## Contacto

- [WhatsApp](https://wa.me/${normalizeWhatsappNumber(config.quote_whatsapp_number || "4961266304")})
- Email: contacto@${new URL(origin).hostname}
- [Web](${origin})

## Materiales

PLA de alta calidad (estándar), PETG (piezas que requieren mayor flexibilidad).

## Proceso de pedido

1. El cliente elige productos del catálogo o comparte un diseño personalizado.
2. Se solicita cotización por WhatsApp con cantidad y modelo.
3. Se confirma producción y tiempo de entrega en menos de 24 hrs.
4. Producción y envío o recolección local al finalizar.
`;
  return c.body(body, 200, { "content-type": "text/plain; charset=utf-8" });
});

const legalPageShell = (title: string, body: string) => `
<div class="page-section welcome-section">
  <div class="page-shell" style="max-width:800px;">
    <h1 style="font-size:clamp(1.8rem,4vw,2.8rem);margin:0 0 2rem;">${title}</h1>
    ${body}
    <p style="margin-top:2rem;"><a href="/" style="color:var(--brand-primary);">← Volver al inicio</a></p>
  </div>
</div>`;

const defaultAviso = (name: string, wa: string, hostname: string, date: string) => `
    <p class="theme-copy">De conformidad con lo establecido en la <strong>Ley Federal de Protección de Datos Personales en Posesión de los Particulares</strong> (LFPDPPP) y su Reglamento, <strong>${name}</strong>, con domicilio en San Luis Potosí, S.L.P., México, en adelante <strong>"el Responsable"</strong>, pone a su disposición el presente Aviso de Privacidad.</p>
    <h2 style="margin:2rem 0 1rem;">Datos personales recabados</h2>
    <p class="theme-copy">Para llevar a cabo las finalidades descritas en el presente aviso, podemos recabar los siguientes datos personales:</p>
    <ul style="margin:0 0 1rem;padding-left:1.5rem;color:var(--body-text);">
      <li>Nombre completo</li>
      <li>Código postal</li>
      <li>Número de teléfono o WhatsApp (cuando se contacta voluntariamente)</li>
      <li>Correo electrónico (cuando se contacta voluntariamente)</li>
    </ul>
    <h2 style="margin:2rem 0 1rem;">Finalidades del tratamiento</h2>
    <p class="theme-copy">Los datos personales que recabamos serán utilizados para las siguientes <strong>finalidades primarias y necesarias</strong>:</p>
    <ul style="margin:0 0 1rem;padding-left:1.5rem;color:var(--body-text);">
      <li>Generar y procesar cotizaciones de productos.</li>
      <li>Coordinar la entrega o recolección de pedidos.</li>
      <li>Comunicar el estado de su pedido.</li>
    </ul>
    <h2 style="margin:2rem 0 1rem;">Transferencia de datos</h2>
    <p class="theme-copy">Sus datos personales <strong>no serán transferidos</strong> a terceros sin su consentimiento previo, salvo en los casos previstos en el artículo 37 de la LFPDPPP.</p>
    <h2 style="margin:2rem 0 1rem;">Derechos ARCO</h2>
    <p class="theme-copy">Usted tiene derecho a <strong>Acceder, Rectificar, Cancelar u Oponerse</strong> (derechos ARCO) al tratamiento de sus datos personales. Para ejercer estos derechos puede contactarnos:</p>
    <ul style="margin:0 0 1rem;padding-left:1.5rem;color:var(--body-text);">
      <li>WhatsApp: <a href="https://wa.me/${wa}" style="color:var(--brand-primary);">+${wa}</a></li>
      <li>Correo: contacto@${hostname}</li>
    </ul>
    <h2 style="margin:2rem 0 1rem;">Cambios al aviso</h2>
    <p class="theme-copy">Nos reservamos el derecho de actualizar este aviso en cualquier momento. Los cambios se publicarán en esta página.</p>
    <p class="theme-copy" style="margin-top:2rem;opacity:.65;font-size:.9rem;">Última actualización: ${date}</p>`;

const defaultTerminos = (name: string, provider: string, date: string) => `
    <p class="theme-copy">Al realizar un pedido o cotización con <strong>${name}</strong>, ubicados en San Luis Potosí, S.L.P., México, usted acepta los siguientes términos y condiciones.</p>
    <h2 style="margin:2rem 0 1rem;">1. Pedidos y cotizaciones</h2>
    <p class="theme-copy">Todos los pedidos se procesan mediante cotización previa. El pedido mínimo es de 25 piezas. Los precios están sujetos a cambios sin previo aviso hasta confirmar la cotización por escrito. La cotización tiene vigencia de 7 días naturales.</p>
    <h2 style="margin:2rem 0 1rem;">2. Producción y entrega</h2>
    <p class="theme-copy">Los tiempos de producción son estimados y pueden variar según el volumen y la complejidad del diseño. ${name} no se responsabiliza por retrasos del transportista una vez entregado el paquete a la paquetería. El tránsito depende del destino dentro de la república mexicana.</p>
    <h2 style="margin:2rem 0 1rem;">3. Diseños personalizados</h2>
    <p class="theme-copy">El cliente es responsable de contar con los derechos sobre los diseños o imágenes que solicite imprimir. ${name} no asume responsabilidad por diseños que infrinjan derechos de terceros. Los archivos del cliente no serán compartidos con terceros.</p>
    <h2 style="margin:2rem 0 1rem;">4. Pagos</h2>
    <p class="theme-copy">Se requiere pago anticipado del 50% para iniciar la producción y el saldo restante antes del envío, salvo acuerdo distinto por escrito. Aceptamos transferencia bancaria (SPEI), depósito en OXXO y efectivo para clientes locales en San Luis Potosí.</p>
    <h2 style="margin:2rem 0 1rem;">5. Devoluciones y garantías</h2>
    <p class="theme-copy">Si el producto presenta defectos de fabricación imputables a ${name}, se procederá a la reposición de las piezas afectadas sin costo adicional. El cliente debe reportar cualquier defecto dentro de los 5 días hábiles posteriores a la recepción del pedido, adjuntando fotografías. No se aceptan devoluciones por error en las especificaciones proporcionadas por el cliente.</p>
    <h2 style="margin:2rem 0 1rem;">6. Modificaciones</h2>
    <p class="theme-copy">${name} se reserva el derecho de modificar estos términos en cualquier momento. Los cambios entrarán en vigor al publicarse en esta página.</p>
    <p class="theme-copy" style="margin-top:2rem;opacity:.65;font-size:.9rem;">Última actualización: ${date}</p>`;

publicRoutes.get("/aviso-privacidad", (c) => {
  const config = getConfig();
  const origin = resolveOrigin(c, config);
  const name = escapeHtml(config.company_name || "PIXKEY3D");
  const date = new Date().toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
  const wa = (config.quote_whatsapp_number || "").replace(/\D/g, "").padStart(12, "52");
  const body = cleanText(config.aviso_privacidad_content)
    ? renderAdminHtml(config.aviso_privacidad_content)
    : defaultAviso(name, wa, new URL(origin).hostname, date);
  return c.html(Layout("Aviso de Privacidad", legalPageShell("Aviso de Privacidad", body), config));
});

publicRoutes.get("/terminos", (c) => {
  const config = getConfig();
  const name = escapeHtml(config.company_name || "PIXKEY3D");
  const date = new Date().toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
  const provider = escapeHtml(getShippingSettings(config).provider);
  const body = cleanText(config.terminos_content)
    ? renderAdminHtml(config.terminos_content)
    : defaultTerminos(name, provider, date);
  return c.html(Layout("Términos y Condiciones", legalPageShell("Términos y Condiciones", body), config));
});

publicRoutes.post("/api/quotes", async (c) => {
  try {
    if (quoteRateLimited(quoteClientIp(c))) {
      return c.json({ error: "Demasiadas solicitudes. Intenta de nuevo en unos minutos." }, 429);
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const customerName = String(body.customerName ?? body.customer_name ?? "").trim().slice(0, 200);
    const postalCode = String(body.postalCode ?? body.postal_code ?? "").trim().slice(0, 10);
    const requiresInvoice = Boolean(body.requiresInvoice ?? body.requires_invoice ?? false);
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 200) : [];

    if (!customerName || !postalCode) {
      return c.json({ error: "Nombre y código postal son obligatorios." }, 400);
    }
    if (!/^\d{4,5}$/.test(postalCode)) {
      return c.json({ error: "Código postal inválido." }, 400);
    }
    if (rawItems.length === 0) {
      return c.json({ error: "Agrega al menos un producto para cotizar." }, 400);
    }

    const { config, productsWithTiers } = getCatalogData();
    const productMap = new Map(productsWithTiers.map((entry) => [entry.product.id, entry]));
    const selected = new Map<number, { product: typeof productsWithTiers[number]["product"], priceTiers: typeof productsWithTiers[number]["priceTiers"], quantity: number }>();

    for (const rawItem of rawItems) {
      const item = rawItem as Record<string, unknown>;
      const productId = Number.parseInt(String(item.productId ?? item.product_id ?? item.id ?? ""), 10);
      const quantity = Math.min(100000, Math.max(1, Number.parseInt(String(item.quantity ?? "1"), 10) || 1));
      const productEntry = productMap.get(productId);
      if (!productEntry) continue;
      const existing = selected.get(productId);
      selected.set(productId, { ...productEntry, quantity: (existing?.quantity || 0) + quantity });
    }

    const totalPieces = Array.from(selected.values()).reduce((total, item) => total + item.quantity, 0);
    if (totalPieces <= 0) {
      return c.json({ error: "No se encontraron productos válidos para cotizar." }, 400);
    }

    const lines: QuoteLine[] = Array.from(selected.values()).map(({ product, priceTiers, quantity }) => {
      const tier = tierForQuantity(priceTiers, totalPieces);
      const unitPrice = tier ? Number(tier.price) : 0;
      return {
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice,
        subtotal: unitPrice * quantity,
        tier: tier ? { min_volume: tier.min_volume, max_volume: tier.max_volume, delivery_time: tier.delivery_time } : null,
      };
    });

    const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
    const iva = requiresInvoice ? Math.round(subtotal * 0.16 * 100) / 100 : 0;
    const shipping = shippingForPieces(config, totalPieces);
    const grandTotal = subtotal + iva + shipping.cost;
    const whatsappNumber = normalizeWhatsappNumber(config.quote_whatsapp_number || "4961266304");
    const messageWithoutFolio = buildQuoteMessage({
      customerName,
      postalCode,
      requiresInvoice,
      totalPieces,
      lines,
      subtotal,
      iva,
      shippingProvider: shipping.provider,
      shippingCost: shipping.cost,
      grandTotal,
    });

    const quoteId = createQuote({
      customer_name: customerName,
      postal_code: postalCode,
      total_pieces: totalPieces,
      subtotal,
      shipping_provider: shipping.provider,
      shipping_cost: shipping.cost,
      shipping_free_threshold: shipping.freeMinPieces,
      grand_total: grandTotal,
      whatsapp_number: whatsappNumber,
      message: messageWithoutFolio,
      items: lines.map((line) => ({
        product_id: line.productId,
        product_name: line.productName,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        subtotal: line.subtotal,
        pricing_min_volume: line.tier?.min_volume ?? null,
        pricing_max_volume: line.tier?.max_volume ?? null,
        delivery_time: line.tier?.delivery_time ?? null,
      })),
    });

    const message = buildQuoteMessage({
      quoteId,
      customerName,
      postalCode,
      requiresInvoice,
      totalPieces,
      lines,
      subtotal,
      iva,
      shippingProvider: shipping.provider,
      shippingCost: shipping.cost,
      grandTotal,
    });
    updateQuoteMessage(quoteId, message);

    // Aviso push al admin. Fire-and-forget: nunca debe bloquear ni romper la
    // respuesta al cliente que cotiza.
    sendPushToAll({
      title: `Nueva cotización #${quoteId}`,
      body: `${customerName} · ${totalPieces} pza(s) · ${currency.format(grandTotal)}`,
      url: "/admin/quotes",
      tag: `quote-${quoteId}`,
    }).catch((e) => console.warn("[push] quote notify failed", e));

    return c.json({
      id: quoteId,
      message,
      totals: {
        totalPieces,
        subtotal,
        shippingProvider: shipping.provider,
        shippingCost: shipping.cost,
        freeShippingMinPieces: shipping.freeMinPieces,
        grandTotal,
      },
    });
  } catch (error) {
    console.error("[quotes] save failed", error);
    return c.json({ error: "No se pudo guardar la cotización." }, 500);
  }
});
publicRoutes.get("/catalogo", (c) => c.html(renderInteractiveCatalog(resolveOrigin(c, getConfig()))));
publicRoutes.get("/imprimir", (c) => c.html(renderPrintableCatalog(c.req.query("embed") !== "1")));

// ── PWA: assets en scope raíz ────────────────────────────────────────────
publicRoutes.get("/manifest.webmanifest", (c) =>
  c.body(JSON.stringify(buildManifest(getConfig())), 200, { "content-type": "application/manifest+json; charset=utf-8" })
);
publicRoutes.get("/sw.js", (c) =>
  c.body(serviceWorkerJs(), 200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-cache",
    "service-worker-allowed": "/",
  })
);
publicRoutes.get("/icons/app-icon.svg", async (c) =>
  // no-cache para que al cambiar el logo el ícono se actualice de inmediato
  // (antes max-age=3600 lo dejaba "pegado" hasta una hora en el navegador).
  c.body(await renderAppIconSvg(getConfig()), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-cache" })
);

export { publicRoutes };
