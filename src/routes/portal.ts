import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db } from "../db/client";
import { getConfig } from "../db/config";
import {
  getQuoteByClientToken, getPortalItems, getPortalPayments,
  updatePrintedQuantities, updateShippingInfo,
  createClientAccount, getClientAccountByEmail, getClientAccountById,
  linkQuoteToAccount, getQuotesByAccountId,
  signClientSession, verifyClientSession, revokeClientSessions, type ClientSession,
  getClientProfile, updateClientProfile, updateClientPassword,
} from "../db/portal";
import { Layout } from "./public";

export const portalRoutes = new Hono();

// ── CSRF guard (mismo patrón que admin) ───────────────────────────────────────
const csrfGuard = async (c: any, next: any) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  if (origin) {
    const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
    try {
      if (new URL(origin).host !== host) return c.text("CSRF: origen no permitido.", 403);
    } catch {
      return c.text("CSRF: origen inválido.", 403);
    }
  }
  return next();
};
portalRoutes.use("/*", csrfGuard);

// ── Rate limiting login portal ────────────────────────────────────────────────
const LOGIN_MAX = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, number[]>();
const portalClientIp = (c: any) =>
  (c.req.header("x-forwarded-for") || "").split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
const loginRateKey = (c: any, email: string) => `${portalClientIp(c)}:${email.toLowerCase()}`;
const loginRetryAfter = (key: string): number => {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(key, recent);
  if (recent.length >= LOGIN_MAX) return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - recent[0]!)) / 1000));
  return 0;
};
const recordLoginFailure = (key: string) => {
  const arr = loginAttempts.get(key) || [];
  arr.push(Date.now());
  loginAttempts.set(key, arr);
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));

const currency = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const fmtDate = (d: string | null) =>
  d ? new Date(d).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" }) : "";

const getClientAuth = async (c: any): Promise<ClientSession | null> => {
  // El browser puede enviar múltiples client_session (path=/ y path=/portal legacy).
  // Probamos todas y retornamos la primera válida.
  const raw = c.req.header("cookie") ?? "";
  const values = [...raw.matchAll(/client_session=([^;,\s]+)/g)].map((m) => m[1]);
  for (const v of values) {
    const s = await verifyClientSession(v);
    if (s) return s;
  }
  return null;
};

