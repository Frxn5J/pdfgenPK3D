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

const portalCss = `
<style>
  .prt-wrap { max-width: 720px; margin: 2rem auto; padding: 0 1rem 4rem; font-family: var(--font-body); }
  .prt-auth-wrap { max-width: 420px; margin: 4rem auto; padding: 0 1rem; font-family: var(--font-body); }
  .prt-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius); padding: 1.5rem; box-shadow: var(--card-shadow); }
  .prt-badge { display:inline-block; font-size:.65rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; padding:.25rem .75rem; border-radius:999px; }
  .prt-badge-produccion,.prt-badge-despachado{background:#dbeafe;color:#1d4ed8}
  .prt-badge-finalizado{background:#dcfce7;color:#15803d}
  .prt-badge-new,.prt-badge-no_despachado{background:#f3f4f6;color:#6b7280}
  .prt-badge-spam{background:#fee2e2;color:#dc2626}
  .prt-order-meta { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:.5rem; margin-bottom:1rem; }
  .prt-order-id { font-size:1.5rem; font-weight:800; color:var(--heading-text); }
  .prt-order-info { display:grid; grid-template-columns:1fr 1fr; gap:.5rem 1.5rem; margin-top:1rem; font-size:.875rem; }
  .prt-info-label { font-size:.65rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted-text); }
  .prt-info-value { color:var(--body-text); font-weight:600; }
  .prt-section-title { font-size:.75rem; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--muted-text); margin:1.75rem 0 .75rem; }
  .prt-timeline { position:relative; padding-left:2.25rem; }
  .prt-timeline::before { content:''; position:absolute; left:.5625rem; top:.75rem; bottom:.75rem; width:2px; background:var(--card-border); }
  .prt-milestone { position:relative; margin-bottom:1.5rem; }
  .prt-milestone:last-child { margin-bottom:0; }
  .prt-dot { position:absolute; left:-2.25rem; top:.125rem; width:1.125rem; height:1.125rem; border-radius:50%; border:2px solid var(--card-border); background:var(--card-bg); display:flex; align-items:center; justify-content:center; font-size:.55rem; font-weight:700; color:white; z-index:1; }
  .prt-dot.done { background:var(--brand-primary); border-color:var(--brand-primary); }
  .prt-dot.current { background:white; border-color:var(--brand-primary); border-width:3px; }
  .prt-milestone-title { font-weight:700; font-size:.9rem; color:var(--heading-text); line-height:1.3; }
  .prt-milestone-title.pending { color:var(--muted-text); font-weight:500; }
  .prt-milestone-sub { font-size:.78rem; color:var(--muted-text); margin-top:.15rem; }
  .prt-items { display:flex; flex-direction:column; gap:.75rem; margin-top:.5rem; }
  .prt-item { background:var(--products-bg); border:1px solid var(--card-border); border-radius:calc(var(--radius)*.75); padding:.875rem 1rem; }
  .prt-item-header { display:flex; justify-content:space-between; align-items:baseline; gap:.5rem; margin-bottom:.5rem; font-size:.875rem; }
  .prt-item-name { font-weight:700; color:var(--heading-text); }
  .prt-item-count { font-size:.75rem; color:var(--muted-text); white-space:nowrap; }
  .prt-progress-track { height:.5rem; background:var(--card-border); border-radius:999px; overflow:hidden; }
  .prt-progress-fill { height:100%; background:var(--brand-primary); border-radius:999px; transition:width .4s ease; }
  .prt-tabs { display:flex; gap:.5rem; border-bottom:1px solid var(--card-border); margin-bottom:1.5rem; }
  .prt-tab { padding:.625rem 1rem; font-size:.75rem; font-weight:700; letter-spacing:.06em; text-transform:uppercase; text-decoration:none; color:var(--muted-text); border-bottom:2px solid transparent; margin-bottom:-1px; transition:color .15s; }
  .prt-tab.active { color:var(--brand-primary); border-bottom-color:var(--brand-primary); }
  .prt-tab:hover { color:var(--heading-text); }
  .prt-tracking-frame { width:100%; height:520px; border:1px solid var(--card-border); border-radius:var(--radius); background:var(--products-bg); }
  .prt-topbar { background:var(--card-bg); border-bottom:1px solid var(--card-border); padding:.625rem 1rem; display:flex; justify-content:flex-end; align-items:center; gap:1rem; font-size:.78rem; color:var(--muted-text); }
  .prt-topbar a { color:var(--brand-primary); text-decoration:none; font-weight:600; }
  .prt-form { display:flex; flex-direction:column; gap:1rem; margin-top:1.5rem; }
  .prt-field { display:flex; flex-direction:column; gap:.35rem; }
  .prt-label { font-size:.75rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--muted-text); }
  .prt-input { border:1px solid var(--card-border); border-radius:calc(var(--radius)*.75); padding:.75rem 1rem; font:inherit; color:var(--body-text); background:var(--card-bg); font-size:.95rem; }
  .prt-input:focus { outline:none; border-color:var(--brand-primary); box-shadow:0 0 0 3px color-mix(in srgb, var(--brand-primary) 15%, transparent); }
  .prt-btn { background:var(--brand-primary); color:white; border:0; border-radius:var(--button-radius); padding:.875rem 1.5rem; font:inherit; font-weight:700; font-size:.875rem; cursor:pointer; transition:filter .15s; }
  .prt-btn:hover { filter:brightness(.88); }
  .prt-error { background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; border-radius:calc(var(--radius)*.75); padding:.75rem 1rem; font-size:.875rem; }
  .prt-order-preview { background:var(--products-bg); border:1px solid var(--card-border); border-radius:calc(var(--radius)*.75); padding:1rem; margin:1rem 0; font-size:.875rem; }
  @media (max-width:600px) {
    .prt-order-info { grid-template-columns:1fr; }
    .prt-tabs { overflow-x:auto; }
  }
</style>
`;

