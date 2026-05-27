// PWA + Web Push. Módulo compartido por public.ts (assets en scope raíz),
// admin.ts (UI/endpoints de notificaciones) y el trigger de cotizaciones.
import webpush from "web-push";
import { join } from "path";
import * as fs from "fs";
import { getConfig, updateConfig, getPushSubscriptions, deletePushSubscription } from "./db/schema";

// Escapes mínimos locales (no dependemos de los de public/admin).
const escAttr = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
const escXml = (value: unknown) =>
  String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));

// Acepta solo colores hex (#rgb / #rrggbb); si no, usa el fallback. El manifest
// y theme-color exigen un color CSS válido, y config.* puede traer gradientes.
const hexColor = (value: unknown, fallback: string) => {
  const v = String(value ?? "").trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : fallback;
};

// ── VAPID ────────────────────────────────────────────────────────────────
// Las claves VAPID deben ser ESTABLES: regenerarlas invalida todas las
// suscripciones. Se generan una sola vez y se persisten en config.
let cachedVapid: { publicKey: string; privateKey: string; subject: string } | null = null;

export function ensureVapidKeys() {
  if (cachedVapid) return cachedVapid;
  const config = getConfig();
  let publicKey = (config.vapid_public_key || process.env.VAPID_PUBLIC_KEY || "").trim();
  let privateKey = (config.vapid_private_key || process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (config.vapid_subject || process.env.VAPID_SUBJECT || "mailto:admin@pixkey3d.local").trim();
  if (!publicKey || !privateKey) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    privateKey = keys.privateKey;
    updateConfig({ vapid_public_key: publicKey, vapid_private_key: privateKey, vapid_subject: subject });
  }
  cachedVapid = { publicKey, privateKey, subject };
  return cachedVapid;
}

export function getVapidPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

export type PushPayload = { title: string; body: string; url?: string; tag?: string; icon?: string };

// Envía a TODAS las suscripciones. Limpia las caducadas (404/410).
export async function sendPushToAll(payload: PushPayload): Promise<{ sent: number; total: number }> {
  const { publicKey, privateKey, subject } = ensureVapidKeys();
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const config = getConfig();
  const subs = getPushSubscriptions();
  const data = JSON.stringify({ icon: (config.pwa_icon || "").trim() || "/icons/app-icon.svg", ...payload });
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        const toBase64url = (k: string) => k.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: toBase64url(s.p256dh), auth: toBase64url(s.auth) } }, data);
      } catch (err: any) {
        // Suscripción muerta: el navegador la revocó. La borramos.
        if (err?.statusCode === 404 || err?.statusCode === 410) deletePushSubscription(s.endpoint);
        throw err;
      }
    })
  );
  return { sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length };
}