const setClientCookie = async (c: any, accountId: number, email: string) => {
  const token = await signClientSession(accountId, email);
  setCookie(c, "client_session", token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
};

// ── CSS compartido ────────────────────────────────────────────────────────────

const portalCss = (config: Record<string, string>) => `
<style>
  /* ── Dark base ─────────────────────────────────── */
  body.catalog-body { background:#0b0f19!important; color:#f8fafc; }
  .prt-body { min-height:100vh; font-family:'Inter',system-ui,sans-serif; }
  .prt-sidebar { width:16rem; background:#0a0d16; border-right:1px solid #1e293b; display:flex; flex-direction:column; position:fixed; top:0; left:0; bottom:0; z-index:30; overflow-y:auto; }
  .prt-main { margin-left:16rem; flex:1; display:flex; flex-direction:column; min-width:0; background:#0b0f19; min-height:100vh; }
  .prt-content { flex:1; padding:1.5rem 2rem; }

  /* ── Sidebar ──────────────────────────────────── */
  .prt-sidebar .prt-logo { padding:1.25rem 1.5rem; border-bottom:1px solid #1e293b; display:flex; align-items:center; gap:.75rem; }
  .prt-sidebar .prt-logo-img { width:2.25rem; height:2.25rem; border-radius:.5rem; object-fit:contain; flex-shrink:0; }
  .prt-sidebar .prt-logo-fallback { width:2.25rem; height:2.25rem; border-radius:.5rem; background:linear-gradient(135deg,var(--brand-primary),#dc2626); display:flex; align-items:center; justify-content:center; flex-shrink:0; box-shadow:0 0 12px var(--brand-primary); }
  .prt-sidebar .prt-logo-text { font-size:1rem; font-weight:800; color:#fff; }
  .prt-sidebar .prt-logo-sub { display:block; font-size:.6rem; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--brand-primary); margin-top:-1px; }
  .prt-nav { padding:.75rem; display:flex; flex-direction:column; gap:.25rem; flex:1; }
  .prt-nav a { display:flex; align-items:center; gap:.75rem; padding:.65rem .85rem; border-radius:.5rem; font-size:.85rem; font-weight:500; color:#94a3b8; text-decoration:none; transition:all .15s; }
  .prt-nav a:hover { background:#1e293b; color:white; }
  .prt-nav a.active { background:linear-gradient(90deg,#1e293b,transparent); color:white; border-left:3px solid var(--brand-primary); font-weight:600; }
  .prt-nav a.active i { color:var(--brand-primary); }
  .prt-nav a i { width:1.15rem; font-size:1rem; }
  .prt-sidebar .prt-user-card { padding:.75rem 1rem; border-top:1px solid #1e293b; background:#070a10; }
  .prt-sidebar .prt-user-avatar { width:2.25rem; height:2.25rem; border-radius:50%; background:#1e293b; border:2px solid var(--brand-primary); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:.8rem; color:#cbd5e1; flex-shrink:0; }

  /* ── Top bar ──────────────────────────────────── */
  .prt-topbar { background:#0c101c; border-bottom:1px solid #1e293b; padding:.75rem 1.5rem; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:20; }
  .prt-topbar h2 { font-size:1.1rem; font-weight:800; color:white; display:flex; align-items:center; gap:.75rem; }

  /* ── Cards ────────────────────────────────────── */
  .prt-card { background:#161f30; border:1px solid #1e293b; border-radius:1rem; padding:1.5rem; }
  .prt-card-hover:hover { background:#1c273c; border-color:#334155; transform:translateY(-2px); }
  .prt-card-glow { box-shadow:0 0 15px var(--brand-primary); }

  /* ── Badges ───────────────────────────────────── */
  .prt-badge { display:inline-flex; align-items:center; gap:.4rem; padding:.25rem .75rem; border-radius:999px; font-size:.65rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  .prt-badge-new { background:rgba(251,191,36,.12); color:#fbbf24; border:1px solid rgba(251,191,36,.25); }
  .prt-badge-no_despachado { background:rgba(148,163,184,.12); color:#94a3b8; border:1px solid rgba(148,163,184,.25); }
  .prt-badge-despachado { background:rgba(59,130,246,.12); color:#60a5fa; border:1px solid rgba(59,130,246,.25); }
  .prt-badge-produccion { background:color-mix(in srgb,var(--brand-primary)12%,transparent); color:var(--brand-primary); border:1px solid color-mix(in srgb,var(--brand-primary)25%,transparent); }
  .prt-badge-finalizado { background:rgba(16,185,129,.12); color:#10b981; border:1px solid rgba(16,185,129,.25); }
  .prt-badge-spam { background:rgba(239,68,68,.12); color:#ef4444; border:1px solid rgba(239,68,68,.25); }

  /* ── Hero / metrics grid ───────────────────────── */
  .prt-hero { background:rgba(22,30,48,.6); border:1px solid #1e293b; border-radius:1rem; padding:1.5rem; }
  .prt-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:1.25rem; }
  .prt-metric-icon { padding:.4rem; border-radius:.5rem; background:#1e293b; color:#94a3b8; transition:all .2s; }
  .prt-metric-card:hover .prt-metric-icon { background:color-mix(in srgb,var(--brand-primary)10%,transparent); color:var(--brand-primary); }

  /* ── Timeline ─────────────────────────────────── */
  .prt-timeline { display:flex; flex-direction:column; gap:.5rem; position:relative; padding-left:2.5rem; }
  .prt-timeline::before { content:''; position:absolute; left:.6875rem; top:.625rem; bottom:.625rem; width:2px; background:#1e293b; }
  .prt-milestone { position:relative; padding:.5rem 0; }
  .prt-dot { position:absolute; left:-2.5rem; top:.5rem; width:1.375rem; height:1.375rem; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:.6rem; font-weight:700; z-index:1; }
  .prt-dot.done { background:#10b981; border:3px solid #0b0f19; color:white; }
  .prt-dot.current { background:var(--brand-primary); border:3px solid #0b0f19; color:white; box-shadow:0 0 0 4px color-mix(in srgb,var(--brand-primary)30%,transparent); }
  .prt-dot.pending { background:#1e293b; border:3px solid #0b0f19; color:#64748b; }
  .prt-milestone-title { font-weight:700; font-size:.9rem; color:#f8fafc; }
  .prt-milestone-title.pending { color:#64748b; font-weight:500; }
  .prt-milestone-sub { font-size:.78rem; color:#94a3b8; margin-top:.1rem; }

  /* ── Progress bars ─────────────────────────────── */
  .prt-progress-track { height:.5rem; background:#1e293b; border-radius:999px; overflow:hidden; }
  .prt-progress-fill { height:100%; background:linear-gradient(90deg,var(--brand-primary),#f97316); border-radius:999px; transition:width .4s; }

  /* ── Form elements ─────────────────────────────── */
  .prt-form { display:flex; flex-direction:column; gap:1rem; }
  .prt-field { display:flex; flex-direction:column; gap:.35rem; }
  .prt-label { font-size:.7rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#94a3b8; }
  .prt-input,.prt-select { border:1px solid #1e293b; border-radius:.5rem; padding:.65rem .85rem; font:inherit; color:#f8fafc; background:#0f172a; font-size:.9rem; transition:border-color .15s,box-shadow .15s; }
  .prt-input:focus,.prt-select:focus { outline:none; border-color:var(--brand-primary); box-shadow:0 0 0 3px color-mix(in srgb,var(--brand-primary)15%,transparent); }
  .prt-btn { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; padding:.65rem 1.25rem; border-radius:.5rem; font-weight:700; font-size:.85rem; cursor:pointer; border:0; transition:all .15s; }
  .prt-btn-primary { background:linear-gradient(135deg,var(--brand-primary),var(--brand-secondary,#dc2626)); color:white; box-shadow:0 4px 12px color-mix(in srgb,var(--brand-primary)25%,transparent); }
  .prt-btn-primary:hover { filter:brightness(1.1); transform:translateY(-1px); }
  .prt-btn-ghost { background:transparent; color:#94a3b8; border:1px solid #1e293b; }
  .prt-btn-ghost:hover { background:#1e293b; color:white; }
  .prt-btn-danger { background:rgba(239,68,68,.1); color:#ef4444; border:1px solid rgba(239,68,68,.2); }
  .prt-btn-danger:hover { background:rgba(239,68,68,.2); }

  /* ── Error / success ───────────────────────────── */
  .prt-error { background:rgba(239,68,68,.1); color:#fca5a5; border:1px solid rgba(239,68,68,.25); border-radius:.5rem; padding:.75rem 1rem; font-size:.875rem; }
  .prt-success { background:rgba(16,185,129,.1); color:#6ee7b7; border:1px solid rgba(16,185,129,.25); border-radius:.5rem; padding:.75rem 1rem; font-size:.875rem; }

  /* ── Tracking iframe ───────────────────────────── */
  .prt-tracking-frame { width:100%; height:520px; border:1px solid #1e293b; border-radius:.75rem; background:#0f172a; }

  /* ── Auth pages ────────────────────────────────── */
  .prt-auth-wrap { max-width:420px; margin:0 auto; padding:4rem 1rem; min-height:100vh; display:flex; align-items:center; justify-content:center; }
  .prt-order-preview { background:#0f172a; border:1px solid #1e293b; border-radius:.75rem; padding:1rem; margin:1rem 0; font-size:.875rem; }

  /* ── Items list ────────────────────────────────── */
  .prt-items { display:flex; flex-direction:column; gap:.75rem; }
  .prt-item { background:#0f172a; border:1px solid #1e293b; border-radius:.75rem; padding:.875rem 1rem; }
  .prt-item-header { display:flex; justify-content:space-between; align-items:baseline; gap:.5rem; margin-bottom:.5rem; font-size:.875rem; }
  .prt-item-name { font-weight:700; color:#f8fafc; }
  .prt-item-count { font-size:.75rem; color:#94a3b8; white-space:nowrap; }

  /* ── Responsive ────────────────────────────────── */
  @media (max-width:768px) {
    .prt-sidebar { position:relative; width:100%; border-right:0; border-bottom:1px solid #1e293b; }
    .prt-main { margin-left:0; }
    .prt-content { padding:1rem; }
    .prt-metrics { grid-template-columns:1fr; }
  }
</style>
`;

const statusLabel: Record<string, string> = {
  new: "Recibido", no_despachado: "En revisión", despachado: "Aprobado",
  produccion: "En producción", finalizado: "Producción finalizada", spam: "Cancelado",
};

const milestone = (done: boolean, current: boolean, title: string, sub?: string) => `
  <div class="prt-milestone">
    <div class="prt-dot${done ? " done" : current ? " current" : " pending"}">${done ? "✓" : current ? "●" : ""}</div>
    <div class="prt-milestone-title${!done && !current ? " pending" : ""}">${esc(title)}</div>
    ${sub ? `<div class="prt-milestone-sub">${esc(sub)}</div>` : ""}
  </div>`;

const portalLayout = (title: string, content: string, config: Record<string, string>) =>
  Layout(`Pixkey3D Portal de Clientes — ${esc(title)}`, `<div class="prt-body">${content}</div>`, config, undefined, undefined, `
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
</style>
${portalCss(config)}`);

// ── Auth: Login ───────────────────────────────────────────────────────────────

portalRoutes.get("/login", async (c) => {
  const session = await getClientAuth(c);
  if (session) return c.redirect("/portal/me");
  const from = c.req.query("from") || "";
  const error = c.req.query("error") || "";
  const config = getConfig();
  const content = `
    <div class="prt-auth-wrap">
      <div class="prt-card">
        <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:1rem">
          <div style="width:2.25rem;height:2.25rem;border-radius:.5rem;background:linear-gradient(135deg,#ef4444,#e11d48);display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(239,68,68,.25)">
            <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/><path d="M2 17L12 22L12 12L2 7V17Z" fill="currentColor" fill-opacity=".8"/><path d="M22 17L12 22L12 12L22 7V17Z" fill="currentColor" fill-opacity=".6"/></svg>
          </div>
          <div><div style="font-size:1.05rem;font-weight:800;color:white">Pixkey 3D</div><span style="font-size:.55rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ef4444">Portal de Clientes</span></div>
        </div>
        <h1 style="font-size:1.3rem;font-weight:800;color:white;margin:0 0 .25rem">Iniciar sesi&oacute;n</h1>
        <p style="font-size:.85rem;color:#94a3b8;margin:0 0 1.25rem">Seguimiento de pedidos</p>
        ${error === "invalid" ? `<div class="prt-error">Email o contrase&ntilde;a incorrectos.</div>` : ""}
        <form method="post" action="/portal/login" class="prt-form">
          <input type="hidden" name="from" value="${esc(from)}">
          <div class="prt-field"><label class="prt-label">Email</label><input class="prt-input" type="email" name="email" required autocomplete="email"></div>
          <div class="prt-field"><label class="prt-label">Contrase&ntilde;a</label><input class="prt-input" type="password" name="password" required autocomplete="current-password"></div>
          <button type="submit" class="prt-btn prt-btn-primary" style="width:100%">Iniciar sesi&oacute;n</button>
        </form>
      </div>
    </div>`;
  return c.html(portalLayout("Iniciar sesión", content, config));
});

portalRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody() as Record<string, unknown>;
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const from = String(body.from || "").replace(/[^a-f0-9]/g, "");

  const rateKey = loginRateKey(c, email);
  const retryAfter = loginRetryAfter(rateKey);
  if (retryAfter > 0) {
    c.header("Retry-After", String(retryAfter));
    return c.text(`Demasiados intentos. Intenta de nuevo en ${Math.ceil(retryAfter / 60)} minuto(s).`, 429);
  }

  const account = getClientAccountByEmail(email);
  const valid = account && await Bun.password.verify(password, account.password_hash);
  if (!valid) {
    recordLoginFailure(rateKey);
    const redirect = from ? `/portal/login?from=${from}&error=invalid` : "/portal/login?error=invalid";
    return c.redirect(redirect);
  }

  await setClientCookie(c, account!.id, account!.email);

  if (from) return c.redirect(`/portal/${from}`);
  // Redirect to their most recent quote
  const quotes = getQuotesByAccountId(account!.id);
  if (quotes.length) return c.redirect(`/portal/${quotes[0]!.client_token}`);
  return c.redirect("/portal/me");
});