const statusLabel: Record<string, string> = {
  new: "Recibido", no_despachado: "En revisión", despachado: "Aprobado",
  produccion: "En producción", finalizado: "Producción finalizada", spam: "Cancelado",
};

const milestone = (done: boolean, current: boolean, title: string, sub?: string) => `
  <div class="prt-milestone">
    <div class="prt-dot${done ? " done" : current ? " current" : ""}">${done ? "✓" : ""}</div>
    <div class="prt-milestone-title${!done && !current ? " pending" : ""}">${esc(title)}</div>
    ${sub ? `<div class="prt-milestone-sub">${esc(sub)}</div>` : ""}
  </div>`;

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
        <h1 style="font-size:1.5rem;font-weight:800;color:var(--heading-text);margin:0 0 .25rem">Iniciar sesión</h1>
        <p style="font-size:.875rem;color:var(--muted-text);margin:0 0 1.25rem">Portal de seguimiento de pedidos · ${esc(config.company_name || "")}</p>
        ${error === "invalid" ? `<div class="prt-error">Email o contraseña incorrectos.</div>` : ""}
        <form method="post" action="/portal/login" class="prt-form">
          <input type="hidden" name="from" value="${esc(from)}">
          <div class="prt-field"><label class="prt-label">Email</label><input class="prt-input" type="email" name="email" required autocomplete="email"></div>
          <div class="prt-field"><label class="prt-label">Contraseña</label><input class="prt-input" type="password" name="password" required autocomplete="current-password"></div>
          <button type="submit" class="prt-btn">Iniciar sesión</button>
        </form>
      </div>
    </div>`;
  return c.html(Layout(`Iniciar sesión — ${esc(config.company_name || "Portal")}`, content, config, undefined, undefined, portalCss));
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
  if (quotes.length) return c.redirect(`/portal/${quotes[0].client_token}`);
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
  if (quotes.length === 1) return c.redirect(`/portal/${quotes[0].client_token}`);
  // Multiple quotes: list them
  const config = getConfig();
  const content = `
    <div class="prt-wrap">
      <p class="prt-section-title">Mis pedidos</p>
      <div class="prt-items">
        ${quotes.map((q) => `
          <a href="/portal/${esc(q.client_token ?? "")}" style="text-decoration:none;">
            <div class="prt-item" style="cursor:pointer;">
              <div class="prt-item-header">
                <span class="prt-item-name">Pedido #${q.id}</span>
                <span class="prt-badge prt-badge-${esc(q.status)}">${esc(statusLabel[q.status] ?? q.status)}</span>
              </div>
              <div style="font-size:.78rem;color:var(--muted-text)">${fmtDate(q.created_at)} · ${q.total_pieces} piezas</div>
            </div>
          </a>
        `).join("")}
      </div>
    </div>`;
  return c.html(Layout("Mis pedidos", content, config, undefined, undefined, portalCss));
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
    return c.html(Layout(`Registrar cuenta — Pedido #${quote.id}`, content, config, undefined, undefined, portalCss));
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
        <h1 style="font-size:1.4rem;font-weight:800;color:var(--heading-text);margin:0 0 .25rem">Crea tu cuenta</h1>
        <p style="font-size:.875rem;color:var(--muted-text);margin:0 0 1rem">Para ver el seguimiento de tu pedido en tiempo real.</p>
        <div class="prt-order-preview">
          <div style="font-size:.7rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-text);margin-bottom:.5rem">Tu pedido</div>
          <div style="font-weight:700;color:var(--heading-text)">Pedido #${quote.id}</div>
          <div style="font-size:.8rem;color:var(--muted-text);margin-top:.25rem">${items.map((i: any) => esc(i.product_name)).join(" · ")}</div>
          <div style="font-size:.8rem;color:var(--muted-text)">${quote.total_pieces} piezas</div>
        </div>
        ${error ? `<div class="prt-error">${error}</div>` : ""}
        <form method="post" action="/portal/${esc(token)}/register" class="prt-form">
          <div class="prt-field"><label class="prt-label">Email</label><input class="prt-input" type="email" name="email" required autocomplete="email"></div>
          <div class="prt-field"><label class="prt-label">Contraseña</label><input class="prt-input" type="password" name="password" minlength="8" required autocomplete="new-password"><span style="font-size:.72rem;color:var(--muted-text)">Mínimo 8 caracteres</span></div>
          <div class="prt-field"><label class="prt-label">Confirmar contraseña</label><input class="prt-input" type="password" name="confirm_password" required autocomplete="new-password"></div>
          <button type="submit" class="prt-btn">Registrarme y ver mi pedido</button>
        </form>
        <p style="font-size:.78rem;color:var(--muted-text);margin-top:1rem;text-align:center">¿Ya tienes cuenta? <a href="/portal/login?from=${esc(token)}" style="color:var(--brand-primary);font-weight:600">Inicia sesión</a></p>
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
    return c.html(Layout(`Registrar cuenta — Pedido #${quote.id}`, content, config, undefined, undefined, portalCss));
  }

  // Claimed → require login
  const session = await getClientAuth(c);
  if (!session || session.accountId !== quote.client_account_id) {
    return c.redirect(`/portal/login?from=${token}`);
  }

  // Authenticated — render portal
  const payments = getPortalPayments(quote.id);
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
    <p class="prt-section-title">Progreso por modelo</p>
    <div class="prt-items">
      ${items.map((item) => {
        const pct = item.quantity > 0 ? Math.min(100, Math.round((item.printed_quantity / item.quantity) * 100)) : 0;
        return `<div class="prt-item">
          <div class="prt-item-header">
            <span class="prt-item-name">${esc(item.product_name)}</span>
            <span class="prt-item-count">${item.printed_quantity} de ${item.quantity} piezas</span>
          </div>
          <div class="prt-progress-track"><div class="prt-progress-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join("")}
    </div>` : "";

  const paymentsHtml = payments.length ? `
    <p class="prt-section-title">Pagos registrados</p>
    <div class="prt-items">
      ${payments.map((p) => `<div class="prt-item">
        <div class="prt-item-header">
          <span class="prt-item-name">${currency.format(p.amount)}</span>
          <span class="prt-item-count">${fmtDate(p.date)} · ${esc(p.payment_method)}</span>
        </div>
      </div>`).join("")}
    </div>` : "";

  const content = `
    <div class="prt-topbar">
      <span>${esc(session.email)}</span>
      <a href="/portal/logout">Cerrar sesión</a>
    </div>
    <div class="prt-wrap">
      ${isShipped ? `
        <div class="prt-tabs">
          <a class="prt-tab active" href="/portal/${esc(token)}">Resumen</a>
          <a class="prt-tab" href="/portal/${esc(token)}/tracking">Rastreo de envío</a>
        </div>` : ""}
      <div class="prt-card">
        <div class="prt-order-meta">
          <span class="prt-order-id">Pedido #${quote.id}</span>
          <span class="prt-badge prt-badge-${esc(quote.status)}">${esc(statusLabel[quote.status] ?? quote.status)}</span>
        </div>
        <div class="prt-order-info">
          <div><div class="prt-info-label">Cliente</div><div class="prt-info-value">${esc(quote.customer_name)}</div></div>
          <div><div class="prt-info-label">Fecha del pedido</div><div class="prt-info-value">${fmtDate(quote.created_at)}</div></div>
          <div><div class="prt-info-label">Total de piezas</div><div class="prt-info-value">${quote.total_pieces}</div></div>
          <div><div class="prt-info-label">Total</div><div class="prt-info-value">${currency.format(quote.grand_total)}</div></div>
        </div>
      </div>
      <p class="prt-section-title">Seguimiento del pedido</p>
      <div class="prt-card">
        <div class="prt-timeline">
          ${milestone(true, false, "Pedido recibido", fmtDate(quote.created_at))}
          ${milestone(ms2Done, ms2Current, "Anticipo confirmado", ms2Done ? `Pago registrado · ${currency.format(payments[0]?.amount ?? 0)}` : "Pendiente de confirmación de pago")}
          ${milestone(ms3Done || ms3Current, ms3Current, "En producción", ms3Current ? "Tu pedido está siendo impreso" : ms3Done ? "Producción completada" : "Inicia tras confirmar anticipo")}
          ${inProduction ? itemsHtml : ""}
          ${milestone(ms4Done || ms4Current, ms4Current, "En espera de liquidación", ms4Current ? "Producción lista, pendiente de pago final" : ms4Done ? "Liquidación confirmada" : "")}
          ${milestone(isShipped, !isShipped && hasFinalPayment, "Enviado", isShipped ? `Guía: ${esc(quote.shipping_tracking_number ?? "")} · ${esc(quote.shipping_provider || "Paquetería")}` : "Pendiente de envío")}
        </div>
      </div>
      ${paymentsHtml}
    </div>`;

  return c.html(Layout(`Pedido #${quote.id} — ${esc(config.company_name || "Portal")}`, content, config, undefined, undefined, portalCss));
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
  const content = `
    <div class="prt-topbar">
      <span>${esc(session.email)}</span>
      <a href="/portal/logout">Cerrar sesión</a>
    </div>
    <div class="prt-wrap">
      <div class="prt-tabs">
        <a class="prt-tab" href="/portal/${esc(token)}">Resumen</a>
        <a class="prt-tab active" href="/portal/${esc(token)}/tracking">Rastreo de envío</a>
      </div>
      <div class="prt-card">
        <div class="prt-order-meta"><span class="prt-order-id">Pedido #${quote.id}</span></div>
        ${quote.shipping_tracking_number ? `<p style="font-size:.875rem;color:var(--muted-text);margin:.5rem 0 1rem">Guía <strong>${esc(quote.shipping_tracking_number)}</strong> · ${esc(quote.shipping_provider || "Paquetería")}</p>` : ""}
      </div>
      <div style="margin-top:1.5rem">
        ${quote.shipping_tracking_url
          ? `<iframe src="${esc(quote.shipping_tracking_url)}" class="prt-tracking-frame" title="Rastreo de envío" sandbox="allow-scripts allow-same-origin allow-forms" loading="lazy"></iframe>`
          : `<div class="prt-card" style="text-align:center;padding:3rem;color:var(--muted-text)">
               <p style="font-size:2rem;margin-bottom:.5rem">📦</p>
               <p style="font-weight:700;color:var(--heading-text)">Envío pendiente</p>
               <p style="font-size:.875rem;margin-top:.5rem">Te notificaremos cuando tu pedido sea enviado.</p>
             </div>`}
      </div>
    </div>`;

  return c.html(Layout(`Rastreo — Pedido #${quote.id}`, content, config, undefined, undefined, portalCss));
});
