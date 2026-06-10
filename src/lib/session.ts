import { getCookie } from "hono/cookie";
import { db, updateConfig } from "../db/schema";
import type { UserRole } from "../db/schema";

export interface SessionData {
  id: number;
  username: string;
  role: UserRole;
  exp: number;
  v?: number; // versión de sesión: permite revocar todas las sesiones de golpe
}

// Versión global de sesión. Se incrusta en cada token al firmar y se valida al
// verificar; al incrementarla (bumpSessionVersion) todas las sesiones emitidas
// previamente quedan invalidadas (revocación server-side, p. ej. al cambiar la
// contraseña del superusuario). Es una lectura indexada por PK, muy barata.
export const currentSessionVersion = (): number => {
  const raw = db.query<{ value: string }, [string]>(`SELECT value FROM config WHERE key = ?`).get("session_version")?.value;
  const n = parseInt((raw || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

export const bumpSessionVersion = (): void => {
  updateConfig({ session_version: String(currentSessionVersion() + 1) });
};

// El secreto de sesión debe ser ESTABLE e IMPREDECIBLE: si falta, se genera uno
// aleatorio y se persiste (mismo patrón que ensureVapidKeys). Nunca se usa un
// fallback público conocido, que permitiría forjar cookies de superusuario.
let cachedSecret: string | null = null;

const SESSION_SECRET = () => {
  if (cachedSecret) return cachedSecret;
  const dbValue = (db.query<{ value: string }, [string]>(`SELECT value FROM config WHERE key = ?`).get("session_secret")?.value || "").trim();
  if (dbValue) return (cachedSecret = dbValue);
  const envValue = (process.env["SESSION_SECRET"] || "").trim();
  if (envValue) return (cachedSecret = envValue);
  const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  updateConfig({ session_secret: generated });
  return (cachedSecret = generated);
};

// Genera y persiste el secreto al arranque (antes de servir peticiones) para que
// siempre exista y evitar una carrera en el primer uso concurrente.
export const ensureSessionSecret = () => SESSION_SECRET();

export async function signSession(data: SessionData): Promise<string> {
  const payload = JSON.stringify({ ...data, v: currentSessionVersion() });
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
    if ((data.v ?? 0) !== currentSessionVersion()) return null; // sesión revocada
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