portalRoutes.get("/logout", async (c) => {
  // Revocación server-side: aunque el browser no borre la cookie, el JWT queda inválido
  const session = await getClientAuth(c);
  if (session) revokeClientSessions(session.accountId);
  console.log("[portal/logout] sesión revocada:", session?.accountId ?? "ninguna");
  setCookie(c, "client_session", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
  return c.redirect("/portal/login");
});

portalRoutes.get("/me", async (c) => {
  const session = await getClientAuth(c);
  if (!session) return c.redirect("/portal/login");
  const quotes = getQuotesByAccountId(session.accountId);
  if (quotes.length === 1) return c.redirect(`/portal/${quotes[0]!.client_token}`);
  const config = getConfig();
  const profile = getClientProfile(session.accountId);

  const content = `
    <div style="display:flex;min-height:100vh">
      ${prtSidebar("", session, profile, "pedidos", config)}
      <div class="prt-main">
        <header class="prt-topbar"><h2><i class="fas fa-columns" style="color:#ef4444"></i> Mis Pedidos</h2></header>
        <div class="prt-content">
          <div style="max-width:640px;margin:0 auto">
            <p class="prt-label" style="margin-bottom:.75rem">Selecciona un pedido</p>
            <div class="prt-items">
              ${quotes.map((q) => `
                <a href="/portal/${esc(q.client_token ?? "")}" style="text-decoration:none;">
                  <div class="prt-item" style="cursor:pointer;transition:all .15s" onmouseover="this.style.borderColor='#ef4444'" onmouseout="this.style.borderColor='#1e293b'">
                    <div class="prt-item-header">
                      <span class="prt-item-name">Pedido #${q.id}</span>
                      <span class="prt-badge prt-badge-${esc(q.status)}">${esc(statusLabel[q.status] ?? q.status)}</span>
                    </div>
                    <div style="font-size:.78rem;color:#94a3b8">${fmtDate(q.created_at)} · ${q.total_pieces} piezas</div>
                  </div>
                </a>
              `).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>`;
  return c.html(portalLayout("Mis pedidos", content, config));
});

// ── Registro: POST /:token/register ──────────────────────────────────────────

portalRoutes.post("/:token/register", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();

  const body = await c.req.parseBody() as Record<string, unknown>;
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const confirm = String(body.confirm_password || "");
  const config = getConfig();

  const renderError = (msg: string) => {
    const items = getPortalItems(quote.id);
    const content = registrationPage(token, quote, items, config, msg);
    return c.html(Layout(`Registrar cuenta — Pedido #${quote.id}`, content, config, undefined, undefined, portalCss(config)));
  };

  if (password !== confirm) return renderError("Las contraseñas no coinciden.");
  if (password.length < 8) return renderError("La contraseña debe tener al menos 8 caracteres.");
  if (!email.includes("@")) return renderError("Ingresa un email válido.");

  // If token already claimed by a different account → reject
  if (quote.client_account_id !== null) {
    return renderError("Este pedido ya fue reclamado. <a href='/portal/login'>Inicia sesión</a> para acceder.");
  }

  const existing = getClientAccountByEmail(email);
  if (existing) {
    // Email already registered: link this quote to their existing account (they need to verify ownership via login)
    return renderError(`Este email ya tiene una cuenta. <a href="/portal/login?from=${token}">Inicia sesión</a> para vincular este pedido.`);
  }

  const hash = await Bun.password.hash(password);
  const accountId = createClientAccount(email, hash);
  linkQuoteToAccount(quote.id, accountId);

  await setClientCookie(c, accountId, email);
  return c.redirect(`/portal/${token}`);
});

