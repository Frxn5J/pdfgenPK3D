// Capa SEO automática para el catálogo y el landing.
//
// Premisa de diseño: el admin NO edita campos SEO. Todo (título, descripción,
// Open Graph, JSON-LD) se deriva de forma determinista del contenido de marketing
// + los datos de negocio que ya viven en la tabla `config`.
//
// Contrato de escaping (CRÍTICO — no mezclar):
//   • Valores de meta/atributo (content=, href=) → escapeHtml (escapa & < > " ').
//   • JSON-LD → JSON.stringify + escape de < > & a \uXXXX (safeJson). NUNCA escapeHtml:
//     re-codificar entidades HTML dentro de JSON rompe el parseo de Google.
//   • <loc> de sitemap → escXml (escapa & < >).
//
// Este módulo es de funciones puras: NO importa la DB. Recibe `config` y un arreglo
// de productos ya mapeado (con priceLow/priceHigh precomputados) para evitar
// dependencias circulares con la capa de datos.

import { escapeHtml } from "./html";
import { cleanText } from "./text";

export type PageType = "landing" | "catalog";

export interface SeoProduct {
  id: number;
  name: string;
  description?: string | null;
  image_url?: string | null;
  priceLow?: number | null;
  priceHigh?: number | null;
}

export interface SeoInput {
  pageType: PageType;
  config: Record<string, string>;
  origin: string; // base absoluta sin trailing slash, p.ej. "https://pixkey3d.com"
  path: string; // "/" | "/catalogo"
  products?: SeoProduct[];
}

// ── Helpers internos ─────────────────────────────────────────────────────────

const TITLE_MAX = 60;
const DESC_MAX = 155;

// Recorta en frontera de palabra y agrega … si excede el máximo.
const clamp = (value: string, max: number): string => {
  const text = cleanText(value);
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
};

// Primera frase "usable" (>= 40 chars) de un texto largo; si no, el texto completo.
const firstSentence = (value: string): string => {
  const text = cleanText(value);
  if (!text) return "";
  for (const seg of text.split(/(?<=[.!?])\s+/)) {
    if (seg.trim().length >= 40) return seg.trim();
  }
  return text;
};

// Convierte una URL a absoluta. Rechaza data: URIs (los scrapers sociales no las
// resuelven). Devuelve "" si no es http(s) ni una ruta /relativa.
const toAbsolute = (url: string | null | undefined, origin: string): string => {
  const u = String(url ?? "").trim();
  if (!u || /^data:/i.test(u)) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return origin + u;
  return "";
};

// Elimina recursivamente claves con valor undefined/null/"" para no emitir
// propiedades vacías en el JSON-LD.
const compact = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map(compact).filter((v) => v !== undefined && v !== null) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cv = compact(v);
      if (cv === undefined || cv === null || cv === "") continue;
      if (Array.isArray(cv) && cv.length === 0) continue;
      out[k] = cv;
    }
    return out as T;
  }
  return value;
};

const safeJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

export const escXml = (value: string): string =>
  String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Teléfono en formato E.164 (+52XXXXXXXXXX) a partir del número de WhatsApp.
