import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { app } from "../src/app";
import { db, initDb } from "../src/db/schema";
import {
  generateClientToken, updatePrintedQuantities, updateShippingInfo,
  getQuoteByClientToken, createClientAccount, linkQuoteToAccount,
  getClientAccountByEmail,
} from "../src/db/portal";
import { signSession } from "../src/lib/session";

let ADMIN: { Cookie: string } = { Cookie: "" };

beforeAll(async () => {
  initDb();
  const token = await signSession({ id: 0, username: "tester", role: "superusuario", exp: Date.now() + 3_600_000 });
  ADMIN = { Cookie: `admin_session=${token}` };
});

afterEach(() => {
  db.run("DELETE FROM quote_items WHERE quote_id IN (SELECT id FROM quotes WHERE customer_name LIKE 'test-%')");
  db.run("DELETE FROM quotes WHERE customer_name LIKE 'test-%'");
  db.run("DELETE FROM client_accounts WHERE email LIKE '%@test.com'");
});

// ── Seed helpers ──────────────────────────────────────────────────────────────
function seedQuote(status = "produccion") {
  db.run(`INSERT INTO quotes (customer_name, postal_code, total_pieces, subtotal, shipping_provider, shipping_cost, grand_total, status)
          VALUES ('test-portal', '78000', 50, 1000, 'Estafeta', 150, 1150, ?)`, [status]);
  const q = db.query<{ id: number }, []>(`SELECT id FROM quotes ORDER BY id DESC LIMIT 1`).get()!;
  db.run(`INSERT INTO quote_items (quote_id, product_name, quantity, unit_price, subtotal, printed_quantity) VALUES (?, 'Llavero Gato', 30, 25, 750, 0)`, [q.id]);
  db.run(`INSERT INTO quote_items (quote_id, product_name, quantity, unit_price, subtotal, printed_quantity) VALUES (?, 'Marco 3D', 20, 12.5, 250, 0)`, [q.id]);
  return q.id;
}

async function seedRegisteredQuote(email = "user@test.com", password = "password123") {
  const qid = seedQuote();
  const token = generateClientToken(qid);
  const hash = await Bun.password.hash(password);
  const accountId = createClientAccount(email, hash);
  linkQuoteToAccount(qid, accountId);
  return { qid, token, accountId, email, password };
}

async function getClientCookie(email: string, password: string, token: string) {
  const res = await app.request("/portal/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&from=${token}`,
  });
  return res.headers.get("set-cookie") ?? "";
}

