import { db } from "./client";

export interface QuoteItemInput {
  product_id: number | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  pricing_min_volume: number | null;
  pricing_max_volume: number | null;
  delivery_time: string | null;
  custom_image_url?: string | null;
}

export interface QuoteInput {
  customer_name: string;
  customer_phone?: string;
  postal_code: string;
  total_pieces: number;
  subtotal: number;
  shipping_provider: string;
  shipping_cost: number;
  shipping_free_threshold: number | null;
  grand_total: number;
  whatsapp_number: string;
  message: string;
  items: QuoteItemInput[];
  cond_entrega?: string;
  cond_pago?: string;
  cond_prioritario?: string;
  forma_pago?: string;
  source?: string;
  status?: string;
}

export interface Quote {
  id: number;
  customer_name: string;
  customer_phone: string | null;
  postal_code: string;
  total_pieces: number;
  subtotal: number;
  shipping_provider: string;
  shipping_cost: number;
  shipping_free_threshold: number | null;
  grand_total: number;
  status: string;
  payment_proof_url: string | null;
  payment_proof_url_final: string | null;
  printer_id: number | null;
  filament_id: number | null;
  scheduled_start: string | null;
  whatsapp_number: string | null;
  message: string | null;
  created_at: string;
  cond_entrega: string | null;
  cond_pago: string | null;
  cond_prioritario: string | null;
  forma_pago: string | null;
  source: string | null;
}

export interface QuoteItem {
  id: number;
  quote_id: number;
  product_id: number | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  pricing_min_volume: number | null;
  pricing_max_volume: number | null;
  delivery_time: string | null;
  custom_image_url: string | null;
  override_filament_grams: number | null;
  override_print_time_mins: number | null;
}

export type QuoteItemWithProduct = QuoteItem & {
  product_image_url: string | null;
  product_makerworld_url: string | null;
  product_description: string | null;
  product_filament_grams: number | null;
  product_print_time_mins: number | null;
  product_extra_costs: number | null;
};

export interface Printer {
  id: number;
  name: string;
  power_cost_per_hour: number;
  monthly_cost: number;
  prints_per_month: number;
}

export interface Filament {
  id: number;
  color: string;
  price_per_kg: number;
  stock_grams: number;
}

export interface QuoteFilament {
  id: number;
  quote_id: number;
  filament_id: number;
  grams_used: number;
}

export type QuoteFilamentWithDetails = QuoteFilament & {
  color: string;
  price_per_kg: number;
};

// ── Quotes ───────────────────────────────────────────────────────────────────

