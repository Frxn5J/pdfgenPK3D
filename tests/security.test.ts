import { describe, test, expect, beforeAll } from "bun:test";
import { app } from "../src/app";
import { initDb, db, updateConfig } from "../src/db/schema";
import { signSession, verifySession, bumpSessionVersion, currentSessionVersion } from "../src/lib/session";
import { assertSafeOutboundUrl, resolveUploadPath } from "../src/lib/images";
import { sniffImageExtension } from "../src/lib/html";

beforeAll(() => {
  initDb();
});

describe("Control de acceso por rol", () => {
  test("rol visor recibe 403 en mutación (POST /admin/image/enhance)", async () => {
    const token = await signSession({ id: 5, username: "lector", role: "visor", exp: Date.now() + 3600_000 });
    const res = await app.request("/admin/image/enhance", {
      method: "POST",
      headers: { Cookie: `admin_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "data:image/png;base64,AAAA" }),
    });
    expect(res.status).toBe(403);
  });

  test("rol editor pasa el guard de rol (no recibe 403)", async () => {
    const token = await signSession({ id: 6, username: "editor1", role: "editor", exp: Date.now() + 3600_000 });
    const res = await app.request("/admin/image/enhance", {
      method: "POST",
      headers: { Cookie: `admin_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ imageUrl: "" }),
    });
    expect(res.status).not.toBe(403);
  });
});

describe("Anti-SSRF (assertSafeOutboundUrl)", () => {
  test("rechaza loopback, IPs privadas y metadata", async () => {
    await expect(assertSafeOutboundUrl("http://127.0.0.1/x")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://10.0.0.5/x")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://192.168.1.1/x")).rejects.toThrow();
    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
  });
  test("rechaza esquemas no http(s)", async () => {
    await expect(assertSafeOutboundUrl("file:///etc/passwd")).rejects.toThrow();
  });
  test("acepta un host público", async () => {
    await expect(assertSafeOutboundUrl("https://1.1.1.1/")).resolves.toBeUndefined();
  });
});

describe("Anti path-traversal (resolveUploadPath)", () => {
  test("rechaza rutas que escapan de data/uploads", () => {
    expect(() => resolveUploadPath("/uploads/../../../etc/passwd")).toThrow();
  });
  test("acepta rutas dentro de uploads", () => {
    const p = resolveUploadPath("/uploads/products/foo.png");
    expect(p).toContain("uploads");
  });
});

describe("Validación de imágenes por magic bytes", () => {
  test("detecta PNG real", () => {
    expect(sniffImageExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
  });
  test("rechaza SVG/HTML disfrazado", () => {
    expect(sniffImageExtension(Buffer.from("<svg onload=alert(1)>", "utf-8"))).toBeNull();
    expect(sniffImageExtension(Buffer.from("<!DOCTYPE html>", "utf-8"))).toBeNull();
  });
});

describe("Rate limiting de login", () => {
  test("devuelve 429 tras superar el máximo de intentos", async () => {
    const ip = "203.0.113.77";
    let last = 200;
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/admin/login", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/x-www-form-urlencoded" },
        body: "username=bruteforce&password=wrong",
      });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe("Revocación de sesión por versión", () => {
  test("bump de versión invalida tokens previos", async () => {
    const original = currentSessionVersion();
    try {
      const token = await signSession({ id: 0, username: "admin", role: "superusuario", exp: Date.now() + 3600_000 });
      expect(await verifySession(token)).not.toBeNull();
      bumpSessionVersion();
      expect(await verifySession(token)).toBeNull();
    } finally {
      updateConfig({ session_version: String(original) }); // restaura estado global
    }
  });
});