// ── Helpers de render ─────────────────────────────────────────────────────────

function registrationPage(token: string, quote: any, items: any[], config: any, error = "") {
  return `
    <div class="prt-auth-wrap">
      <div class="prt-card">
        <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:1rem">
          <div style="width:2.25rem;height:2.25rem;border-radius:.5rem;background:linear-gradient(135deg,#ef4444,#e11d48);display:flex;align-items:center;justify-content:center;box-shadow:0 0 12px rgba(239,68,68,.25)">
            <svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor"/><path d="M2 17L12 22L12 12L2 7V17Z" fill="currentColor" fill-opacity=".8"/><path d="M22 17L12 22L12 12L22 7V17Z" fill="currentColor" fill-opacity=".6"/></svg>
          </div>
          <div><div style="font-size:1.05rem;font-weight:800;color:white">Pixkey 3D</div><span style="font-size:.55rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#ef4444">Portal de Clientes</span></div>
        </div>
        <h1 style="font-size:1.3rem;font-weight:800;color:white;margin:0 0 .25rem">Crea tu cuenta</h1>
        <p style="font-size:.85rem;color:#94a3b8;margin:0 0 1rem">Para ver el seguimiento de tu pedido en tiempo real.</p>
        <div class="prt-order-preview">
          <div style="font-size:.65rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin-bottom:.5rem">Tu pedido</div>
          <div style="font-weight:700;color:white">Pedido #${quote.id}</div>
          <div style="font-size:.78rem;color:#94a3b8;margin-top:.25rem">${items.map((i: any) => esc(i.product_name)).join(" · ")}</div>
          <div style="font-size:.78rem;color:#94a3b8">${quote.total_pieces} piezas</div>
        </div>
        ${error ? `<div class="prt-error">${error}</div>` : ""}
        <form method="post" action="/portal/${esc(token)}/register" class="prt-form">
          <div class="prt-field"><label class="prt-label">Email</label><input class="prt-input" type="email" name="email" required autocomplete="email"></div>
          <div class="prt-field"><label class="prt-label">Contrase&ntilde;a</label><input class="prt-input" type="password" name="password" minlength="8" required autocomplete="new-password"><span style="font-size:.72rem;color:#64748b">M&iacute;nimo 8 caracteres</span></div>
          <div class="prt-field"><label class="prt-label">Confirmar contrase&ntilde;a</label><input class="prt-input" type="password" name="confirm_password" required autocomplete="new-password"></div>
          <button type="submit" class="prt-btn prt-btn-primary" style="width:100%">Registrarme y ver mi pedido</button>
        </form>
        <p style="font-size:.78rem;color:#94a3b8;margin-top:1rem;text-align:center">&iquest;Ya tienes cuenta? <a href="/portal/login?from=${esc(token)}" style="color:#ef4444;font-weight:600">Inicia sesi&oacute;n</a></p>
      </div>
    </div>`;
}

// ── Portal principal: GET /:token ─────────────────────────────────────────────

portalRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();

  const config = getConfig();
  const items = getPortalItems(quote.id);

  // Not yet claimed → show registration
  if (quote.client_account_id === null) {
    const content = registrationPage(token, quote, items, config);
    return c.html(Layout(`Registrar cuenta — Pedido #${quote.id}`, content, config, undefined, undefined, portalCss(config)));
  }

  // Claimed → require login
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) {
    return c.redirect(`/portal/login?from=${token}`);
  }

  // Authenticated — render portal
  const payments = getPortalPayments(quote.id);
  const profile = getClientProfile(session.accountId);
  const inProduction = quote.status === "produccion" || quote.status === "finalizado";
  const isShipped = !!(quote.shipping_tracking_number);
  const hasAnticipo = !!(quote.payment_proof_url);
  const hasFinalPayment = !!(quote.payment_proof_url_final);

  const ms2Done = hasAnticipo;
  const ms2Current = !hasAnticipo && quote.status === "despachado";
  const ms3Done = hasFinalPayment;
  const ms3Current = quote.status === "produccion";
  const ms4Done = hasFinalPayment && isShipped;
  const ms4Current = hasFinalPayment && !isShipped;

  const itemsHtml = inProduction ? `
    <p class="prt-label" style="margin:1.25rem 0 .5rem">Progreso por modelo</p>
    <div class="prt-items">
      ${items.map((item) => {
        const pct = item.quantity > 0 ? Math.min(100, Math.round((item.printed_quantity / item.quantity) * 100)) : 0;
        return `<div class="prt-item">
          <div class="prt-item-header">
            <span class="prt-item-name">${esc(item.product_name)}</span>
            <span class="prt-item-count">${item.printed_quantity} de ${item.quantity}</span>
          </div>
          <div class="prt-progress-track"><div class="prt-progress-fill" style="width:${pct}%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:.65rem;color:#64748b;margin-top:.35rem">
            <span>${pct}% completado</span>
            <span>${item.printed_quantity} / ${item.quantity} piezas</span>
          </div>
        </div>`;
      }).join("")}
    </div>` : "";

  const paymentsHtml = payments.length ? `
    <p class="prt-label" style="margin:1rem 0 .5rem">Pagos registrados</p>
    <div class="prt-items">
      ${payments.map((p) => `<div class="prt-item">
        <div class="prt-item-header">
          <span style="color:#10b981;font-weight:700">${currency.format(p.amount)}</span>
          <span class="prt-item-count">${fmtDate(p.date)} · ${esc(p.payment_method)}</span>
        </div>
      </div>`).join("")}
    </div>` : "";

  const waPhone = config.quote_whatsapp_number?.replace(/\D/g, "").replace(/^(\d{10})$/, "52$1") || "521234567890";
  const waLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(`Hola, soy ${esc(session.email)}, quiero información sobre mi Pedido #${quote.id}`)}`;

  const sidebarHtml = prtSidebar(token, session, profile, "pedidos", config);

  const content = `
    <div style="display:flex;min-height:100vh">
      ${sidebarHtml}
      <div class="prt-main">
        <header class="prt-topbar">
          <h2><i class="fas fa-columns" style="color:#ef4444"></i> Panel de Cliente</h2>
          ${isShipped ? `
          <div style="display:flex;gap:.5rem">
            <a href="/portal/${esc(token)}" class="prt-btn prt-btn-ghost" style="padding:.4rem .85rem;font-size:.75rem">Resumen</a>
            <a href="/portal/${esc(token)}/tracking" class="prt-btn prt-btn-ghost" style="padding:.4rem .85rem;font-size:.75rem">Rastreo</a>
          </div>` : ""}
        </header>
        <div class="prt-content">
          <section id="tab-pedidos">
            <div class="prt-hero" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:1.5rem">
              <div>
                <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
                  <span style="font-size:1.6rem;font-weight:800;color:white">Pedido #${quote.id}</span>
                  <span class="prt-badge prt-badge-${esc(quote.status)}"><span style="width:.45rem;height:.45rem;border-radius:50%;background:currentColor;${quote.status === "produccion" ? "animation:pulse 2s infinite" : ""}"></span> ${esc(statusLabel[quote.status] ?? quote.status)}</span>
                </div>
                <p style="font-size:.85rem;color:#64748b;margin-top:.35rem">Consulte el estado de fabricaci&oacute;n y despacho de sus piezas.</p>
              </div>
              <a href="${esc(waLink)}" target="_blank" class="prt-btn prt-btn-primary" style="text-decoration:none;font-size:.8rem"><i class="fab fa-whatsapp"></i> Consultar por WhatsApp</a>
            </div>

            <div class="prt-metrics">
              <div class="prt-card prt-card-hover prt-card-glow">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
                  <span class="prt-label">Cliente</span>
                  <span class="prt-metric-icon"><i class="fas fa-user"></i></span>
                </div>
                <div style="font-size:1.1rem;font-weight:700;color:white">${esc(quote.customer_name)}</div>
                <div style="font-size:.8rem;color:#94a3b8">${fmtDate(quote.created_at)}</div>
                <div style="margin-top:.75rem;padding-top:.5rem;border-top:1px solid #1e293b;display:flex;justify-content:space-between;font-size:.7rem;color:#64748b">
                  <span>Servicio</span>
                  <span style="font-weight:600;color:#ef4444">${esc(quote.service_type === "minorista" ? "Minorista" : "Mayorista")}</span>
                </div>
              </div>
              <div class="prt-card prt-card-hover prt-card-glow">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
                  <span class="prt-label">Cronolog&iacute;a</span>
                  <span class="prt-metric-icon"><i class="fas fa-calendar-alt"></i></span>
                </div>
                <div style="font-size:1.1rem;font-weight:700;color:white">${fmtDate(quote.created_at)}</div>
                <div style="font-size:.8rem;color:#94a3b8">Total de piezas: <strong style="color:#e2e8f0">${quote.total_pieces}</strong></div>
                <div style="margin-top:.75rem;padding-top:.5rem;border-top:1px solid #1e293b;display:flex;justify-content:space-between;font-size:.7rem;color:#64748b">
                  <span>Total</span>
                  <span style="font-weight:700;color:#10b981">${currency.format(quote.grand_total)}</span>
                </div>
              </div>
              <div class="prt-card prt-card-hover prt-card-glow">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
                  <span class="prt-label">Pagos</span>
                  <span class="prt-metric-icon"><i class="fas fa-wallet"></i></span>
                </div>
                <div style="font-size:1.1rem;font-weight:700;color:#10b981">${hasFinalPayment ? "Liquidado" : hasAnticipo ? "Anticipo recibido" : "Pendiente"}</div>
                <div style="font-size:.8rem;color:#94a3b8">${payments.length} pago${payments.length !== 1 ? "s" : ""} registrado${payments.length !== 1 ? "s" : ""}</div>
                <div style="margin-top:.75rem;padding-top:.5rem;border-top:1px solid #1e293b;display:flex;justify-content:space-between;font-size:.7rem;color:#64748b">
                  <span>Estado</span>
                  <span style="font-weight:600;color:${hasFinalPayment ? "#10b981" : hasAnticipo ? "#fbbf24" : "#94a3b8"}">${hasFinalPayment ? "Pagado" : hasAnticipo ? "Anticipo" : "Pendiente"}</span>
                </div>
              </div>
            </div>

            <div class="prt-card" style="margin-top:1.5rem">
              <h3 style="font-size:.95rem;font-weight:700;color:white;margin:0 0 1rem;display:flex;align-items:center;gap:.5rem"><i class="fas fa-route" style="color:#ef4444"></i> Seguimiento del Pedido</h3>
              <div class="prt-timeline">
                ${milestone(true, false, "Pedido recibido", fmtDate(quote.created_at))}
                ${milestone(ms2Done, ms2Current, "Anticipo confirmado", ms2Done ? `Pago registrado · ${currency.format(payments[0]?.amount ?? 0)}` : "Pendiente de confirmación")}
                ${milestone(ms3Done || ms3Current, ms3Current, "En producción", ms3Current ? "Tu pedido está siendo impreso" : ms3Done ? "Producción completada" : "Inicia tras confirmar anticipo")}
                ${inProduction ? itemsHtml : ""}
                ${milestone(ms4Done || ms4Current, ms4Current, "En espera de liquidación", ms4Current ? "Producción lista, pendiente de pago final" : ms4Done ? "Liquidación confirmada" : "")}
                ${milestone(isShipped, !isShipped && hasFinalPayment, "Enviado", isShipped ? `Guía: ${esc(quote.shipping_tracking_number ?? "")} · ${esc(quote.shipping_provider || "Paquetería")}` : "Pendiente de envío")}
              </div>
              ${paymentsHtml}
            </div>
          </section>
        </div>
      </div>
    </div>`;

  return c.html(portalLayout(`Pedido #${quote.id}`, content, config));
});

