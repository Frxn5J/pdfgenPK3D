import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { app } from "../src/app";
import { initDb, updateConfig } from "../src/db/schema";

beforeAll(() => { initDb(); });

// Restaura config tocada por cada test
afterEach(() => {
  updateConfig({
    dark_mode_enabled: "1",
    landing_hero_mode: "image",
    landing_hero_carousel_image_1: "",
    landing_hero_carousel_image_2: "",
    dark_bg_cover: "#0c1117",
    dark_color_cover_text: "#f1f5f9",
    dark_bg_products: "#1f2937",
    dark_bg_section_dark: "#0f172a",
    dark_bg_cta: "#1e3a5f",
    dark_color_body_text: "#e2e8f0",
    dark_color_heading_text: "#f8fafc",
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const getLanding = async () => {
  const res = await app.request("/");
  return { res, html: await res.text() };
};

// ── Landing básico ───────────────────────────────────────────────────────────
describe("Landing page", () => {
  test("GET / retorna 200", async () => {
    const { res } = await getLanding();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("contiene secciones principales", async () => {
    const { html } = await getLanding();
    expect(html).toContain('id="inicio"');
    expect(html).toContain('id="precios"');
    expect(html).toContain('id="proceso"');
    expect(html).toContain('id="ubicacion"');
    expect(html).toContain('id="faq"');
  });
});

// ── Dark mode toggle ─────────────────────────────────────────────────────────
describe("Dark mode toggle", () => {
  test("aparece por defecto (dark_mode_enabled=1)", async () => {
    const { html } = await getLanding();
    expect(html).toContain('id="dm-toggle"');
  });

  test("desaparece cuando dark_mode_enabled=0", async () => {
    updateConfig({ dark_mode_enabled: "0" });
    const { html } = await getLanding();
    expect(html).not.toContain('id="dm-toggle"');
  });

  test("script anti-FOUC presente cuando está activo", async () => {
    const { html } = await getLanding();
    expect(html).toContain("localStorage.getItem('theme')");
    expect(html).toContain("setAttribute('data-theme'");
  });

  test("script anti-FOUC ausente cuando está desactivado", async () => {
    updateConfig({ dark_mode_enabled: "0" });
    const { html } = await getLanding();
    expect(html).not.toContain("localStorage.getItem('theme')");
  });
});

// ── Dark mode CSS ────────────────────────────────────────────────────────────
describe("Dark mode CSS", () => {
  test("bloque :root[data-theme=\"dark\"] presente", async () => {
    const { html } = await getLanding();
    expect(html).toContain(':root[data-theme="dark"]');
  });

  test("usa dark_bg_cover configurado", async () => {
    updateConfig({ dark_bg_cover: "#aabbcc" });
    const { html } = await getLanding();
    expect(html).toContain("--cover-bg: #aabbcc");
  });

  test("usa dark_color_cover_text configurado", async () => {
    updateConfig({ dark_color_cover_text: "#112233" });
    const { html } = await getLanding();
    expect(html).toContain("--cover-text: #112233");
  });

  test("usa dark_bg_products configurado", async () => {
    updateConfig({ dark_bg_products: "#ddeeff" });
    const { html } = await getLanding();
    expect(html).toContain("--products-bg: #ddeeff");
  });

  test("override .ln-section-dark usa dark_bg_section_dark", async () => {
    updateConfig({ dark_bg_section_dark: "#ff0000" });
    const { html } = await getLanding();
    expect(html).toContain("background: #ff0000");
  });

  test("override .ln-cta-banner usa dark_bg_cta", async () => {
    updateConfig({ dark_bg_cta: "#cafeba" });
    const { html } = await getLanding();
    expect(html).toContain("background: #cafeba");
  });

  test("CSS del carrusel siempre presente", async () => {
    const { html } = await getLanding();
    expect(html).toContain(".ln-carousel");
    expect(html).toContain(".ln-carousel-slide");
  });
});

// ── Hero image / carousel ────────────────────────────────────────────────────
describe("Hero mode", () => {
  test("modo imagen por defecto — sin .ln-carousel", async () => {
    const { html } = await getLanding();
    expect(html).not.toContain('class="ln-hero-img-wrap ln-carousel"');
  });

  test("modo imagen muestra img cuando landing_hero_image está configurado", async () => {
    updateConfig({ landing_hero_image: "/uploads/hero.jpg" });
    const { html } = await getLanding();
    expect(html).toContain('src="/img?src=%2Fuploads%2Fhero.jpg&amp;w=800"');
    expect(html).toContain('fetchpriority="high"');
  });

  test("modo imagen sin imagen muestra fallback 3D", async () => {
    updateConfig({ landing_hero_image: "" });
    const { html } = await getLanding();
    expect(html).toContain("ln-hero-logo-fallback");
  });

  test("modo carrusel sin imágenes muestra fallback 3D", async () => {
    updateConfig({ landing_hero_mode: "carousel" });
    const { html } = await getLanding();
    expect(html).toContain('id="ln-carousel"');
    expect(html).toContain("ln-hero-logo-fallback");
  });

  test("modo carrusel con 2 imágenes renderiza 2 slides", async () => {
    updateConfig({
      landing_hero_mode: "carousel",
      landing_hero_carousel_image_1: "/uploads/a.jpg",
      landing_hero_carousel_image_2: "/uploads/b.jpg",
    });
    const { html } = await getLanding();
    expect(html).toContain("ln-carousel-slide");
    expect(html).toContain("%2Fuploads%2Fa.jpg");
    expect(html).toContain("%2Fuploads%2Fb.jpg");
    // primera slide tiene fetchpriority high
    expect(html).toContain('fetchpriority="high"');
    // script de autoplay presente con más de 1 imagen
    expect(html).toContain("setInterval");
  });

  test("modo carrusel con 1 imagen no genera script de autoplay", async () => {
    updateConfig({
      landing_hero_mode: "carousel",
      landing_hero_carousel_image_1: "/uploads/solo.jpg",
    });
    const { html } = await getLanding();
    expect(html).toContain("ln-carousel-slide");
    expect(html).not.toContain("setInterval");
  });

  test("imágenes vacías en carrusel se omiten", async () => {
    updateConfig({
      landing_hero_mode: "carousel",
      landing_hero_carousel_image_1: "/uploads/real.jpg",
      landing_hero_carousel_image_2: "",
      landing_hero_carousel_image_3: "",
    });
    const { html } = await getLanding();
    // solo 1 slide → no autoplay
    expect(html).not.toContain("setInterval");
  });
});
