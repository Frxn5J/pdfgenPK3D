import { Hono } from "hono";
import { createQuote, getConfig, getProducts, getFeaturedProducts, getDefaultPriceTiers, getProductPriceTiers, updateQuoteMessage, getCategories, getSubcategories, type Category, type Subcategory, type Product } from "../db/schema";
import { buildManifest, serviceWorkerJs, renderAppIconSvg, pwaHeadTags, pwaRegisterScript, sendPushToAll } from "../pwa";
import { imgTag } from "../lib/html";
import { cleanText } from "../lib/text";
import { buildHeadMeta, buildJsonLd, resolveOrigin, escXml, type SeoProduct } from "../lib/seo";

const publicRoutes = new Hono();
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

    /* ── Landing page ── */
    .landing-hero { min-height: 78vh; display: grid; place-items: center; background: var(--cover-bg); color: var(--cover-text); text-align: center; }
    .landing-hero-shell { display: grid; gap: 1.25rem; justify-items: center; }
    .landing-hero-image { display: block; width: min(240px, 60vw); max-height: 200px; object-fit: contain; margin: 0 auto; }
    .landing-hero h1 { color: var(--cover-text); font-size: clamp(2.4rem, 7vw, 4.5rem); letter-spacing: -.05em; margin: .5rem 0 0; }
    .landing-hero-subtitle { color: var(--cover-text); opacity: .82; font-size: clamp(1.05rem, 2.4vw, 1.4rem); max-width: 46ch; margin: 0 auto; }
    .landing-hero-cta { margin-top: .75rem; padding: .9rem 2rem; font-size: 1.05rem; }
    .landing-benefits { background: var(--welcome-bg); }
    .landing-benefits-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--product-gap); }
    .landing-benefit-card { padding: var(--card-padding); text-align: center; }
    .landing-benefit-icon { font-size: 2.5rem; line-height: 1; margin-bottom: .75rem; }
    .landing-benefit-card h3 { margin: 0 0 .5rem; font-size: 1.25rem; }
    .landing-benefit-card p { margin: 0; color: var(--muted-text); }
    .landing-featured { background: var(--products-bg); }
    .landing-featured-card { display: block; text-decoration: none; color: inherit; }
    .landing-about { background: var(--welcome-bg); }
    .landing-about-shell { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--product-gap); align-items: center; }
    .landing-about-image { width: 100%; height: auto; border-radius: var(--radius); object-fit: cover; }
    .landing-about-body .section-title { text-align: left; }
    .landing-cta { background: var(--brand-primary); color: #fff; text-align: center; }
    .landing-cta-shell { display: grid; gap: 1rem; justify-items: center; }
    .landing-cta .section-title, .landing-cta-text { color: #fff; }
    .landing-cta-text { max-width: 52ch; margin: 0 auto; font-size: clamp(1.05rem, 2.4vw, 1.3rem); opacity: .94; }
    .landing-cta-button { background: #fff; color: var(--brand-primary); padding: .9rem 2rem; font-size: 1.05rem; }

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
      .landing-benefits-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .landing-about-shell { grid-template-columns: 1fr; }
      .landing-about-body .section-title { text-align: center; }
      .cart-line { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      body.catalog-body { --section-x: 1rem; }
      .action-bar { left: 1rem; right: 1rem; justify-content: space-between; }
      .theme-button, .admin-link { padding: .65rem .85rem; }
      .products-grid { grid-template-columns: 1fr; }
      .landing-benefits-grid { grid-template-columns: 1fr; }
      .product-image, .product-image-fallback { height: 220px; }
      table { min-width: 440px; }
      .cart-control { grid-template-columns: 1fr; }
      .quote-actions { justify-content: stretch; }
      .quote-button, .secondary-button { width: 100%; }
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
</head>
<body class="catalog-body density-${density} card-style-${cardStyle} image-fit-${imageFit}">
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
      priceLow: prices.length ? Math.min(...prices) : null,
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
      if (taps >= 5) { taps = 0; window.location.href = '/admin/login'; }
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
            ? `<img src="${escapeHtml(config.company_logo)}" alt="Logo ${escapeHtml(config.company_name)}" class="logo-image" decoding="async" fetchpriority="high" data-admin-gate>`
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
        ? imgTag({ src: product.image_url, alt: product.name, w: 400, h: 260, className: "product-image", lazy: true })
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

// ── Landing page (secciones configurables) ─────────────────────────────────────

const renderHeroSection = (config: Record<string, string>) => {
  const heroImg = config.landing_hero_image || config.company_logo;
  const ctaHref = landingTarget(config, config.landing_hero_cta_target);
  const ctaLabel = config.landing_hero_cta_label || "Ver catálogo";
  const isExternal = ctaHref.startsWith("http");
  return `
  <section class="page-section landing-hero">
      ${renderShapes(config)}
      <div class="page-shell landing-hero-shell">
          ${heroImg
            ? `<img src="${escapeHtml(heroImg)}" alt="Logo ${escapeHtml(config.company_name || "PIXKEY3D")}" class="landing-hero-image" decoding="async" fetchpriority="high" data-admin-gate>`
            : `<div class="logo-fallback" data-admin-gate>Logo</div>`}
          <h1 data-admin-gate>${escapeHtml(config.landing_hero_title || config.company_name || "PIXKEY3D")}</h1>
          ${config.landing_hero_subtitle ? `<p class="landing-hero-subtitle">${escapeHtml(config.landing_hero_subtitle)}</p>` : ""}
          <a class="theme-button landing-hero-cta" href="${escapeHtml(ctaHref)}"${isExternal ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(ctaLabel)}</a>
      </div>
  </section>
`;
};

const renderBenefitsSection = (config: Record<string, string>) => {
  let items: Array<{ icon?: string; title?: string; text?: string }> = [];
  try {
    const parsed = JSON.parse(config.landing_benefits_items || "[]");
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    items = [];
  }
  if (items.length === 0) return "";
  return `
  <section class="page-section landing-benefits">
      ${renderShapes(config)}
      <div class="page-shell">
          ${config.landing_benefits_title ? `<h2 class="section-title">${escapeHtml(config.landing_benefits_title)}</h2>` : ""}
          <div class="landing-benefits-grid">
              ${items.map((it) => `
              <article class="theme-card landing-benefit-card">
                  ${it.icon ? `<div class="landing-benefit-icon" aria-hidden="true">${escapeHtml(it.icon)}</div>` : ""}
                  <h3>${escapeHtml(it.title || "")}</h3>
                  <p>${escapeHtml(it.text || "")}</p>
              </article>`).join("")}
          </div>
      </div>
  </section>
`;
};

const renderFeaturedSection = (
  config: Record<string, string>,
  featured: Array<{ product: Product; priceTiers: ReturnType<typeof getDefaultPriceTiers> }>,
) => {
  if (featured.length === 0) return "";
  return `
  <section class="page-section landing-featured">
      ${renderShapes(config)}
      <div class="page-shell">
          <h2 class="section-title">${escapeHtml(config.landing_featured_title || "Productos destacados")}</h2>
          <div class="products-grid">
              ${featured.map(({ product }) => `
              <a class="theme-card landing-featured-card" href="/catalogo">
                  ${product.image_url
                    ? imgTag({ src: product.image_url, alt: product.name, w: 400, h: 260, className: "product-image", lazy: true })
                    : `<div class="product-image-fallback">Sin imagen</div>`}
                  <div class="product-content">
                      <h3 class="product-title">${escapeHtml(product.name)}</h3>
                      ${product.description ? `<p class="product-description">${escapeHtml(product.description)}</p>` : ""}
                  </div>
              </a>`).join("")}
          </div>
      </div>
  </section>
`;
};

const renderAboutSection = (config: Record<string, string>) => {
  const text = config.landing_about_text || "";
  const img = config.landing_about_image;
  if (!cleanText(text) && !img) return "";
  return `
  <section class="page-section landing-about">
      ${renderShapes(config)}
      <div class="page-shell landing-about-shell">
          ${img ? imgTag({ src: img, alt: config.landing_about_title || "Sobre nosotros", w: 600, h: 400, className: "landing-about-image", lazy: true }) : ""}
          <div class="landing-about-body">
              <h2 class="section-title">${escapeHtml(config.landing_about_title || "Sobre nosotros")}</h2>
              ${renderAdminHtml(text)}
          </div>
      </div>
  </section>
`;
};

const renderCtaSection = (config: Record<string, string>) => {
  const href = landingTarget(config, config.landing_cta_button_target);
  const label = config.landing_cta_button_label || "Cotizar ahora";
  const isExternal = href.startsWith("http");
  return `
  <section class="page-section landing-cta">
      ${renderShapes(config)}
      <div class="page-shell landing-cta-shell">
          <h2 class="section-title">${escapeHtml(config.landing_cta_title || "")}</h2>
          ${config.landing_cta_text ? `<p class="landing-cta-text">${escapeHtml(config.landing_cta_text)}</p>` : ""}
          <a class="theme-button landing-cta-button" href="${escapeHtml(href)}"${isExternal ? ' target="_blank" rel="noopener"' : ""}>${escapeHtml(label)}</a>
      </div>
  </section>
`;
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
    ${config.landing_hero_enabled !== "0" ? renderHeroSection(config) : ""}
    ${config.landing_benefits_enabled !== "0" ? renderBenefitsSection(config) : ""}
    ${config.landing_featured_enabled !== "0" ? renderFeaturedSection(config, featured) : ""}
    ${config.landing_about_enabled !== "0" ? renderAboutSection(config) : ""}
    ${config.landing_cta_enabled !== "0" ? renderCtaSection(config) : ""}
    ${config.landing_contact_enabled !== "0" ? renderContactSection(config) : ""}
    ${adminGateScript()}
  `;
  const seo = {
    headMeta: buildHeadMeta({ pageType: "landing", config, origin, path: "/", products: seoProducts }),
    jsonLd: buildJsonLd({ pageType: "landing", config, origin, path: "/", products: seoProducts }),
  };
  return Layout(config.company_name || "PIXKEY3D", content, config, seo, config.landing_hero_image || config.company_logo || undefined);
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
  const body = `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /imprimir\n\nSitemap: ${origin}/sitemap.xml\n`;
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
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escXml(u.loc)}</loc><lastmod>${lastmod}</lastmod><priority>${u.priority}</priority></url>`)
    .join("\n")}\n</urlset>\n`;
  return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8" });
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