export function createQuote(input: QuoteInput) {
  const insertQuote = db.prepare(`
    INSERT INTO quotes (
      customer_name, customer_phone, postal_code, total_pieces, subtotal, shipping_provider, shipping_cost,
      shipping_free_threshold, grand_total, whatsapp_number, message,
      cond_entrega, cond_pago, cond_prioritario, forma_pago, source, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const insertItem = db.prepare(`
    INSERT INTO quote_items (
      quote_id, product_id, product_name, quantity, unit_price, subtotal,
      pricing_min_volume, pricing_max_volume, delivery_time, custom_image_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transaction = db.transaction((quote: QuoteInput) => {
    const row = insertQuote.get(
      quote.customer_name,
      quote.customer_phone ?? "",
      quote.postal_code,
      quote.total_pieces,
      quote.subtotal,
      quote.shipping_provider,
      quote.shipping_cost,
      quote.shipping_free_threshold,
      quote.grand_total,
      quote.whatsapp_number,
      quote.message,
      quote.cond_entrega ?? "",
      quote.cond_pago ?? "",
      quote.cond_prioritario ?? "",
      quote.forma_pago ?? "",
      quote.source ?? "admin",
      quote.status ?? "new",
    ) as { id: number };

    for (const item of quote.items) {
      insertItem.run(
        row.id,
        item.product_id,
        item.product_name,
        item.quantity,
        item.unit_price,
        item.subtotal,
        item.pricing_min_volume,
        item.pricing_max_volume,
        item.delivery_time,
        item.custom_image_url ?? null,
      );
    }

    return row.id;
  });

  return transaction(input) as number;
}

export function updateQuoteMessage(id: number, message: string) {
  db.run(`UPDATE quotes SET message = ? WHERE id = ?`, [message, id]);
}

export function updateQuoteStatus(id: number, status: string) {
  db.run(`UPDATE quotes SET status = ? WHERE id = ?`, [status, id]);
}

export function updateQuote(
  id: number,
  data: Partial<{
    customer_name: string;
    customer_phone: string;
    postal_code: string;
    shipping_provider: string;
    shipping_cost: number;
    shipping_free_threshold: number | null;
    whatsapp_number: string;
    cond_entrega: string;
    cond_pago: string;
    cond_prioritario: string;
    forma_pago: string;
  }>,
) {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (fields.length === 0) return;
  values.push(id);
  db.run(`UPDATE quotes SET ${fields.join(", ")} WHERE id = ?`, values);
}

export function updateQuoteItem(
  itemId: number,
  data: { quantity?: number; unit_price?: number; subtotal?: number; custom_image_url?: string | null },
) {
  const fields: string[] = [];
  const values: any[] = [];
  if (data.quantity !== undefined) { fields.push("quantity = ?"); values.push(data.quantity); }
  if (data.unit_price !== undefined) { fields.push("unit_price = ?"); values.push(data.unit_price); }
  if (data.subtotal !== undefined) { fields.push("subtotal = ?"); values.push(data.subtotal); }
  if (data.custom_image_url !== undefined) { fields.push("custom_image_url = ?"); values.push(data.custom_image_url); }
  if (fields.length === 0) return;
  values.push(itemId);
  db.run(`UPDATE quote_items SET ${fields.join(", ")} WHERE id = ?`, values);
}

export function addQuoteItem(quoteId: number, item: QuoteItemInput) {
  db.run(
    `INSERT INTO quote_items (quote_id, product_id, product_name, quantity, unit_price, subtotal, pricing_min_volume, pricing_max_volume, delivery_time, custom_image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      quoteId,
      item.product_id,
      item.product_name,
      item.quantity,
      item.unit_price,
      item.subtotal,
      item.pricing_min_volume,
      item.pricing_max_volume,
      item.delivery_time,
      item.custom_image_url ?? null,
    ],
  );
}

export function deleteQuoteItem(itemId: number) {
  db.run(`DELETE FROM quote_items WHERE id = ?`, [itemId]);
}

export function recalculateQuoteTotals(quoteId: number) {
  const items = db.query<{ subtotal: number }, [number]>(`SELECT subtotal FROM quote_items WHERE quote_id = ?`).all(quoteId);
  const subtotal = items.reduce((s, i) => s + i.subtotal, 0);
  const quote = getQuote(quoteId);
  if (!quote) return;
  const shippingCost = quote.shipping_cost || 0;
  const grandTotal = subtotal + shippingCost;
  db.run(`UPDATE quotes SET subtotal = ?, total_pieces = (SELECT COALESCE(SUM(quantity), 0) FROM quote_items WHERE quote_id = ?), grand_total = ? WHERE id = ?`, [subtotal, quoteId, grandTotal, quoteId]);
}

export function getQuotes(limit = 100) {
  return db.query<Quote, [number]>(`SELECT * FROM quotes ORDER BY id DESC LIMIT ?`).all(limit);
}

export function getQuotesBySource(source: string, limit = 50) {
  return db.query<Quote, [string, number]>(`SELECT * FROM quotes WHERE source = ? ORDER BY id DESC LIMIT ?`).all(source, limit);
}

export function getQuote(id: number) {
  return db.query<Quote, [number]>(`SELECT * FROM quotes WHERE id = ?`).get(id);
}

export function getQuoteItems(quoteId: number) {
  return db.query<QuoteItem, [number]>(`SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id ASC`).all(quoteId);
}

export function getQuoteItemsWithProducts(quoteId: number) {
  return db.query<QuoteItemWithProduct, [number]>(`
    SELECT
      qi.*,
      p.image_url AS product_image_url,
      p.makerworld_url AS product_makerworld_url,
      p.description AS product_description,
      p.filament_grams AS product_filament_grams,
      p.print_time_mins AS product_print_time_mins,
      p.extra_costs AS product_extra_costs
    FROM quote_items qi
    LEFT JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = ?
    ORDER BY qi.id ASC
  `).all(quoteId);
}

export function updateQuoteItemPrintValues(itemId: number, filamentGrams: number | null, printTimeMins: number | null) {
  db.run(`UPDATE quote_items SET override_filament_grams = ?, override_print_time_mins = ? WHERE id = ?`, [filamentGrams, printTimeMins, itemId]);
}

export function updateQuotePaymentProof(id: number, paymentProofUrl: string) {
  db.run(`UPDATE quotes SET payment_proof_url = ?, status = 'produccion' WHERE id = ?`, [paymentProofUrl, id]);
}

export function updateQuoteScheduler(id: number, printerId: number | null, scheduledStart: string | null) {
  db.run(`UPDATE quotes SET printer_id = ?, scheduled_start = ? WHERE id = ?`, [printerId, scheduledStart, id]);
}

// ── Impresoras ───────────────────────────────────────────────────────────────

export function getPrinters() {
  return db.query<Printer, []>(`SELECT * FROM printers ORDER BY id ASC`).all();
}

export function createPrinter(name: string, powerCostPerHour: number, monthlyCost: number, printsPerMonth: number) {
  db.run(`INSERT INTO printers (name, power_cost_per_hour, monthly_cost, prints_per_month) VALUES (?, ?, ?, ?)`, [name, powerCostPerHour, monthlyCost, printsPerMonth]);
}

export function deletePrinter(id: number) {
  db.run(`DELETE FROM printers WHERE id = ?`, [id]);
}

// ── Filamentos ───────────────────────────────────────────────────────────────

export function getFilaments() {
  return db.query<Filament, []>(`SELECT * FROM filaments ORDER BY id ASC`).all();
}

export function createFilament(color: string, pricePerKg: number, stockGrams: number) {
  db.run(`INSERT INTO filaments (color, price_per_kg, stock_grams) VALUES (?, ?, ?)`, [color, pricePerKg, stockGrams]);
}

export function deleteFilament(id: number) {
  db.run(`DELETE FROM filaments WHERE id = ?`, [id]);
}

// Reprograma una cotización de forma atómica: actualiza impresora/fecha,
// reemplaza los filamentos asignados y ajusta el stock en UNA transacción.
//
// El stock se ajusta por DELTA NETO por filamento (gramos nuevos − gramos
// previos), aplicado en una sola operación. Esto evita dos defectos del flujo
// anterior (restore-todo → replace → subtract-todo, sin transacción):
//   1. Corrupción si fallaba a mitad de camino (no era atómico).
//   2. El clamp MAX(0,...) entre el restore y el subtract perdía la deuda real
//      cuando el stock tocaba 0, sobre-acreditando en la siguiente reprogramación.
// No se aplica clamp: el stock puede quedar negativo (señal legítima de
// sobre-asignación) y así los ajustes son siempre reversibles. La barra de
// progreso en la vista hace clamp solo para mostrar.
export function applyQuoteSchedule(
  quoteId: number,
  printerId: number | null,
  scheduledStart: string | null,
  entries: { filament_id: number; grams_used: number }[],
) {
  const insert = db.prepare(`INSERT INTO quote_filaments (quote_id, filament_id, grams_used) VALUES (?, ?, ?)`);
  const adjustStock = db.prepare(`UPDATE filaments SET stock_grams = stock_grams - ? WHERE id = ?`);

  const tx = db.transaction(() => {
    const delta = new Map<number, number>();
    for (const pf of getQuoteFilaments(quoteId)) {
      delta.set(pf.filament_id, (delta.get(pf.filament_id) || 0) - pf.grams_used);
    }
    for (const e of entries) {
      if (e.filament_id && e.grams_used > 0) {
        delta.set(e.filament_id, (delta.get(e.filament_id) || 0) + e.grams_used);
      }
    }

    db.run(`UPDATE quotes SET printer_id = ?, scheduled_start = ? WHERE id = ?`, [printerId, scheduledStart, quoteId]);

    db.run(`DELETE FROM quote_filaments WHERE quote_id = ?`, [quoteId]);
    for (const e of entries) {
      if (e.filament_id && e.grams_used > 0) {
        insert.run(quoteId, e.filament_id, e.grams_used);
      }
    }

    for (const [filamentId, d] of delta) {
      if (d !== 0) adjustStock.run(d, filamentId);
    }
  });

  tx();
}

// ── Filamentos por cotización ─────────────────────────────────────────────────

export function getQuoteFilaments(quoteId: number): QuoteFilamentWithDetails[] {
  return db.query<QuoteFilamentWithDetails, [number]>(`
    SELECT qf.*, f.color, f.price_per_kg
    FROM quote_filaments qf
    JOIN filaments f ON f.id = qf.filament_id
    WHERE qf.quote_id = ?
    ORDER BY qf.id ASC
  `).all(quoteId);
}

export function replaceQuoteFilaments(quoteId: number, entries: { filament_id: number; grams_used: number }[]) {
  const insert = db.prepare(`INSERT INTO quote_filaments (quote_id, filament_id, grams_used) VALUES (?, ?, ?)`);
  const transaction = db.transaction((id: number, rows: { filament_id: number; grams_used: number }[]) => {
    db.run(`DELETE FROM quote_filaments WHERE quote_id = ?`, [id]);
    for (const row of rows) {
      if (row.filament_id && row.grams_used > 0) {
        insert.run(id, row.filament_id, row.grams_used);
      }
    }
  });
  transaction(quoteId, entries);
}
