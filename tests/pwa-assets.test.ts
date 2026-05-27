import { describe, test, expect } from "bun:test";
import { buildManifest, appIconSvg, renderAppIconSvg, pwaHeadTags, pwaRegisterScript, serviceWorkerJs } from "../src/pwa";

describe("buildManifest", () => {
  test("defaults sensatos con config vacía", () => {
    const m = buildManifest({});
    expect(m.name).toBe("PIXKEY3D");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.background_color).toBe("#ffffff");
    expect(m.theme_color).toBe("#2563eb"); // fallback porque no hay color_primary
    expect(m.icons).toHaveLength(1);
    expect(m.icons[0]).toMatchObject({ src: "/icons/app-icon.svg", type: "image/svg+xml" });
    expect(m.icons[0]!.purpose).toContain("maskable");
  });

  test("usa color_primary válido como theme_color", () => {
    expect(buildManifest({ color_primary: "#abc" }).theme_color).toBe("#abc");
    expect(buildManifest({ color_primary: "#A1B2C3" }).theme_color).toBe("#A1B2C3");
  });

  test("color_primary inválido cae al fallback", () => {
    expect(buildManifest({ color_primary: "rebeccapurple" }).theme_color).toBe("#2563eb");
    expect(buildManifest({ color_primary: "linear-gradient(...)" }).theme_color).toBe("#2563eb");
  });

  test("short_name se trunca a 12 caracteres", () => {
    const m = buildManifest({ company_name: "NombreSuperLargoDeMarca" });
    expect(m.name).toBe("NombreSuperLargoDeMarca");
    expect(m.short_name.length).toBeLessThanOrEqual(12);
  });

  test("el ícono siempre apunta al endpoint SVG (que incrusta el logo)", () => {
    // El logo se convierte en ícono vía /icons/app-icon.svg, no se referencia directo.
    const m = buildManifest({ company_logo: "/uploads/logo.png" });
    expect(m.icons).toHaveLength(1);
    expect(m.icons[0]).toMatchObject({ src: "/icons/app-icon.svg", type: "image/svg+xml" });
  });
});

describe("renderAppIconSvg (logo → ícono)", () => {
  test("sin logo cae a la inicial de la marca", async () => {
    const svg = await renderAppIconSvg({ company_name: "Zeta" });
    expect(svg).toContain(">Z<");
    expect(svg).not.toContain("<image");
  });

  test("incrusta el logo (data URI) centrado sobre fondo blanco", async () => {
    const dataUri = "data:image/png;base64,iVBORw0KGgo=";
    const svg = await renderAppIconSvg({ company_logo: dataUri });
    expect(svg).toContain("<image");
    expect(svg).toContain(dataUri);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });

  test("pwa_icon tiene prioridad sobre company_logo", async () => {
    const override = "data:image/png;base64,QQ==";
    const svg = await renderAppIconSvg({ company_logo: "data:image/png;base64,Wg==", pwa_icon: override });
    expect(svg).toContain(override);
  });
});

describe("appIconSvg", () => {
  test("es un SVG 512x512 con la inicial de la marca", () => {
    const svg = appIconSvg({ company_name: "tienda" });
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="512"');
    expect(svg).toContain(">T<"); // inicial mayúscula centrada
  });

  test("inicial por defecto 'P' y color de marca", () => {
    const svg = appIconSvg({ color_primary: "#123456" });
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain(">P<");
  });

  test("escapa caracteres XML peligrosos en la inicial", () => {
    const svg = appIconSvg({ company_name: "<x" });
    expect(svg).not.toContain("><<"); // el '<' de la inicial no queda crudo
    expect(svg).toContain("&lt;");
  });
});

describe("pwaHeadTags", () => {
  test("incluye manifest, theme-color y tags de apple", () => {
    const tags = pwaHeadTags({ company_name: "Marca", color_primary: "#0a0a0a" });
    expect(tags).toContain('rel="manifest"');
    expect(tags).toContain('href="/manifest.webmanifest"');
    expect(tags).toContain('name="theme-color"');
    expect(tags).toContain("#0a0a0a");
    expect(tags).toContain('name="apple-mobile-web-app-capable"');
    expect(tags).toContain('rel="apple-touch-icon"');
    expect(tags).toContain('content="Marca"');
  });

  test("apple-touch-icon: logo raster directo (iOS), SVG en otro caso", () => {
    // iOS no soporta SVG en apple-touch-icon: si el logo es raster, va directo.
    expect(pwaHeadTags({ company_logo: "/uploads/logo.png" })).toContain('rel="apple-touch-icon" href="/uploads/logo.png"');
    expect(pwaHeadTags({ pwa_icon: "/uploads/icon.jpg" })).toContain('rel="apple-touch-icon" href="/uploads/icon.jpg"');
    // Logo SVG o sin logo → cae al endpoint SVG (Android/desktop sí lo soportan).
    expect(pwaHeadTags({ company_logo: "/uploads/logo.svg" })).toContain('rel="apple-touch-icon" href="/icons/app-icon.svg"');
    expect(pwaHeadTags({})).toContain('rel="apple-touch-icon" href="/icons/app-icon.svg"');
  });

  test("escapa comillas/HTML en el nombre de la marca", () => {
    const tags = pwaHeadTags({ company_name: '"><script>' });
    expect(tags).not.toContain("<script>");
    expect(tags).toContain("&quot;");
  });
});

describe("pwaRegisterScript", () => {
  test("registra el service worker en /sw.js", () => {
    const s = pwaRegisterScript();
    expect(s).toContain("serviceWorker");
    expect(s).toContain("register('/sw.js')");
  });
});

describe("serviceWorkerJs", () => {
  const sw = serviceWorkerJs();
  test("maneja push y notificationclick", () => {
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("showNotification");
  });
  test("nunca cachea /admin y solo intercepta navegaciones GET", () => {
    expect(sw).toContain("startsWith('/admin')");
    expect(sw).toContain("req.method !== 'GET'");
    expect(sw).toContain("req.mode !== 'navigate'");
  });
  test("toma control inmediato (skipWaiting + clients.claim)", () => {
    expect(sw).toContain("skipWaiting");
    expect(sw).toContain("clients.claim");
  });
});
