import { db } from "./client";
import type { Quote, QuoteItem } from "./quotes";

export interface ClientAccount {
  id: number;
  email: string;
  password_hash: string;
  session_version: number;
  created_at: string;
}

export function createClientAccount(email: string, passwordHash: string): number {
  db.run(`INSERT INTO client_accounts (email, password_hash) VALUES (?, ?)`, [email, passwordHash]);
  return (db.query<{ id: number }, []>(`SELECT last_insert_rowid() AS id`).get()?.id ?? 0);
}

export function getClientAccountByEmail(email: string): ClientAccount | null {
  return db.query<ClientAccount, [string]>(`SELECT * FROM client_accounts WHERE email = ?`).get(email) ?? null;
}

export function getClientAccountById(id: number): ClientAccount | null {
  return db.query<ClientAccount, [number]>(`SELECT * FROM client_accounts WHERE id = ?`).get(id) ?? null;
}

export function linkQuoteToAccount(quoteId: number, accountId: number): void {
  db.run(`UPDATE quotes SET client_account_id = ? WHERE id = ?`, [accountId, quoteId]);
}

export function getQuotesByAccountId(accountId: number): Quote[] {
  return db.query<Quote, [number]>(`SELECT * FROM quotes WHERE client_account_id = ? ORDER BY created_at DESC`).all(accountId);
}

// ── Sesión de cliente ─────────────────────────────────────────────────────────

export interface ClientSession { accountId: number; email: string; exp: number; sv: number; }

export interface ClientProfile {
  full_name: string;
  phone: string;
  address: string;
  notify_whatsapp: number;
  notify_email: number;
}

export function getClientProfile(accountId: number): ClientProfile {
  const row = db.query<ClientProfile, [number]>(
    `SELECT full_name, phone, address, notify_whatsapp, notify_email FROM client_accounts WHERE id = ?`
  ).get(accountId);
  return row ?? { full_name: "", phone: "", address: "", notify_whatsapp: 1, notify_email: 1 };
}

export function updateClientProfile(accountId: number, profile: Partial<ClientProfile>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(profile)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  if (fields.length === 0) return;
  values.push(accountId);
  db.run(`UPDATE client_accounts SET ${fields.join(", ")} WHERE id = ?`, values as any[]);
}

export function updateClientPassword(accountId: number, newHash: string): void {
  db.run(`UPDATE client_accounts SET password_hash = ? WHERE id = ?`, [newHash, accountId]);
}

export function revokeClientSessions(accountId: number): void {
  db.run(`UPDATE client_accounts SET session_version = session_version + 1 WHERE id = ?`, [accountId]);
}

const clientSecret = (): string => {
  const s = (db.query<{ value: string }, [string]>(`SELECT value FROM config WHERE key = ?`).get("session_secret")?.value || "").trim();
  if (s) return s;
  // Genera y persiste el secreto si aún no existe (mismo patrón que ensureSessionSecret)
  const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
  db.run(`UPDATE config SET value = ? WHERE key = ?`, [generated, "session_secret"]);
  return generated;
};

// Base64 URL-safe (sin +, /, = → sin URL-encoding en cookies)
const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const b64d = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));

export async function signClientSession(accountId: number, email: string): Promise<string> {
  const account = db.query<{ session_version: number }, [number]>(
    `SELECT session_version FROM client_accounts WHERE id = ?`
  ).get(accountId);
  const sv = account?.session_version ?? 1;
  const data: ClientSession = { accountId, email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000, sv };
  const payload = JSON.stringify(data);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clientSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64u(payload) + "." + b64u(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verifyClientSession(cookie: string): Promise<ClientSession | null> {
  try {
    // Acepta tanto base64 URL-safe (nuevo) como base64 estándar URL-encodeado (sesiones antiguas en browsers)
    const decoded = decodeURIComponent(cookie);
    const [pB64, sB64] = decoded.split(".");
    if (!pB64 || !sB64) return null;
    const payload = b64d(pB64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clientSecret()), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(b64d(sB64), (c) => c.charCodeAt(0));
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(payload));
    if (!valid) return null;
    const data: ClientSession = JSON.parse(payload);
    if (data.exp < Date.now()) return null;
    const account = db.query<{ session_version: number }, [number]>(
      `SELECT session_version FROM client_accounts WHERE id = ?`
    ).get(data.accountId);
    if (!account || data.sv !== account.session_version) return null;
    return data;
  } catch { return null; }
}

export interface PortalPayment {
  id: number;
  amount: number;
  payment_method: string;
  date: string;
  notes: string | null;
}

export function getQuoteByClientToken(token: string): Quote | null {
  return db.query<Quote, [string]>(`SELECT * FROM quotes WHERE client_token = ?`).get(token) ?? null;
}

export function generateClientToken(quoteId: number): string {
  const row = db.query<{ client_token: string | null }, [number]>(
    `SELECT client_token FROM quotes WHERE id = ?`
  ).get(quoteId);
  if (row?.client_token) return row.client_token;
  const token = crypto.randomUUID().replace(/-/g, "");
  db.run(`UPDATE quotes SET client_token = ? WHERE id = ?`, [token, quoteId]);
  return token;
}

export function updatePrintedQuantities(quoteId: number, updates: { id: number; qty: number }[]): void {
  const stmt = db.prepare(`UPDATE quote_items SET printed_quantity = ? WHERE id = ? AND quote_id = ?`);
  db.transaction(() => {
    for (const u of updates) stmt.run(Math.max(0, u.qty), u.id, quoteId);
  })();
}

export function updateShippingInfo(quoteId: number, trackingNumber: string, trackingUrl: string): void {
  db.run(
    `UPDATE quotes SET shipping_tracking_number = ?, shipping_tracking_url = ? WHERE id = ?`,
    [trackingNumber || null, trackingUrl || null, quoteId]
  );
}

export function getPortalItems(quoteId: number): QuoteItem[] {
  return db.query<QuoteItem, [number]>(
    `SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id ASC`
  ).all(quoteId);
}

export function getPortalPayments(quoteId: number): PortalPayment[] {
  return db.query<PortalPayment, [number]>(
    `SELECT id, amount, payment_method, date, notes FROM payments WHERE quote_id = ? ORDER BY date ASC`
  ).all(quoteId);
}
