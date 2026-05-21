import { Hono } from "hono";
import { getConfig, getProducts, getDefaultPriceTiers, getProductPriceTiers } from "../db/schema";

const publicRoutes = new Hono();
const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => htmlEntities[char] || char);

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

const formatVolume = (min: number, max: number | null) => max ? `${min} a ${max} piezas` : `${min} o más piezas`;

const buildThemeCss = (config: Record<string, string>) => {
  const cardStyle = choice(config.card_style, ["flat", "bordered", "minimal"], "flat");
  const density = choice(config.layout_density, ["compact", "comfortable", "spacious"], "comfortable");
  const imageFit = choice(config.product_image_fit, ["cover", "contain"], "cover");
  const shapeStyle = choice(config.decorative_shape_style, ["organic", "circles", "diagonal", "dots"], "organic");
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
    .theme-button, .admin-link {
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
    .theme-button:hover, .admin-link:hover { transform: translateY(-1px); filter: brightness(.98); box-shadow: 0 14px 30px rgba(15, 23, 42, .2); }

    .cover-section { min-height: 100vh; display: grid; place-items: center; background: var(--cover-bg); color: var(--cover-text); text-align: center; }
    .cover-section h1 { color: var(--cover-text); font-size: clamp(3rem, 10vw, 7.5rem); margin: 1.5rem 0 .75rem; letter-spacing: -.07em; }
    .cover-subtitle { color: var(--cover-text); font-size: clamp(1rem, 2.6vw, 1.55rem); font-weight: 700; letter-spacing: .28em; opacity: .78; text-transform: uppercase; }
    .logo-image { display: block; width: min(280px, 70vw); max-height: 240px; object-fit: contain; margin: 0 auto; }
    .logo-fallback { width: min(220px, 58vw); aspect-ratio: 1; border-radius: 999px; display: grid; place-items: center; margin: 0 auto; background: rgba(255,255,255,.18); border: 1px solid rgba(255,255,255,.28); color: var(--cover-text); font-size: 2rem; font-weight: 800; }

    .welcome-section { background: var(--welcome-bg); }
    .welcome-section .page-shell { width: min(920px, 100%); }
    .theme-copy { margin: 0 0 1rem; font-size: clamp(1rem, 2vw, 1.12rem); color: var(--body-text); }
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

    .contact-section { background: var(--contact-bg); color: var(--contact-text); text-align: center; }
    .contact-section h1, .contact-section h2, .contact-section h3, .contact-section h4, .contact-section p { color: var(--contact-text); }
    .contact-section .page-shell { width: min(860px, 100%); }

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
    }
    @media (max-width: 640px) {
      body.catalog-body { --section-x: 1rem; }
      .action-bar { left: 1rem; right: 1rem; justify-content: space-between; }
      .theme-button, .admin-link { padding: .65rem .85rem; }
      .products-grid { grid-template-columns: 1fr; }
      .product-image, .product-image-fallback { height: 220px; }
      table { min-width: 440px; }
    }
    @media print {
      .no-print { display: none !important; }
      body.catalog-body { background: white; color: #111827; }
      .page-section { min-height: 100vh; box-shadow: none !important; }
      .theme-card, .pricing-table-wrap, .product-table-wrap { box-shadow: none !important; }
      .theme-shapes { opacity: .18; }
    }

    ${customCss(config.custom_css)}
  `.trim();
};

const renderShapes = (config: Record<string, string>) => {
  if (config.decorative_shapes_enabled !== "1") return "";
  const style = choice(config.decorative_shape_style, ["organic", "circles", "diagonal", "dots"], "organic");
  return `<div class="theme-shapes shape-${style}" aria-hidden="true"><span class="shape-one"></span><span class="shape-two"></span><span class="shape-three"></span></div>`;
};

export const Layout = (title: string, content: string, config: Record<string, string>) => {
  const cardStyle = choice(config.card_style, ["flat", "bordered", "minimal"], "flat");
  const density = choice(config.layout_density, ["compact", "comfortable", "spacious"], "comfortable");
  const imageFit = choice(config.product_image_fit, ["cover", "contain"], "cover");

  return `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>${buildThemeCss(config)}</style>
</head>
<body class="catalog-body density-${density} card-style-${cardStyle} image-fit-${imageFit}">
    ${content}
</body>
</html>
`;
};

publicRoutes.get("/", (c) => {
  const config = getConfig();
  const defaultPriceTiers = getDefaultPriceTiers();
  const products = getProducts();

  const content = `
    <div class="action-bar no-print">
        <button onclick="window.print()" class="theme-button" type="button">Imprimir / PDF</button>
        <a href="/admin" class="admin-link">Admin</a>
    </div>

    <section class="page-section cover-section page-break">
        ${renderShapes(config)}
        <div class="page-shell">
            ${config.company_logo
                ? `<img src="${escapeHtml(config.company_logo)}" alt="Logo ${escapeHtml(config.company_name)}" class="logo-image">`
                : `<div class="logo-fallback">Logo</div>`
            }
            <h1>${escapeHtml(config.company_name || "PIXKEY3D")}</h1>
            <p class="cover-subtitle">${escapeHtml(config.cover_subtitle || "Catálogo de Productos")}</p>
        </div>
    </section>

    <section class="page-section welcome-section page-break">
        ${renderShapes(config)}
        <div class="page-shell">
            ${renderParagraphs(config.welcome_text)}

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

    <section class="page-section products-section">
        ${renderShapes(config)}
        <div class="page-shell">
            <h2 class="section-title">${escapeHtml(config.products_title || "Nuestros Productos")}</h2>
            <div class="products-grid">
                ${products.map((product) => {
                    const priceTiers = product.use_default_pricing ? defaultPriceTiers : getProductPriceTiers(product.id);
                    return `
                    <article class="theme-card page-break-inside-avoid">
                        ${product.image_url
                            ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" class="product-image">`
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
                        </div>
                    </article>
                    `;
                }).join("")}

                ${products.length === 0 ? '<p class="empty-products">No hay productos en el catálogo aún.</p>' : ''}
            </div>
        </div>
    </section>

    <section class="page-section contact-section page-break">
        ${renderShapes(config)}
        <div class="page-shell">
            ${renderParagraphs(config.contact_text, "theme-copy contact-copy")}
        </div>
    </section>
  `;

  return c.html(Layout(`${config.company_name || "PIXKEY3D"} - Catálogo`, content, config));
});

export { publicRoutes };