// ── Tracking: GET /:token/tracking ────────────────────────────────────────────

portalRoutes.get("/:token/tracking", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);

  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);

  const config = getConfig();
  const profile = getClientProfile(session.accountId);
  const sidebarHtml = prtSidebar(token, session, profile, "pedidos", config);

  const content = `
    <div style="display:flex;min-height:100vh">
      ${sidebarHtml}
      <div class="prt-main">
        <header class="prt-topbar">
          <h2><i class="fas fa-truck" style="color:#ef4444"></i> Rastreo de Env&iacute;o</h2>
        </header>
        <div class="prt-content">
          <div style="max-width:720px;margin:0 auto">
            <div class="prt-card" style="margin-bottom:1rem">
              <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem">
                <span style="font-size:1.3rem;font-weight:800;color:white">Pedido #${quote.id}</span>
                <a href="/portal/${esc(token)}" class="prt-btn prt-btn-ghost" style="padding:.4rem .85rem;font-size:.75rem;text-decoration:none"><i class="fas fa-arrow-left"></i> Volver al resumen</a>
              </div>
              ${quote.shipping_tracking_number ? `<p style="font-size:.85rem;color:#94a3b8;margin:.5rem 0 0">Gu&iacute;a <strong style="color:#e2e8f0">${esc(quote.shipping_tracking_number)}</strong> · ${esc(quote.shipping_provider || "Paquetería")}</p>` : ""}
            </div>
            ${quote.shipping_tracking_url
              ? `<iframe src="${esc(quote.shipping_tracking_url)}" class="prt-tracking-frame" title="Rastreo de envío" sandbox="allow-scripts allow-same-origin allow-forms" loading="lazy"></iframe>`
              : `<div class="prt-card" style="text-align:center;padding:3rem">
                   <p style="font-size:2.5rem;margin-bottom:.5rem">📦</p>
                   <p style="font-weight:700;color:white;font-size:1.1rem">Env&iacute;o pendiente</p>
                   <p style="font-size:.85rem;color:#94a3b8;margin-top:.5rem">Te notificaremos cuando tu pedido sea enviado.</p>
                 </div>`}
          </div>
        </div>
      </div>
    </div>`;

  return c.html(portalLayout(`Rastreo — Pedido #${quote.id}`, content, config));
});

// ── Configuración: GET /:token/configuracion ──────────────────────────────────

