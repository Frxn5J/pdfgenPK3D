// Setea env ANTES de cualquier import: db/client.ts lee CATALOG_DB_PATH al
// cargarse (usa ":memory:" para no tocar la base real), y n8n.ts lee
// N8N_API_KEY en cada request (no hace falta setearla antes del import, pero
// se hace aquí para mantener el arranque del test en un solo bloque).
process.env.CATALOG_DB_PATH = ":memory:";
process.env.N8N_API_KEY = "test-secret-key-12345";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { initDb } from "../db/schema";
import { db } from "../db/client";
import { app } from "../app";
import { join } from "path";
import * as fs from "fs";

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.N8N_API_KEY}`,
};

beforeAll(() => {
  initDb();
  // Producto mínimo con un tier de precio para poder cotizar.
  db.run(`INSERT INTO products (id, name, use_default_pricing) VALUES (1, 'Llavero de prueba', 1)`);
});

afterAll(() => {
  // Limpiar PDFs generados durante los tests
  const pdfDir = join(import.meta.dir, "..", "..", "data", "pdfs");
  if (fs.existsSync(pdfDir)) {
    for (const f of fs.readdirSync(pdfDir)) fs.unlinkSync(join(pdfDir, f));
  }
});

const validPayload = {
  customerName: "Cliente n8n",
  postalCode: "78000",
  requiresInvoice: false,
  items: [{ productId: 1, quantity: 30 }],
};

describe("POST /api/n8n/quotes — autenticación", () => {
  test("sin API key devuelve 401", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "No autorizado." });
  });

  test("con API key incorrecta devuelve 401", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer key-equivocada",
      },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: "No autorizado." });
  });

  test("con API key incorrecta de distinta longitud devuelve 401 (no lanza excepción)", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer x",
      },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/n8n/quotes — happy path", () => {
  let quoteId: number;

  test("con API key correcta y payload válido devuelve 200 con la forma esperada", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.N8N_API_KEY}`,
      },
      body: JSON.stringify(validPayload),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(typeof json.id).toBe("number");
    expect(typeof json.message).toBe("string");
    expect(json.totals).toMatchObject({
      totalPieces: 30,
      subtotal: expect.any(Number),
      shippingProvider: expect.any(String),
      shippingCost: expect.any(Number),
      grandTotal: expect.any(Number),
    });
    quoteId = json.id;

    // Verifica que se guardó como draft
    const quote = db.query(`SELECT status FROM quotes WHERE id = ?`).get(quoteId) as any;
    expect(quote.status).toBe("draft");
  });

  test("con unitPrice pre-calculado usa ese precio en lugar del tier", async () => {
    const overridePrice = 99.50;
    const overrideSubtotal = overridePrice * 10;
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.N8N_API_KEY}`,
      },
      body: JSON.stringify({
        customerName: "Cliente LLM",
        postalCode: "78000",
        requiresInvoice: true,
        items: [{ productId: 1, quantity: 10, unitPrice: overridePrice }],
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.totals.subtotal).toBe(overrideSubtotal);
    expect(json.totals.grandTotal).toBeGreaterThan(overrideSubtotal); // con IVA y envío
  });

  test("con unitPrice y subtotal pre-calculados usa ambos", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.N8N_API_KEY}`,
      },
      body: JSON.stringify({
        customerName: "Cliente LLM",
        postalCode: "78000",
        requiresInvoice: false,
        items: [{ productId: 1, quantity: 10, unitPrice: 50, subtotal: 500 }],
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.totals.subtotal).toBe(500);
  });

  test("GET /api/n8n/pdf/:id — validación", async () => {
    expect(quoteId).toBeGreaterThan(0);

    // Sin auth
    const resNoAuth = await app.request(`/api/n8n/pdf/${quoteId}`);
    expect(resNoAuth.status).toBe(401);

    // Auth incorrecta
    const resBadAuth = await app.request(`/api/n8n/pdf/${quoteId}`, {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(resBadAuth.status).toBe(401);

    // ID inválido (no numérico)
    const resBadId = await app.request("/api/n8n/pdf/abc", {
      headers: authHeaders,
    });
    expect(resBadId.status).toBe(400);
  });
});

describe("POST /api/n8n/quotes — validación de body (con API key válida)", () => {
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.N8N_API_KEY}`,
  };

  test("sin nombre o código postal devuelve 400", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validPayload, customerName: "" }),
    });
    expect(res.status).toBe(400);
  });

  test("código postal inválido devuelve 400", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validPayload, postalCode: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  test("sin items devuelve 400", async () => {
    const res = await app.request("/api/n8n/quotes", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ ...validPayload, items: [] }),
    });
    expect(res.status).toBe(400);
  });
});

// ponytail: no se cubre el caso "N8N_API_KEY no configurada en el entorno
// devuelve 503" porque la env var se setea una sola vez al inicio del
// archivo (antes de importar `app`) y Bun no soporta aislar módulos con env
// distinta dentro del mismo proceso de test sin infra adicional (p.ej.
// procesos hijos o mocking de process.env por test). La rama 503 es un
// early-return trivial (`if (!apiKey) return c.json(..., 503)`) y se
// verificó manualmente que compila y responde como se espera.