// ── DB helpers ────────────────────────────────────────────────────────────────
describe("generateClientToken", () => {
  test("genera token único de 32 chars hex", () => {
    const qid = seedQuote();
    expect(generateClientToken(qid)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("idempotente: mismas llamadas retornan el mismo token", () => {
    const qid = seedQuote();
    expect(generateClientToken(qid)).toBe(generateClientToken(qid));
  });
});

describe("updatePrintedQuantities", () => {
  test("actualiza printed_quantity por item", () => {
    const qid = seedQuote();
    const items = db.query<{ id: number }, [number]>(`SELECT id FROM quote_items WHERE quote_id = ?`).all(qid);
    updatePrintedQuantities(qid, [{ id: items[0].id, qty: 15 }]);
    const row = db.query<{ printed_quantity: number }, [number]>(`SELECT printed_quantity FROM quote_items WHERE id = ?`).get(items[0].id)!;
    expect(row.printed_quantity).toBe(15);
  });

  test("clamp: no puede ser negativo", () => {
    const qid = seedQuote();
    const [item] = db.query<{ id: number }, [number]>(`SELECT id FROM quote_items WHERE quote_id = ?`).all(qid);
    updatePrintedQuantities(qid, [{ id: item.id, qty: -5 }]);
    const row = db.query<{ printed_quantity: number }, [number]>(`SELECT printed_quantity FROM quote_items WHERE id = ?`).get(item.id)!;
    expect(row.printed_quantity).toBe(0);
  });
});

describe("updateShippingInfo", () => {
  test("guarda número de guía y URL", () => {
    const qid = seedQuote("finalizado");
    updateShippingInfo(qid, "EST9988", "https://track.example.com");
    const q = db.query<{ shipping_tracking_number: string }, [number]>(`SELECT shipping_tracking_number FROM quotes WHERE id = ?`).get(qid)!;
    expect(q.shipping_tracking_number).toBe("EST9988");
  });
});

// ── Portal no autenticado ─────────────────────────────────────────────────────
describe("GET /portal/:token (sin cuenta)", () => {
  test("token inexistente → 404", async () => {
    const res = await app.request("/portal/00000000000000000000000000000000");
    expect(res.status).toBe(404);
  });

  test("token no reclamado → muestra formulario de registro", async () => {
    const qid = seedQuote();
    const token = generateClientToken(qid);
    const res = await app.request(`/portal/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Crea tu cuenta");
    expect(html).toContain("register");
    expect(html).toContain("Llavero Gato");
  });

  test("token reclamado sin sesión → redirect a login", async () => {
    const { token } = await seedRegisteredQuote();
    const res = await app.request(`/portal/${token}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/portal/login");
  });

  test("cotización spam → 404", async () => {
    const qid = seedQuote("spam");
    const token = generateClientToken(qid);
    const res = await app.request(`/portal/${token}`);
    expect(res.status).toBe(404);
  });
});

// ── Registro ──────────────────────────────────────────────────────────────────
describe("POST /portal/:token/register", () => {
  test("registro exitoso: crea cuenta, linkea pedido y setea cookie", async () => {
    const qid = seedQuote();
    const token = generateClientToken(qid);
    const res = await app.request(`/portal/${token}/register`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=nuevo%40test.com&password=pass1234&confirm_password=pass1234",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("client_session");
    expect(getClientAccountByEmail("nuevo@test.com")).not.toBeNull();
    const q = getQuoteByClientToken(token);
    expect(q?.client_account_id).not.toBeNull();
  });

  test("contraseñas no coinciden → error sin crear cuenta", async () => {
    const qid = seedQuote();
    const token = generateClientToken(qid);
    const res = await app.request(`/portal/${token}/register`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=x%40test.com&password=pass1234&confirm_password=DISTINTO",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no coinciden");
    expect(getClientAccountByEmail("x@test.com")).toBeNull();
  });

  test("contraseña < 8 chars → error", async () => {
    const qid = seedQuote();
    const token = generateClientToken(qid);
    const res = await app.request(`/portal/${token}/register`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=y%40test.com&password=corta&confirm_password=corta",
    });
    const html = await res.text();
    expect(html).toContain("8 caracteres");
  });

  test("token ya reclamado → error", async () => {
    const { token } = await seedRegisteredQuote("a@test.com");
    const res = await app.request(`/portal/${token}/register`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=b%40test.com&password=pass1234&confirm_password=pass1234",
    });
    const html = await res.text();
    expect(html).toContain("ya fue reclamado");
  });

  test("email ya registrado → invita a hacer login", async () => {
    const { token } = await seedRegisteredQuote("dup@test.com");
    const qid2 = seedQuote();
    const token2 = generateClientToken(qid2);
    const res = await app.request(`/portal/${token2}/register`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=dup%40test.com&password=pass1234&confirm_password=pass1234",
    });
    const html = await res.text();
    expect(html).toContain("Inicia sesión");
  });
});

// ── Login / Logout ────────────────────────────────────────────────────────────
describe("POST /portal/login", () => {
  test("credenciales válidas → cookie de sesión + redirect", async () => {
    const { email, password, token } = await seedRegisteredQuote("login@test.com");
    const res = await app.request("/portal/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&from=${token}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("client_session");
    expect(res.headers.get("location")).toContain(token);
  });

  test("contraseña incorrecta → redirect con error=invalid", async () => {
    const { email, token } = await seedRegisteredQuote("bad@test.com");
    const res = await app.request("/portal/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `email=${encodeURIComponent(email)}&password=WRONGPASS&from=${token}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=invalid");
  });
});

describe("GET /portal/logout", () => {
  test("limpia cookie y redirige a login", async () => {
    const res = await app.request("/portal/logout");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/portal/login");
  });
});

// ── Portal autenticado ────────────────────────────────────────────────────────
describe("GET /portal/:token (autenticado)", () => {
  test("muestra el portal con el timeline", async () => {
    const { email, password, token } = await seedRegisteredQuote("view@test.com");
    const cookie = await getClientCookie(email, password, token);
    const res = await app.request(`/portal/${token}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("prt-timeline");
    expect(html).toContain("view@test.com");
    expect(html).toContain("Cerrar sesión");
  });

  test("muestra barras de progreso en producción", async () => {
    const { token } = await seedRegisteredQuote("prog@test.com");
    const cookie = await getClientCookie("prog@test.com", "password123", token);
    const res = await app.request(`/portal/${token}`, { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain("prt-progress-fill");
  });

  test("cuenta diferente a la del pedido → redirect a login", async () => {
    const { token } = await seedRegisteredQuote("owner@test.com");
    // Crea otra cuenta y loguea con ella
    const qid2 = seedQuote();
    const token2 = generateClientToken(qid2);
    const hash = await Bun.password.hash("password123");
    createClientAccount("other@test.com", hash);
    const cookie = await getClientCookie("other@test.com", "password123", token2);
    // Intenta acceder al pedido de owner con sesión de other
    const res = await app.request(`/portal/${token}`, { headers: { cookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/portal/login");
  });
});

// ── Admin endpoints ───────────────────────────────────────────────────────────
describe("POST /admin/production/:id/progress", () => {
  test("actualiza printed_quantity y redirige", async () => {
    const qid = seedQuote("produccion");
    const [item] = db.query<{ id: number }, [number]>(`SELECT id FROM quote_items WHERE quote_id = ?`).all(qid);
    const res = await app.request(`/admin/production/${qid}/progress`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/x-www-form-urlencoded" },
      body: `qty_${item.id}=18`,
    });
    expect(res.status).toBe(302);
    const row = db.query<{ printed_quantity: number }, [number]>(`SELECT printed_quantity FROM quote_items WHERE id = ?`).get(item.id)!;
    expect(row.printed_quantity).toBe(18);
  });
});

describe("POST /admin/production/:id/tracking", () => {
  test("guarda tracking info y redirige", async () => {
    const qid = seedQuote("finalizado");
    const res = await app.request(`/admin/production/${qid}/tracking`, {
      method: "POST",
      headers: { ...ADMIN, "content-type": "application/x-www-form-urlencoded" },
      body: "tracking_number=EST9988&tracking_url=https%3A%2F%2Ftrack.example.com",
    });
    expect(res.status).toBe(302);
    const q = db.query<{ shipping_tracking_number: string }, [number]>(`SELECT shipping_tracking_number FROM quotes WHERE id = ?`).get(qid)!;
    expect(q.shipping_tracking_number).toBe("EST9988");
  });
});