const toE164 = (value: string): string => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+52${digits}`;
  if (digits.startsWith("52") && digits.length === 12) return `+${digits}`;
  return `+52${digits.slice(-10)}`;
};

const extractEmail = (value: string): string => {
  const m = String(value ?? "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : "";
};

// ── Derivación de origen absoluto ──────────────────────────────────────────────

// site_url (config) es la autoridad en producción (correcto detrás de cualquier
// proxy, inmune a host-header poisoning). Si está vacío, se deriva del request.
export const resolveOrigin = (c: any, config: Record<string, string>): string => {
  const configured = cleanText(config.site_url);
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  const proto = (c?.req?.header?.("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (
    c?.req?.header?.("x-forwarded-host") ||
    c?.req?.header?.("host") ||
    "pixkey3d.com"
  ).split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
};

// ── Derivación de título / descripción / imagen ────────────────────────────────

const deriveCompany = (config: Record<string, string>) => cleanText(config.company_name) || "PIXKEY3D";

const deriveTitle = (input: SeoInput, company: string): string => {
  if (input.pageType === "landing") {
    // seo_title_landing sobreescribe todo cuando está configurado
    if (cleanText(input.config.seo_title_landing)) return clamp(cleanText(input.config.seo_title_landing)!, TITLE_MAX);
    const headline = cleanText(input.config.landing_hero_title) || cleanText(input.config.cover_subtitle) || "Catálogo de Productos";
    return clamp(`${company} | ${headline}`, TITLE_MAX);
  }
  return clamp(`Catálogo | ${company}`, TITLE_MAX);
};

const deriveDescription = (input: SeoInput, company: string): string => {
  const base = `${company} — llaveros y figuras 3D personalizados al mayoreo en San Luis Potosí. Precios por volumen y envíos a todo México.`;
  if (input.pageType === "landing") {
    if (cleanText(input.config.seo_description_landing)) return clamp(cleanText(input.config.seo_description_landing)!, DESC_MAX);
    const candidate = cleanText(input.config.landing_hero_subtitle) || firstSentence(input.config.welcome_text || "");
    return clamp(candidate || base, DESC_MAX);
  }
  const candidate = firstSentence(input.config.welcome_text || "");
  return clamp(candidate || base, DESC_MAX);
};

const deriveImage = (input: SeoInput): string => {
  // Landing: preferir og_image_landing > landing_hero_image > landing_logo > company_logo
  if (input.pageType === "landing") {
    const og = toAbsolute(input.config.og_image_landing, input.origin);
    if (og) return og;
    const hero = toAbsolute(input.config.landing_hero_image, input.origin);
    if (hero) return hero;
    const landingLogo = toAbsolute(input.config.landing_logo, input.origin);
    if (landingLogo) return landingLogo;
  }
  const logo = toAbsolute(input.config.company_logo, input.origin);
  if (logo) return logo;
  for (const p of input.products || []) {
    const img = toAbsolute(p.image_url, input.origin);
    if (img) return img;
  }
  return `${input.origin}/icons/app-icon.svg`;
};

// ── API pública ────────────────────────────────────────────────────────────────

// Devuelve el bloque de <head> (incluye <title>). El charset/viewport los emite Layout.
export const buildHeadMeta = (input: SeoInput): string => {
  const company = deriveCompany(input.config);
  const title = deriveTitle(input, company);
  const description = deriveDescription(input, company);
  const canonical = input.origin + (input.path === "/" ? "/" : input.path.replace(/\/+$/, ""));
  const image = deriveImage(input);
  const e = escapeHtml;
  return `<title>${e(title)}</title>
    <meta name="description" content="${e(description)}">
    <meta name="robots" content="index,follow">
    <link rel="canonical" href="${e(canonical)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="${e(company)}">
    <meta property="og:locale" content="es_MX">
    <meta property="og:title" content="${e(title)}">
    <meta property="og:description" content="${e(description)}">
    <meta property="og:url" content="${e(canonical)}">
    <meta property="og:image" content="${e(image)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${e(title)}">
    <meta name="twitter:description" content="${e(description)}">
    <meta name="twitter:image" content="${e(image)}">`;
};

// Devuelve un <script type="application/ld+json"> con un @graph de entidades.
export const buildJsonLd = (input: SeoInput): string => {
  const { config, origin } = input;
  const company = deriveCompany(config);
  const logo = toAbsolute(config.company_logo, origin) || `${origin}/icons/app-icon.svg`;
  const telephone = toE164(config.quote_whatsapp_number || "");
  const email = extractEmail(config.contact_text || "");

  const orgId = `${origin}/#organization`;
  const localBizId = `${origin}/#localbusiness`;
  const websiteId = `${origin}/#website`;

  const organization = {
    "@type": "Organization",
    "@id": orgId,
    name: company,
    url: origin,
    logo,
    telephone: telephone || undefined,
    email: email || undefined,
  };

  const localBusiness = {
    "@type": "LocalBusiness",
    "@id": localBizId,
    name: company,
    image: logo,
    url: origin,
    telephone: telephone || undefined,
    email: email || undefined,
    address: {
      "@type": "PostalAddress",
      addressLocality: "San Luis Potosí",
      addressRegion: "SLP",
      addressCountry: "MX",
    },
    areaServed: { "@type": "Country", name: "México" },
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        opens: "09:00",
        closes: "18:00",
      },
    ],
    priceRange: "$$",
    parentOrganization: { "@id": orgId },
  };

  const website = {
    "@type": "WebSite",
    "@id": websiteId,
    url: origin,
    name: company,
    inLanguage: "es-MX",
    publisher: { "@id": orgId },
  };

  const graph: unknown[] = [organization, localBusiness, website];

  const products = (input.products || []).filter((p) => p && p.name);
  if (products.length > 0) {
    const itemList = {
      "@type": "ItemList",
      name: input.pageType === "landing" ? "Productos destacados" : "Catálogo de productos",
      itemListElement: products.map((p, i) => {
        const hasPrice = typeof p.priceLow === "number" && typeof p.priceHigh === "number";
        const product = {
          "@type": "Product",
          name: p.name,
          description: p.description ? clamp(p.description, 300) : undefined,
          image: toAbsolute(p.image_url, origin) || undefined,
          brand: { "@type": "Brand", name: company },
          offers: hasPrice
            ? {
                "@type": "AggregateOffer",
                priceCurrency: "MXN",
                lowPrice: p.priceLow,
                highPrice: p.priceHigh,
                availability: "https://schema.org/InStock",
                seller: { "@id": orgId },
              }
            : undefined,
        };
        return { "@type": "ListItem", position: i + 1, item: product };
      }),
    };
    graph.push(itemList);
  }

  const doc = compact({ "@context": "https://schema.org", "@graph": graph });
  return `<script type="application/ld+json">${safeJson(doc)}</script>`;
};
