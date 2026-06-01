import { getCookie } from "hono/cookie";
import { db } from "../db/schema";
import type { UserRole } from "../db/schema";

export interface SessionData {
  id: number;
  username: string;
  role: UserRole;
  exp: number;
}

const SESSION_SECRET = () => {
  const dbValue = (db.query<{ value: string }, [string]>(`SELECT value FROM config WHERE key = ?`).get("session_secret")?.value || "").trim();
  if (dbValue) return dbValue;
  const envValue = (process.env["SESSION_SECRET"] || "").trim();
  if (envValue) return envValue;
  return "pixkey3d-default-secret-change-me";
};

export async function signSession(data: SessionData): Promise<string> {
  const payload = JSON.stringify(data);
  const keyMaterial = new TextEncoder().encode(SESSION_SECRET());
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return btoa(payload) + "." + sigB64;
}

export async function verifySession(cookie: string): Promise<SessionData | null> {
  try {
    const [payloadB64, sigB64] = cookie.split(".");
    if (!payloadB64 || !sigB64) return null;
    const payload = atob(payloadB64);
    const keyMaterial = new TextEncoder().encode(SESSION_SECRET());
    const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const data: SessionData = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

export const requireAuth = async (c: any, next: any) => {
  const cookie = getCookie(c, "admin_session");
  if (cookie) {
    const session = await verifySession(cookie);
    if (session) {
      c.set("session", session);
      await next();
      return;
    }
  }
  const isApiRequest = c.req.method !== "GET" || c.req.header("accept")?.includes("application/json");
  if (isApiRequest) return c.json({ error: "No autorizado." }, 401);
  return c.redirect("/admin/login");
};

export const requireRole = (roles: UserRole[]) => async (c: any, next: any) => {
  const session: SessionData | undefined = c.get("session");
  if (!session || !roles.includes(session.role)) {
    const isApiRequest = c.req.method !== "GET" || c.req.header("accept")?.includes("application/json");
    if (isApiRequest) return c.json({ error: "Acceso denegado." }, 403);
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem"><h2>Acceso denegado</h2><p>Tu rol (<b>${session?.role ?? "desconocido"}</b>) no tiene permiso para acceder a esta sección.</p><a href="/admin">← Volver</a></body></html>`, 403);
  }
  await next();
};
