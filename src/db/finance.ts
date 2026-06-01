import { db } from "./client";

export interface ExpenseCategory {
  id: number;
  name: string;
  icon: string;
  sort_order: number;
}

export interface Expense {
  id: number;
  category_id: number | null;
  description: string;
  amount: number;
  date: string;
  payment_method: string;
  receipt_url: string | null;
  notes: string | null;
  recurring: number;
  created_at: string;
}

export type ExpenseWithCategory = Expense & { category_name: string | null; category_icon: string | null };

export interface Payment {
  id: number;
  quote_id: number | null;
  amount: number;
  payment_method: string;
  reference: string | null;
  date: string;
  notes: string | null;
  created_at: string;
}

export type PaymentWithQuote = Payment & { customer_name: string | null; quote_grand_total: number | null };

export interface FinancialSummary {
  totalRevenue: number;
  totalExpenses: number;
  totalProductionCost: number;
  netProfit: number;
  quoteCount: number;
  paidQuoteCount: number;
  pendingRevenue: number;
  expensesByCategory: { category_name: string; category_icon: string; total: number }[];
  monthlyRevenue: { month: string; total: number }[];
  monthlyExpenses: { month: string; total: number }[];
}

// ── Categorías de gasto ───────────────────────────────────────────────────────

export function getExpenseCategories(): ExpenseCategory[] {
  return db.query<ExpenseCategory, []>(`SELECT * FROM expense_categories ORDER BY sort_order ASC, id ASC`).all();
}

export function createExpenseCategory(name: string, icon: string) {
  const maxOrder = db.query<{ m: number }, []>(`SELECT COALESCE(MAX(sort_order), 0) as m FROM expense_categories`).get()?.m || 0;
  db.run(`INSERT INTO expense_categories (name, icon, sort_order) VALUES (?, ?, ?)`, [name, icon, maxOrder + 1]);
}

export function deleteExpenseCategory(id: number) {
  db.run(`DELETE FROM expense_categories WHERE id = ?`, [id]);
}

// ── Gastos ────────────────────────────────────────────────────────────────────

export function getExpenses(filters?: { from?: string; to?: string; categoryId?: number; limit?: number }): ExpenseWithCategory[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.from) { conditions.push("e.date >= ?"); params.push(filters.from); }
  if (filters?.to) { conditions.push("e.date <= ?"); params.push(filters.to); }
  if (filters?.categoryId) { conditions.push("e.category_id = ?"); params.push(filters.categoryId); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit || 500;
  params.push(limit);

  return db.query<ExpenseWithCategory, (string | number)[]>(`
    SELECT e.*, ec.name AS category_name, ec.icon AS category_icon
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    ${where}
    ORDER BY e.date DESC, e.id DESC
    LIMIT ?
  `).all(...params);
}

export function createExpense(input: { category_id: number | null; description: string; amount: number; date: string; payment_method: string; receipt_url?: string; notes?: string; recurring?: number }) {
  db.run(
    `INSERT INTO expenses (category_id, description, amount, date, payment_method, receipt_url, notes, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.category_id, input.description, input.amount, input.date, input.payment_method, input.receipt_url || null, input.notes || null, input.recurring || 0]
  );
}

export function deleteExpense(id: number) {
  db.run(`DELETE FROM expenses WHERE id = ?`, [id]);
}

// ── Pagos (ingresos contra cotizaciones) ─────────────────────────────────────

export function getPayments(filters?: { from?: string; to?: string; limit?: number }): PaymentWithQuote[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.from) { conditions.push("p.date >= ?"); params.push(filters.from); }
  if (filters?.to) { conditions.push("p.date <= ?"); params.push(filters.to); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit || 500;
  params.push(limit);

  return db.query<PaymentWithQuote, (string | number)[]>(`
    SELECT p.*, q.customer_name, q.grand_total AS quote_grand_total
    FROM payments p
    LEFT JOIN quotes q ON q.id = p.quote_id
    ${where}
    ORDER BY p.date DESC, p.id DESC
    LIMIT ?
  `).all(...params);
}

export function createPayment(input: { quote_id: number | null; amount: number; payment_method: string; reference?: string; date: string; notes?: string }) {
  db.run(
    `INSERT INTO payments (quote_id, amount, payment_method, reference, date, notes) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.quote_id, input.amount, input.payment_method, input.reference || null, input.date, input.notes || null]
  );
}

export function deletePayment(id: number) {
  db.run(`DELETE FROM payments WHERE id = ?`, [id]);
}

// ── Resumen financiero ────────────────────────────────────────────────────────

export function getFinancialSummary(from?: string, to?: string): FinancialSummary {
  const dateFilter = (col: string) => {
    const parts: string[] = [];
    if (from) parts.push(`${col} >= '${from}'`);
    if (to) parts.push(`${col} <= '${to}'`);
    return parts.length ? `AND ${parts.join(" AND ")}` : "";
  };

  const totalRevenue = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE 1=1 ${dateFilter("date")}`).get()?.total || 0;
  const totalExpenses = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE 1=1 ${dateFilter("date")}`).get()?.total || 0;

  const productionCost = db.query<{ total: number }, []>(`
    SELECT COALESCE(SUM(
      (qf.grams_used / 1000.0 * f.price_per_kg)
    ), 0) as total
    FROM quote_filaments qf
    JOIN filaments f ON f.id = qf.filament_id
    JOIN quotes q ON q.id = qf.quote_id
    WHERE q.status IN ('produccion', 'finalizado') ${dateFilter("q.created_at")}
  `).get()?.total || 0;

  const quoteCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM quotes WHERE status != 'spam' ${dateFilter("created_at")}`).get()?.count || 0;
  const paidQuoteCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM quotes WHERE status IN ('despachado', 'produccion', 'finalizado') ${dateFilter("created_at")}`).get()?.count || 0;
  const pendingRevenue = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(grand_total), 0) as total FROM quotes WHERE status IN ('no_despachado', 'despachado') ${dateFilter("created_at")}`).get()?.total || 0;

  const expensesByCategory = db.query<{ category_name: string; category_icon: string; total: number }, []>(`
    SELECT COALESCE(ec.name, 'Sin categoría') AS category_name, COALESCE(ec.icon, '📋') AS category_icon, SUM(e.amount) AS total
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE 1=1 ${dateFilter("e.date")}
    GROUP BY e.category_id
    ORDER BY total DESC
  `).all();

  const monthlyRevenue = db.query<{ month: string; total: number }, []>(`
    SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS total
    FROM payments
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all().reverse();

  const monthlyExpenses = db.query<{ month: string; total: number }, []>(`
    SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS total
    FROM expenses
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all().reverse();

  return {
    totalRevenue,
    totalExpenses,
    totalProductionCost: productionCost,
    netProfit: totalRevenue - totalExpenses - productionCost,
    quoteCount,
    paidQuoteCount,
    pendingRevenue,
    expensesByCategory,
    monthlyRevenue,
    monthlyExpenses,
  };
}