// ── Manifest ─────────────────────────────────────────────────────────────
export function buildManifest(config: Record<string, string>) {
  const name = (config.company_name || "PIXKEY3D").trim() || "PIXKEY3D";
  const themeColor = hexColor(config.color_primary, "#2563eb");
  // El ícono siempre se sirve desde /icons/app-icon.svg, que incrusta el logo
  // (o cae a una inicial) y queda cuadrado/maskable. Así el logo se convierte
  // en el ícono de la app sin procesar imágenes ni exigir un PNG de tamaño exacto.
  return {
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: (config.cover_subtitle || `Catálogo de ${name}`).slice(0, 180),
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: themeColor,
    icons: [{ src: "/icons/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  };
}

// Fuente del ícono: pwa_icon (override) o el logo de la empresa.
const iconSource = (config: Record<string, string>) => (config.pwa_icon || config.company_logo || "").trim();
const RASTER_RE = /\.(png|jpe?g|webp)$/i;

// Resuelve el logo a un data URI EN EL SERVER (archivo local, data URI o URL
// remota). Devuelve null si no hay logo o no se pudo leer.
async function resolveLogoDataUri(config: Record<string, string>): Promise<string | null> {
  const src = iconSource(config);
  if (!src) return null;
  if (/^data:image\//i.test(src)) return src;
  const mimeFromExt = (p: string) => {
    const ext = (p.split(".").pop() || "").toLowerCase().split(/[?#]/)[0];
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "svg") return "image/svg+xml";
    if (ext === "gif") return "image/gif";
    return "image/png";
  };
  try {
    if (src.startsWith("/")) {
      // Ruta local servida desde ./data (p.ej. /uploads/logo.png → data/uploads/logo.png).
      const localPath = join(process.cwd(), "data", src.replace(/^\/+/, ""));
      if (!fs.existsSync(localPath)) return null;
      return `data:${mimeFromExt(src)};base64,${fs.readFileSync(localPath).toString("base64")}`;
    }
    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src);
      if (!res.ok) return null;
      const mime = res.headers.get("content-type") || mimeFromExt(src);
      return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
    }
  } catch {
    return null;
  }
  return null;
}

// Construye el SVG del ícono de la app (512x512, maskable). Si hay logo, lo
// incrusta centrado sobre fondo blanco con margen (zona segura). Si no, usa la
// inicial de la marca.
export async function renderAppIconSvg(config: Record<string, string>): Promise<string> {
  const dataUri = await resolveLogoDataUri(config);
  if (!dataUri) return appIconSvg(config);
  // Margen del 12.5% (logo en el 75% central) para sobrevivir el recorte maskable.
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#ffffff"/>
  <image href="${escAttr(dataUri)}" xlink:href="${escAttr(dataUri)}" x="64" y="64" width="384" height="384" preserveAspectRatio="xMidYMid meet"/>
</svg>`;
}

// ── Icono dinámico (default, sin procesar imágenes) ──────────────────────
// SVG maskable a sangre completa (el fondo cubre todo, la inicial va centrada
// dentro de la zona segura). Se reemplaza subiendo un PNG en /admin/config.
export function appIconSvg(config: Record<string, string>): string {
  const name = (config.company_name || "P").trim() || "P";
  const initial = (name.charAt(0) || "P").toUpperCase();
  const themeColor = hexColor(config.color_primary, "#2563eb");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${themeColor}"/>
  <text x="256" y="256" font-family="Arial, Helvetica, sans-serif" font-size="248" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${escXml(initial)}</text>
</svg>`;
}

// ── Tags <head> + registro del Service Worker ────────────────────────────
export function pwaHeadTags(config: Record<string, string>): string {
  const themeColor = hexColor(config.color_primary, "#2563eb");
  const name = (config.company_name || "PIXKEY3D").trim() || "PIXKEY3D";
  // iOS no rasteriza apple-touch-icon SVG: si el logo es raster (png/jpg/webp)
  // lo usamos directo; si no, caemos al SVG (Android/desktop sí lo soportan).
  const src = iconSource(config);
  const appleIcon = RASTER_RE.test(src) || /^data:image\/(png|jpe?g|webp)/i.test(src) ? src : "/icons/app-icon.svg";
  return `
    <link rel="manifest" href="/manifest.webmanifest">
    <meta name="theme-color" content="${escAttr(themeColor)}">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="${escAttr(name)}">
    <link rel="apple-touch-icon" href="${escAttr(appleIcon)}">`;
}

export function pwaRegisterScript(): string {
  return `<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (e) { console.warn('SW registration failed', e); });
    });
  }
  </script>`;
}

// ── Service Worker ───────────────────────────────────────────────────────
// Sirve en scope raíz (/sw.js). Maneja push + notificationclick y un fetch
// network-first conservador para navegaciones (nunca cachea /admin).
export function serviceWorkerJs(): string {
  return `const CACHE = 'pixkey3d-pwa-v1';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/admin')) return;
  if (req.mode !== 'navigate') return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, res.clone());
      return res;
    } catch (e) {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fallback = await caches.match('/catalogo');
      return fallback || new Response('Sin conexión', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'PIXKEY3D', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'PIXKEY3D';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icons/app-icon.svg',
    badge: data.badge || '/icons/app-icon.svg',
    tag: data.tag || 'pixkey3d',
    renotify: true,
    data: { url: data.url || '/admin' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/admin';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) { try { await client.navigate(target); } catch (e) {} return client.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
`;
}
