import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import { app } from "../src/app";
import { db, initDb, countPushSubscriptions, updateConfig } from "../src/db/schema";
import { signSession } from "../src/lib/session";

// Cookie de sesión válida (firmada con el secreto activo) para un superusuario.
let AUTH: { Cookie: string } = { Cookie: "" };

beforeAll(async () => {
  initDb();
  const token = await signSession({ id: 0, username: "tester", role: "superusuario", exp: Date.now() + 3600_000 });
  AUTH = { Cookie: `admin_session=${token}` };
});

beforeEach(() => {
  db.run("DELETE FROM push_subscriptions");
});

describe("PWA assets (scope raíz)", () => {
  test("GET /manifest.webmanifest devuelve JSON de manifest válido", async () => {
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const m = await res.json() as any;
    expect(m.name).toBeTruthy();
    expect(m.display).toBe("standalone");
    expect(Array.isArray(m.icons)).toBe(true);
  });

  test("GET /sw.js sirve el service worker", async () => {
    const res = await app.request("/sw.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("service-worker-allowed")).toBe("/");
    const body = await res.text();
    expect(body).toContain("addEventListener('push'");
  });

  test("GET /icons/app-icon.svg sirve un SVG", async () => {
    const res = await app.request("/icons/app-icon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain("<svg");
  });

  test("el ícono incrusta el company_logo cuando está configurado", async () => {
    const logo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    updateConfig({ company_logo: logo });
    try {
      const res = await app.request("/icons/app-icon.svg");
      const svg = await res.text();
      expect(svg).toContain("<image");
      expect(svg).toContain(logo);
    } finally {
      updateConfig({ company_logo: "" }); // no afectar otros tests
    }
  });
});

describe("Endpoints push admin (autenticación)", () => {
  test("sin sesión redirige a login", async () => {
    const res = await app.request("/admin/push/public-key");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/login");
  });

  test("public-key con sesión devuelve la clave VAPID", async () => {
    const res = await app.request("/admin/push/public-key", { headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.publicKey).toBeTruthy();
  });

  test("subscribe guarda la suscripción", async () => {
    const sub = { endpoint: "https://push.example/route-test", keys: { p256dh: "p", auth: "a" } };
    const res = await app.request("/admin/push/subscribe", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.ok).toBe(true);
    expect(data.total).toBe(1);
    expect(countPushSubscriptions()).toBe(1);
  });

  test("subscribe con cuerpo inválido devuelve 400", async () => {
    const res = await app.request("/admin/push/subscribe", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ subscription: { endpoint: "" } }),
    });
    expect(res.status).toBe(400);
  });

  test("unsubscribe elimina la suscripción", async () => {
    const sub = { endpoint: "https://push.example/to-remove", keys: { p256dh: "p", auth: "a" } };
    await app.request("/admin/push/subscribe", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub }),
    });
    expect(countPushSubscriptions()).toBe(1);
    const res = await app.request("/admin/push/unsubscribe", {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    expect(res.status).toBe(200);
    expect(countPushSubscriptions()).toBe(0);
  });

  test("test-send responde con sent/total", async () => {
    const res = await app.request("/admin/push/test", { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(typeof data.sent).toBe("number");
    expect(typeof data.total).toBe("number");
  });

  test("GET /admin/notificaciones renderiza la UI", async () => {
    const res = await app.request("/admin/notificaciones", { headers: AUTH });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Activar notificaciones");
    expect(html).toContain("data-push-enable");
  });
});