portalRoutes.get("/:token/configuracion", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);
  const config = getConfig();
  const profile = getClientProfile(session.accountId);
  const success = c.req.query("saved") === "1";

  const sidebarHtml = prtSidebar(token, session, profile, "config", config);
  const content = `
    <div style="display:flex;min-height:100vh">
      ${sidebarHtml}
      <div class="prt-main">
        <header class="prt-topbar"><h2><i class="fas fa-sliders-h" style="color:#ef4444"></i> Configuraci&oacute;n</h2></header>
        <div class="prt-content">
          <div style="max-width:640px;margin:0 auto">
            <div class="prt-card">
              <h3 style="font-size:1.1rem;font-weight:700;color:white;margin:0 0 .25rem">Mi perfil</h3>
              <p style="font-size:.8rem;color:#94a3b8;margin:0 0 1.25rem">Administra tus datos personales y preferencias.</p>
              ${success ? `<div class="prt-success" style="margin-bottom:1rem">Cambios guardados correctamente.</div>` : ""}
              <form method="post" action="/portal/${esc(token)}/configuracion" class="prt-form">
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
                  <div class="prt-field"><label class="prt-label">Nombre completo</label><input class="prt-input" type="text" name="full_name" value="${esc(profile.full_name)}"></div>
                  <div class="prt-field"><label class="prt-label">Tel&eacute;fono</label><input class="prt-input" type="text" name="phone" value="${esc(profile.phone)}" placeholder="+52 555 123 4567"></div>
                </div>
                <div class="prt-field"><label class="prt-label">Direcci&oacute;n</label><input class="prt-input" type="text" name="address" value="${esc(profile.address)}" placeholder="Calle, colonia, ciudad, c&oacute;digo postal"></div>
                <div style="border-top:1px solid #1e293b;padding-top:1rem">
                  <p class="prt-label" style="margin-bottom:.75rem">Notificaciones</p>
                  <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer;margin-bottom:.5rem">
                    <input type="checkbox" name="notify_whatsapp" value="1" ${profile.notify_whatsapp ? "checked" : ""} style="accent-color:#ef4444;width:1rem;height:1rem">
                    <span style="font-size:.85rem;color:#e2e8f0">Recibir notificaciones por WhatsApp cuando avance mi pedido</span>
                  </label>
                  <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
                    <input type="checkbox" name="notify_email" value="1" ${profile.notify_email ? "checked" : ""} style="accent-color:#ef4444;width:1rem;height:1rem">
                    <span style="font-size:.85rem;color:#e2e8f0">Recibir notificaciones por correo electr&oacute;nico</span>
                  </label>
                </div>
                <div style="display:flex;gap:.75rem;justify-content:flex-end;padding-top:.5rem">
                  <button type="submit" class="prt-btn prt-btn-primary">Guardar cambios</button>
                </div>
              </form>
            </div>
            <div class="prt-card" style="margin-top:1.5rem">
              <h3 style="font-size:1.1rem;font-weight:700;color:white;margin:0 0 .25rem">Cambiar contrase&ntilde;a</h3>
              <p style="font-size:.8rem;color:#94a3b8;margin:0 0 1.25rem">Actualiza tu contrase&ntilde;a de acceso al portal.</p>
              <form method="post" action="/portal/${esc(token)}/configuracion/password" class="prt-form">
                <div class="prt-field"><label class="prt-label">Nueva contrase&ntilde;a</label><input class="prt-input" type="password" name="password" minlength="8" required><span style="font-size:.7rem;color:#64748b;margin-top:.15rem">M&iacute;nimo 8 caracteres</span></div>
                <div class="prt-field"><label class="prt-label">Confirmar contrase&ntilde;a</label><input class="prt-input" type="password" name="confirm_password" required></div>
                <div style="display:flex;justify-content:flex-end">
                  <button type="submit" class="prt-btn prt-btn-primary">Cambiar contrase&ntilde;a</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  return c.html(portalLayout("Configuración", content, config));
});

portalRoutes.post("/:token/configuracion", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);

  const body = await c.req.parseBody() as Record<string, unknown>;
  updateClientProfile(session.accountId, {
    full_name: String(body.full_name || "").trim(),
    phone: String(body.phone || "").trim(),
    address: String(body.address || "").trim(),
    notify_whatsapp: body.notify_whatsapp === "1" ? 1 : 0,
    notify_email: body.notify_email === "1" ? 1 : 0,
  });
  return c.redirect(`/portal/${esc(token)}/configuracion?saved=1`);
});

portalRoutes.post("/:token/configuracion/password", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);

  const body = await c.req.parseBody() as Record<string, unknown>;
  const password = String(body.password || "");
  const confirm = String(body.confirm_password || "");
  if (password.length < 8 || password !== confirm) return c.redirect(`/portal/${esc(token)}/configuracion?saved=0`);

  const hash = await Bun.password.hash(password);
  updateClientPassword(session.accountId, hash);
  revokeClientSessions(session.accountId);
  return c.redirect("/portal/login");
});

// ── Soporte: GET /:token/soporte ─────────────────────────────────────────────

portalRoutes.get("/:token/soporte", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);
  const config = getConfig();
  const profile = getClientProfile(session.accountId);

  const waPhone = config.quote_whatsapp_number?.replace(/\D/g, "").replace(/^(\d{10})$/, "52$1") || "521234567890";
  const waLink = `https://wa.me/${waPhone}?text=${encodeURIComponent(`Hola, soy ${esc(session.email)}, quiero consultar sobre mi Pedido #${quote.id}\n\nNombre: ${esc(profile.full_name || "")}\nTeléfono: ${esc(profile.phone || "")}`)}`;
  const emailLink = `mailto:soporte@pixkey3d.com?subject=Consulta%20Pedido%20%23${quote.id}`;

  const sidebarHtml = prtSidebar(token, session, profile, "soporte", config);
  const content = `
    <div style="display:flex;min-height:100vh">
      ${sidebarHtml}
      <div class="prt-main">
        <header class="prt-topbar"><h2><i class="fas fa-headset" style="color:#ef4444"></i> Soporte T&eacute;cnico</h2></header>
        <div class="prt-content">
          <div style="max-width:720px;margin:0 auto">
            <div class="prt-card" style="margin-bottom:1rem">
              <h3 style="font-size:1.1rem;font-weight:700;color:white;margin:0 0 .25rem">Centro de Soporte</h3>
              <p style="font-size:.85rem;color:#94a3b8;margin:0 0 1.25rem">&iquest;Tienes dudas sobre tu pedido, materiales o dise&ntilde;o? Estamos para ayudarte.</p>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem">
                <a href="${esc(waLink)}" target="_blank" style="display:block;background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:1.25rem;text-align:center;text-decoration:none;transition:all .15s" onmouseover="this.style.borderColor='#22c55e'" onmouseout="this.style.borderColor='#1e293b'">
                  <i class="fab fa-whatsapp" style="font-size:2rem;color:#22c55e;margin-bottom:.5rem;display:block"></i>
                  <h4 style="font-size:.85rem;font-weight:700;color:white;margin:0 0 .25rem">WhatsApp Express</h4>
                  <p style="font-size:.75rem;color:#94a3b8;margin:0">Soporte r&aacute;pido para tus pedidos</p>
                  <span style="font-size:.7rem;color:#22c55e;font-weight:600;margin-top:.5rem;display:block">Iniciar chat &rarr;</span>
                </a>
                <a href="${esc(emailLink)}" style="display:block;background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:1.25rem;text-align:center;text-decoration:none;transition:all .15s" onmouseover="this.style.borderColor='#ef4444'" onmouseout="this.style.borderColor='#1e293b'">
                  <i class="far fa-envelope" style="font-size:2rem;color:#ef4444;margin-bottom:.5rem;display:block"></i>
                  <h4 style="font-size:.85rem;font-weight:700;color:white;margin:0 0 .25rem">Correo Directo</h4>
                  <p style="font-size:.75rem;color:#94a3b8;margin:0">Consultas t&eacute;cnicas detalladas</p>
                  <span style="font-size:.7rem;color:#ef4444;font-weight:600;margin-top:.5rem;display:block">soporte@pixkey3d.com &rarr;</span>
                </a>
                <div style="background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;padding:1.25rem;text-align:center">
                  <i class="fas fa-book-open" style="font-size:2rem;color:#818cf8;margin-bottom:.5rem;display:block"></i>
                  <h4 style="font-size:.85rem;font-weight:700;color:white;margin:0 0 .25rem">Gu&iacute;as de Dise&ntilde;o</h4>
                  <p style="font-size:.75rem;color:#94a3b8;margin:0">Tolerancias, paredes y m&aacute;s</p>
                  <span style="font-size:.7rem;color:#818cf8;font-weight:600;margin-top:.5rem;display:block">Pr&oacute;ximamente</span>
                </div>
              </div>
            </div>
            <div class="prt-card">
              <h3 style="font-size:.9rem;font-weight:700;color:white;margin:0 0 1rem;text-transform:uppercase;letter-spacing:.05em">Abrir ticket de consulta</h3>
              <form method="post" action="/portal/${esc(token)}/soporte" class="prt-form">
                <div class="prt-field"><label class="prt-label">Asunto</label><input class="prt-input" type="text" name="subject" placeholder="Ej: Cambiar tolerancias del dise&ntilde;o" required></div>
                <div class="prt-field"><label class="prt-label">Mensaje</label><textarea class="prt-input" name="message" rows="4" placeholder="Describe tu consulta con el mayor detalle posible..." required style="resize:vertical"></textarea></div>
                <div style="display:flex;justify-content:flex-end">
                  <button type="submit" class="prt-btn prt-btn-primary">Enviar ticket</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  return c.html(portalLayout("Soporte", content, config));
});

portalRoutes.post("/:token/soporte", async (c) => {
  const token = c.req.param("token");
  const quote = getQuoteByClientToken(token);
  if (!quote || quote.status === "spam") return c.notFound();
  if (quote.client_account_id === null) return c.redirect(`/portal/${token}`);
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) return c.redirect(`/portal/login?from=${token}`);
  const config = getConfig();
  const profile = getClientProfile(session.accountId);

  const body = await c.req.parseBody() as Record<string, unknown>;
  const subject = String(body.subject || "").trim();
  const message = String(body.message || "").trim();

  // Enviar por WhatsApp al admin con los datos del ticket
  const waPhone = config.quote_whatsapp_number?.replace(/\D/g, "").replace(/^(\d{10})$/, "52$1") || "521234567890";
  const waMsg = encodeURIComponent(
    `*Nuevo ticket de soporte - Portal Clientes*\n\nPedido: #${quote.id}\nCliente: ${session.email}\nNombre: ${profile.full_name || "—"}\nTel: ${profile.phone || "—"}\n\n*Asunto:* ${subject}\n*Mensaje:* ${message}`
  );
  return c.redirect(`https://wa.me/${waPhone}?text=${waMsg}`);
});

// ── Sidebar helper ────────────────────────────────────────────────────────────

function prtSidebar(token: string, session: ClientSession, profile: { full_name: string }, active: string, config: Record<string, string>) {
  const hasToken = token.length > 0;
  const links = hasToken ? [
    { tab: "pedidos", href: `/portal/${esc(token)}`, icon: "fa-box-open", label: "Mis Pedidos" },
    { tab: "config", href: `/portal/${esc(token)}/configuracion`, icon: "fa-sliders-h", label: "Configuraci&oacute;n" },
    { tab: "soporte", href: `/portal/${esc(token)}/soporte`, icon: "fa-headset", label: "Soporte T&eacute;cnico" },
  ] : [];
  const logoHtml = config.company_logo
    ? `<img src="${esc(config.company_logo)}" alt="Logo" class="prt-logo-img">`
    : `<div class="prt-logo-fallback"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7L12 12L22 7L12 2Z" fill="white"/><path d="M2 17L12 22L12 12L2 7V17Z" fill="white" fill-opacity=".8"/><path d="M22 17L12 22L12 12L22 7V17Z" fill="white" fill-opacity=".6"/></svg></div>`;
  const companyName = esc(config.company_name || "Pixkey 3D");
  return `
    <aside class="prt-sidebar" id="prt-sidebar">
      <div class="prt-logo">
        ${logoHtml}
        <div><div class="prt-logo-text">${companyName}</div><span class="prt-logo-sub">Portal de Clientes</span></div>
      </div>
      ${hasToken ? `<nav class="prt-nav">
        ${links.map((l) => `<a href="${l.href}" class="prt-nav-link${active === l.tab ? " active" : ""}"><i class="fas ${l.icon}"></i> ${l.label}</a>`).join("")}
      </nav>` : `<div style="flex:1"></div>`}
      <div class="prt-user-card">
        <div style="display:flex;align-items:center;gap:.65rem;margin-bottom:.65rem">
          <div class="prt-user-avatar">${(esc(session.email)[0] || "?").toUpperCase()}</div>
          <div style="overflow:hidden"><div style="font-size:.8rem;font-weight:600;color:#e2e8f0">${esc(profile.full_name || session.email)}</div><div style="font-size:.68rem;color:#64748b">${esc(session.email)}</div></div>
        </div>
        <a href="/portal/logout" style="display:block;text-align:center;padding:.5rem;border-radius:.5rem;background:#0f172a;border:1px solid #1e293b;color:#ef4444;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;text-decoration:none" onmouseover="this.style.background='rgba(239,68,68,.1)'" onmouseout="this.style.background='#0f172a'"><i class="fas fa-sign-out-alt" style="margin-right:.35rem"></i> Cerrar sesión</a>
      </div>
    </aside>`;
}
