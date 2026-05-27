import { Database } from "bun:sqlite";
import { join } from "path";
import * as fs from "fs";

// Ensure data directory exists
const dataDir = join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(join(dataDir, "catalog.sqlite"), { create: true });

const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";

export function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS default_price_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      min_volume INTEGER NOT NULL,
      max_volume INTEGER,
      price REAL NOT NULL,
      delivery_time TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subcategories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      makerworld_url TEXT,
      use_default_pricing BOOLEAN DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
    )
  `);

  try {
    db.run(`ALTER TABLE products ADD COLUMN makerworld_url TEXT`);
  } catch {
    // Column already exists in databases initialized with the current schema.
  }
  try {
    db.run(`ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL`);
  } catch {
    // Column already exists.
  }
  try {
    db.run(`ALTER TABLE products ADD COLUMN subcategory_id INTEGER REFERENCES subcategories(id) ON DELETE SET NULL`);
  } catch {
    // Column already exists.
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS product_price_tiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      min_volume INTEGER NOT NULL,
      max_volume INTEGER,
      price REAL NOT NULL,
      delivery_time TEXT,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      total_pieces INTEGER NOT NULL,
      subtotal REAL NOT NULL,
      shipping_provider TEXT NOT NULL,
      shipping_cost REAL NOT NULL,
      shipping_free_threshold INTEGER,
      grand_total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      whatsapp_number TEXT,
      message TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    db.run(`ALTER TABLE quotes ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
  } catch {
    // Column already exists in databases initialized with the current schema.
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS quote_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      subtotal REAL NOT NULL,
      pricing_min_volume INTEGER,
      pricing_max_volume INTEGER,
      delivery_time TEXT,
      custom_image_url TEXT,
      FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
    )
  `);

  try {
    db.run(`ALTER TABLE quote_items ADD COLUMN custom_image_url TEXT`);
  } catch {
    // Column already exists.
  }

  // Extra tables for printer and filament settings
  db.run(`
    CREATE TABLE IF NOT EXISTS printers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      power_cost_per_hour REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS filaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      color TEXT NOT NULL,
      price_per_kg REAL NOT NULL
    )
  `);

  // Try migrating product table with printing fields
  try {
    db.run(`ALTER TABLE products ADD COLUMN filament_grams REAL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE products ADD COLUMN print_time_mins INTEGER DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE products ADD COLUMN extra_costs REAL DEFAULT 0`);
  } catch {}

  // Try migrating quotes table with scheduling fields
  try {
    db.run(`ALTER TABLE quotes ADD COLUMN payment_proof_url TEXT`);
  } catch {}
  try {
    db.run(`ALTER TABLE quotes ADD COLUMN printer_id INTEGER`);
  } catch {}
  try {
    db.run(`ALTER TABLE quotes ADD COLUMN filament_id INTEGER`);
  } catch {}
  try {
    db.run(`ALTER TABLE quotes ADD COLUMN scheduled_start TEXT`);
  } catch {}

  // Migrate quotes: add final payment proof
  try {
    db.run(`ALTER TABLE quotes ADD COLUMN payment_proof_url_final TEXT`);
  } catch {}

  // Junction table: multiple filaments per quote with grams used
  db.run(`
    CREATE TABLE IF NOT EXISTS quote_filaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER NOT NULL,
      filament_id INTEGER NOT NULL,
      grams_used REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE,
      FOREIGN KEY (filament_id) REFERENCES filaments(id) ON DELETE CASCADE
    )
  `);

  // Migrate filaments: add stock_grams
  try {
    db.run(`ALTER TABLE filaments ADD COLUMN stock_grams REAL NOT NULL DEFAULT 1000`);
  } catch {}

  // Migrate printers: add monthly_cost and prints_per_month
  try {
    db.run(`ALTER TABLE printers ADD COLUMN monthly_cost REAL NOT NULL DEFAULT 0`);
  } catch {}
  try {
    db.run(`ALTER TABLE printers ADD COLUMN prints_per_month INTEGER NOT NULL DEFAULT 1`);
  } catch {}

  // Seed default printer and filament if empty
  try {
    const pCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM printers`).get()?.count || 0;
    if (pCount === 0) {
      db.run(`INSERT INTO printers (name, power_cost_per_hour) VALUES ('Ender 3 V3', 1.80)`);
      db.run(`INSERT INTO printers (name, power_cost_per_hour) VALUES ('Bambu Lab P1S', 2.40)`);
    }
    const fCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM filaments`).get()?.count || 0;
    if (fCount === 0) {
      db.run(`INSERT INTO filaments (color, price_per_kg) VALUES ('PLA Negro', 380.00)`);
      db.run(`INSERT INTO filaments (color, price_per_kg) VALUES ('PLA Rojo', 420.00)`);
    }
  } catch {}

  // Finance module tables
  db.run(`
    CREATE TABLE IF NOT EXISTS expense_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      payment_method TEXT DEFAULT '',
      receipt_url TEXT,
      notes TEXT,
      recurring INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id INTEGER,
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'transferencia',
      reference TEXT,
      date TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE SET NULL
    )
  `);

  // Seed default expense categories if empty
  try {
    const ecCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM expense_categories`).get()?.count || 0;
    if (ecCount === 0) {
      const insertCat = db.prepare(`INSERT INTO expense_categories (name, icon, sort_order) VALUES (?, ?, ?)`);
      insertCat.run("Material / Filamento", "🧵", 1);
      insertCat.run("Envíos", "📦", 2);
      insertCat.run("Electricidad", "⚡", 3);
      insertCat.run("Equipo / Mantenimiento", "🔧", 4);
      insertCat.run("Servicios (Internet, Software)", "💻", 5);
      insertCat.run("Marketing / Publicidad", "📣", 6);
      insertCat.run("Impuestos / SAT", "🏛️", 7);
      insertCat.run("Renta / Local", "🏠", 8);
      insertCat.run("Nómina / Sueldos", "👤", 9);
      insertCat.run("Otros", "📋", 10);
    }
  } catch {}

  // Seed default configuration
  const defaultWelcome = `Bienvenido a PIXKEY3D\nFabricamos productos personalizados con tecnología de impresión 3D de alta precisión. Cada pieza se produce bajo pedido con los mejores materiales del mercado. Ofrecemos precios especiales por volumen para revendedores, empresas y mayoristas.\n\n¿Cómo hacer tu pedido?\n1 Elige tus productos Selecciona del catálogo los productos y la cantidad deseada ->\n2 Solicita tu cotización Envíanos tu pedido por WhatsApp o email y te respondemos en minutos ->\n3 Recibe tu pedido Enviamos a domicilio en todo México según el volumen de tu pedido`;

  const defaultContact = `¿Listo para hacer tu pedido?\nContáctanos por cualquiera de estos medios y con gusto te enviamos una cotización personalizada.\n\nEmail contacto@pixkey3d.com\nWhatsApp 000 000 0000\nSitio web www.pixkey3d.com\nUbicación San Luis Potosí, México\nAtención Lunes a Sábado 9:00 – 18:00 hrs\n\n¡Gracias por confiar en PIXKEY3D!`;

  const seedConfig = (key: string, value: string) => {
    const existing = db.query(`SELECT value FROM config WHERE key = ?`).get(key);
    if (!existing) {
      db.run(`INSERT INTO config (key, value) VALUES (?, ?)`, [key, value]);
    }
  };

  seedConfig("company_name", "PIXKEY3D");
  seedConfig("company_logo", ""); // Empty means use text fallback or default image
  seedConfig("cover_subtitle", "Catálogo de Productos");
  seedConfig("products_title", "Nuestros Productos");
  seedConfig("quote_whatsapp_number", "4961266304");
  seedConfig("shipping_provider", "Estafeta");
  seedConfig("shipping_price", "150");
  seedConfig("free_shipping_min_pieces", "501");
  seedConfig("welcome_text", defaultWelcome);
  seedConfig("contact_text", defaultContact);

  // ── Prompts de IA ─────────────────────────────────────────────────────
  // Cada prompt vive en config para que el admin lo pueda editar sin tocar
  // env vars. Cuando un prompt está vacío, el helper que lo consume cae al
  // env var correspondiente y luego a un hardcoded de seguridad.

  // Design creator prompt — usado por /admin/design/generate. Recibe la
  // imagen subida por el usuario y la transforma según este template.
  // El placeholder opcional {userPrompt} se sustituye por la descripción
  // adicional escrita en el modal (puede estar vacía).
  const designPromptDefault = "Transforma esta imagen en un diseño profesional listo para impresión 3D y catálogo: conserva la forma y los elementos principales del diseño original, mejora la nitidez, ajusta a fondo blanco puro, iluminación de estudio suave, sombras naturales discretas, sin texto, sin marcas de agua, sin manos, sin props ni elementos extra. {userPrompt}";
  seedConfig("design_creator_prompt", designPromptDefault);
  // One-shot migration: si el valor sigue siendo el primer default de
  // text→image (cuando el flujo aún no aceptaba imagen), lo reemplazamos.
  const previousTextOnlyDefault = "Diseña una imagen profesional de producto para una tienda de impresión 3D, basada en la siguiente descripción del cliente: {userPrompt}. Aplica las siguientes pautas: fondo blanco puro, iluminación de estudio suave, composición centrada, alta nitidez, sin texto, sin marcas de agua, sin manos ni props extra. Estilo realista, listo para catálogo.";
  db.run(`UPDATE config SET value = ? WHERE key = 'design_creator_prompt' AND value = ?`, [designPromptDefault, previousTextOnlyDefault]);

  // Catalog image prompt — usado por enhanceImageForCatalog al agregar /
  // importar productos (MakerWorld y "Mejorar imagen" en el catálogo).
  // Toma una imagen existente y la limpia para ficha de catálogo.
  const catalogImagePromptDefault = "Transforma esta imagen en una fotografía profesional para catálogo ecommerce: producto centrado y completo, fondo blanco puro, iluminación de estudio suave, sombras naturales discretas, alta nitidez, colores fieles al producto, sin texto, sin marcas de agua, sin manos, sin props y sin elementos extra. Conserva la forma y detalles reales del objeto. Resultado limpio, realista y listo para catálogo.";
  seedConfig("catalog_image_prompt", catalogImagePromptDefault);

  // Styling defaults
  seedConfig("color_primary", "#ef4444");
  seedConfig("color_secondary", "#1f2937");
  seedConfig("color_accent", "#f87171");
  seedConfig("bg_cover", "#1f2937");
  seedConfig("color_cover_text", "#ffffff");
  seedConfig("bg_welcome", "#ffffff");
  seedConfig("bg_products", "#f9fafb");
  seedConfig("bg_contact", "#1f2937");
  seedConfig("color_contact_text", "#ffffff");
  seedConfig("bg_card", "#ffffff");
  seedConfig("color_card_border", "#e5e7eb");
  seedConfig("bg_table_header", "#f3f4f6");
  seedConfig("color_table_header_text", "#4b5563");
  seedConfig("color_body_text", "#374151");
  seedConfig("color_heading_text", "#111827");
  seedConfig("color_muted_text", "#6b7280");
  seedConfig("font_body", defaultFontFamily);
  seedConfig("font_heading", defaultFontFamily);
  seedConfig("font_body_file", "");
  seedConfig("font_heading_file", "");
  seedConfig("border_radius", "0.5rem");
  seedConfig("button_radius", "0.5rem");
  seedConfig("card_shadow", "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)");
  seedConfig("card_style", "flat"); // flat or bordered
  seedConfig("layout_density", "comfortable");
  seedConfig("product_image_fit", "cover");
  seedConfig("decorative_shapes_enabled", "1");
  seedConfig("decorative_shape_style", "organic");
  seedConfig("decorative_shape_color", "rgba(239, 68, 68, 0.1)");
  seedConfig("decorative_shape_opacity", "0.45");
  seedConfig("decorative_shape_blur", "0px");
  seedConfig("custom_css", "");

  // ── Settings que históricamente vivían en .env ────────────────────────
  // Se siembran vacías. Los helpers leen DB primero y caen al .env como
  // fallback, así un cambio guardado desde /admin/config se aplica al
  // instante sin reiniciar el container.
  seedConfig("llm_base_url", "");
  seedConfig("llm_api_key", "");
  seedConfig("llm_model", "");
  seedConfig("llm_fallback_models", "");
  seedConfig("llm_temperature", "");
  seedConfig("llm_description_max_words", "");
  seedConfig("image_base_url", "");
  seedConfig("image_endpoint", "");
  seedConfig("image_route", "");
  seedConfig("image_api_key", "");
  seedConfig("image_model", "");
  seedConfig("image_fallback_models", "");
  seedConfig("image_timeout_ms", "");
  seedConfig("flaresolverr_url", "");
  seedConfig("admin_username", "");
  seedConfig("admin_password", "");

  // Existing databases created before theme customization kept this old default.
  db.run(`
    UPDATE config
    SET value = ?
    WHERE key IN ('font_body', 'font_heading')
      AND value IN ('system-ui, -apple-system, sans-serif', 'system-ui, -apple-system, BlinkMacSystemFont, ''Segoe UI'', sans-serif')
  `, [defaultFontFamily]);

  // Seed default price tiers if empty
  const tierCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM default_price_tiers`).get()?.count || 0;

  if (tierCount === 0) {
    const insertTier = db.prepare(`INSERT INTO default_price_tiers (min_volume, max_volume, price, delivery_time) VALUES (?, ?, ?, ?)`);
    insertTier.run(25, 100, 25.00, "4 a 7 días hábiles");
    insertTier.run(101, 500, 23.00, "7 a 15 días hábiles");
    insertTier.run(501, null, 21.00, "A convenir");
  }
}

export function getConfig() {
  const rows = db.query<{key: string, value: string}, []>(`SELECT key, value FROM config`).all();
  return rows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {} as Record<string, string>);
}

export function updateConfig(updates: Record<string, string>) {
  const updateStmt = db.prepare(`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const transaction = db.transaction((updatesObj: Record<string, string>) => {
    for (const [key, value] of Object.entries(updatesObj)) {
      updateStmt.run(key, value);
    }
  });
  transaction(updates);
}

export interface PriceTier {
  id: number;
  min_volume: number;
  max_volume: number | null;
  price: number;
  delivery_time: string;
}

export function getDefaultPriceTiers() {
  return db.query<PriceTier, []>(`SELECT * FROM default_price_tiers ORDER BY min_volume ASC`).all();
}

export function replaceDefaultPriceTiers(tiers: Omit<PriceTier, "id">[]) {
  const insertTier = db.prepare(`INSERT INTO default_price_tiers (min_volume, max_volume, price, delivery_time) VALUES (?, ?, ?, ?)`);
  const transaction = db.transaction((rows: Omit<PriceTier, "id">[]) => {
    db.run(`DELETE FROM default_price_tiers`);
    for (const tier of rows) {
      insertTier.run(tier.min_volume, tier.max_volume, tier.price, tier.delivery_time);
    }
  });
  transaction(tiers);
}

export interface Category {
  id: number;
  name: string;
  sort_order: number;
}

export interface Subcategory {
  id: number;
  category_id: number;
  name: string;
  sort_order: number;
}

export interface Product {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  makerworld_url: string | null;
  filament_grams: number;
  print_time_mins: number;
  extra_costs: number;
  use_default_pricing: boolean;
  sort_order: number;
  category_id: number | null;
  subcategory_id: number | null;
}

// ── Categorías ──────────────────────────────────────────────────────────
export function getCategories(): Category[] {
  return db.query<Category, []>(`SELECT * FROM categories ORDER BY sort_order ASC, name ASC`).all();
}

export function getCategory(id: number): Category | null {
  return db.query<Category, [number]>(`SELECT * FROM categories WHERE id = ?`).get(id) || null;
}

export function createCategory(name: string, sortOrder?: number): Category {
  const order = Number.isFinite(sortOrder) ? sortOrder! : (db.query<{ m: number }, []>(`SELECT COALESCE(MAX(sort_order), 0) as m FROM categories`).get()?.m || 0) + 10;
  const row = db.query<{ id: number }, [string, number]>(`INSERT INTO categories (name, sort_order) VALUES (?, ?) RETURNING id`).get(name, order);
  return { id: row!.id, name, sort_order: order };
}

export function updateCategory(id: number, name: string, sortOrder: number) {
  db.run(`UPDATE categories SET name = ?, sort_order = ? WHERE id = ?`, [name, sortOrder, id]);
}

export function deleteCategory(id: number) {
  // SQLite no tiene PRAGMA foreign_keys=ON, así que los FK ON DELETE no se
  // enforzan. Limpiamos a mano: productos de la categoría quedan sin categoría
  // ni subcategoría, se borran las subcategorías de la categoría, y la fila.
  db.transaction(() => {
    db.run(`UPDATE products SET category_id = NULL, subcategory_id = NULL WHERE category_id = ?`, [id]);
    db.run(`DELETE FROM subcategories WHERE category_id = ?`, [id]);
    db.run(`DELETE FROM categories WHERE id = ?`, [id]);
  })();
}

// ── Subcategorías ───────────────────────────────────────────────────────
export function getSubcategories(): Subcategory[] {
  return db.query<Subcategory, []>(`SELECT * FROM subcategories ORDER BY sort_order ASC, name ASC`).all();
}

export function getSubcategoriesByCategory(categoryId: number): Subcategory[] {
  return db.query<Subcategory, [number]>(`SELECT * FROM subcategories WHERE category_id = ? ORDER BY sort_order ASC, name ASC`).all(categoryId);
}

export function getSubcategory(id: number): Subcategory | null {
  return db.query<Subcategory, [number]>(`SELECT * FROM subcategories WHERE id = ?`).get(id) || null;
}

export function createSubcategory(categoryId: number, name: string, sortOrder?: number): Subcategory {
  const order = Number.isFinite(sortOrder) ? sortOrder! : (db.query<{ m: number }, [number]>(`SELECT COALESCE(MAX(sort_order), 0) as m FROM subcategories WHERE category_id = ?`).get(categoryId)?.m || 0) + 10;
  const row = db.query<{ id: number }, [number, string, number]>(`INSERT INTO subcategories (category_id, name, sort_order) VALUES (?, ?, ?) RETURNING id`).get(categoryId, name, order);
  return { id: row!.id, category_id: categoryId, name, sort_order: order };
}

export function updateSubcategory(id: number, name: string, sortOrder: number) {
  db.run(`UPDATE subcategories SET name = ?, sort_order = ? WHERE id = ?`, [name, sortOrder, id]);
}

export function deleteSubcategory(id: number) {
  db.transaction(() => {
    db.run(`UPDATE products SET subcategory_id = NULL WHERE subcategory_id = ?`, [id]);
    db.run(`DELETE FROM subcategories WHERE id = ?`, [id]);
  })();
}

export function getProducts() {
  return db.query<Product, []>(`SELECT * FROM products ORDER BY sort_order ASC, id DESC`).all();
}

export function getProduct(id: number) {
  return db.query<Product, [number]>(`SELECT * FROM products WHERE id = ?`).get(id);
}

// Agrupa productos por categoría respetando sort_order de categorías.
// Productos sin categoría caen en un grupo final {category: null}. Si no hay
// ninguna categoría definida ni asignada, devuelve un solo grupo con todos
// los productos para mantener el render plano del catálogo.
export type ProductGroup = { category: Category | null; products: Product[] };
export function getProductsGroupedByCategory(): ProductGroup[] {
  const categories = getCategories();
  const products = getProducts();
  if (categories.length === 0) return [{ category: null, products }];
  const byId = new Map<number, Product[]>();
  const orphans: Product[] = [];
  for (const product of products) {
    if (product.category_id == null) { orphans.push(product); continue; }
    const list = byId.get(product.category_id) || [];
    list.push(product);
    byId.set(product.category_id, list);
  }
  const groups: ProductGroup[] = [];
  for (const category of categories) {
    groups.push({ category, products: byId.get(category.id) || [] });
  }
  if (orphans.length > 0) groups.push({ category: null, products: orphans });
  return groups;
}

export function getProductPriceTiers(productId: number) {
  return db.query<PriceTier, [number]>(`SELECT * FROM product_price_tiers WHERE product_id = ? ORDER BY min_volume ASC`).all(productId);
}

export function replaceProductPriceTiers(productId: number, tiers: Omit<PriceTier, "id">[]) {
  const insertTier = db.prepare(`INSERT INTO product_price_tiers (product_id, min_volume, max_volume, price, delivery_time) VALUES (?, ?, ?, ?, ?)`);
  const transaction = db.transaction((id: number, rows: Omit<PriceTier, "id">[]) => {
    db.run(`DELETE FROM product_price_tiers WHERE product_id = ?`, [id]);
    for (const tier of rows) {
      insertTier.run(id, tier.min_volume, tier.max_volume, tier.price, tier.delivery_time);
    }
  });
  transaction(productId, tiers);
}

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
}

export interface Quote {
  id: number;
  customer_name: string;
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
}

export function createQuote(input: QuoteInput) {
  const insertQuote = db.prepare(`
    INSERT INTO quotes (
      customer_name, postal_code, total_pieces, subtotal, shipping_provider, shipping_cost,
      shipping_free_threshold, grand_total, whatsapp_number, message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
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
      quote.postal_code,
      quote.total_pieces,
      quote.subtotal,
      quote.shipping_provider,
      quote.shipping_cost,
      quote.shipping_free_threshold,
      quote.grand_total,
      quote.whatsapp_number,
      quote.message,
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

export function getQuotes(limit = 100) {
  return db.query<Quote, [number]>(`
    SELECT * FROM quotes ORDER BY id DESC LIMIT ?
  `).all(limit);
}

export function getQuote(id: number) {
  return db.query<Quote, [number]>(`
    SELECT * FROM quotes WHERE id = ?
  `).get(id);
}

export function getQuoteItems(quoteId: number) {
  return db.query<QuoteItem, [number]>(`
    SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id ASC
  `).all(quoteId);
}

export type QuoteItemWithProduct = QuoteItem & {
  product_image_url: string | null;
  product_makerworld_url: string | null;
  product_description: string | null;
  product_filament_grams: number | null;
  product_print_time_mins: number | null;
  product_extra_costs: number | null;
};

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

export function updateQuotePaymentProof(id: number, paymentProofUrl: string) {
  db.run(`UPDATE quotes SET payment_proof_url = ?, status = 'produccion' WHERE id = ?`, [paymentProofUrl, id]);
}

export function updateQuoteScheduler(id: number, printerId: number | null, scheduledStart: string | null) {
  db.run(`
    UPDATE quotes
    SET printer_id = ?, scheduled_start = ?
    WHERE id = ?
  `, [printerId, scheduledStart, id]);
}

// Printer settings helpers
export interface Printer {
  id: number;
  name: string;
  power_cost_per_hour: number;
  monthly_cost: number;
  prints_per_month: number;
}

export function getPrinters() {
  return db.query<Printer, []>(`SELECT * FROM printers ORDER BY id ASC`).all();
}

export function createPrinter(name: string, powerCostPerHour: number, monthlyCost: number, printsPerMonth: number) {
  db.run(`INSERT INTO printers (name, power_cost_per_hour, monthly_cost, prints_per_month) VALUES (?, ?, ?, ?)`, [name, powerCostPerHour, monthlyCost, printsPerMonth]);
}

export function deletePrinter(id: number) {
  db.run(`DELETE FROM printers WHERE id = ?`, [id]);
}

// Filament settings helpers
export interface Filament {
  id: number;
  color: string;
  price_per_kg: number;
  stock_grams: number;
}

export function getFilaments() {
  return db.query<Filament, []>(`SELECT * FROM filaments ORDER BY id ASC`).all();
}

export function createFilament(color: string, pricePerKg: number, stockGrams: number) {
  db.run(`INSERT INTO filaments (color, price_per_kg, stock_grams) VALUES (?, ?, ?)`, [color, pricePerKg, stockGrams]);
}

export function deleteFilament(id: number) {
  db.run(`DELETE FROM filaments WHERE id = ?`, [id]);
}

export function subtractFilamentStock(filamentId: number, grams: number) {
  db.run(`UPDATE filaments SET stock_grams = MAX(0, stock_grams - ?) WHERE id = ?`, [grams, filamentId]);
}

// Quote filaments (multi-filament per quote)
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

// ── Finance module ──────────────────────────────────────────────────────────

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

// Expense categories
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

// Expenses
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
  db.run(`INSERT INTO expenses (category_id, description, amount, date, payment_method, receipt_url, notes, recurring) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.category_id, input.description, input.amount, input.date, input.payment_method, input.receipt_url || null, input.notes || null, input.recurring || 0]);
}

export function deleteExpense(id: number) {
  db.run(`DELETE FROM expenses WHERE id = ?`, [id]);
}

// Payments (income against quotes)
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
  db.run(`INSERT INTO payments (quote_id, amount, payment_method, reference, date, notes) VALUES (?, ?, ?, ?, ?, ?)`,
    [input.quote_id, input.amount, input.payment_method, input.reference || null, input.date, input.notes || null]);
}

export function deletePayment(id: number) {
  db.run(`DELETE FROM payments WHERE id = ?`, [id]);
}

// Financial summaries
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

export function getFinancialSummary(from?: string, to?: string): FinancialSummary {
  const dateFilter = (col: string) => {
    const parts: string[] = [];
    if (from) parts.push(`${col} >= '${from}'`);
    if (to) parts.push(`${col} <= '${to}'`);
    return parts.length ? `AND ${parts.join(" AND ")}` : "";
  };

  // Revenue from payments
  const totalRevenue = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE 1=1 ${dateFilter("date")}`).get()?.total || 0;

  // Total expenses
  const totalExpenses = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE 1=1 ${dateFilter("date")}`).get()?.total || 0;

  // Production costs from quote_filaments + printer costs for finished/production quotes
  const productionCost = db.query<{ total: number }, []>(`
    SELECT COALESCE(SUM(
      (qf.grams_used / 1000.0 * f.price_per_kg)
    ), 0) as total
    FROM quote_filaments qf
    JOIN filaments f ON f.id = qf.filament_id
    JOIN quotes q ON q.id = qf.quote_id
    WHERE q.status IN ('produccion', 'finalizado') ${dateFilter("q.created_at")}
  `).get()?.total || 0;

  // Quote counts
  const quoteCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM quotes WHERE status != 'spam' ${dateFilter("created_at")}`).get()?.count || 0;
  const paidQuoteCount = db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM quotes WHERE status IN ('despachado', 'produccion', 'finalizado') ${dateFilter("created_at")}`).get()?.count || 0;

  // Pending revenue (quotes accepted but no payment yet)
  const pendingRevenue = db.query<{ total: number }, []>(`SELECT COALESCE(SUM(grand_total), 0) as total FROM quotes WHERE status IN ('no_despachado', 'despachado') ${dateFilter("created_at")}`).get()?.total || 0;

  // Expenses by category
  const expensesByCategory = db.query<{ category_name: string; category_icon: string; total: number }, []>(`
    SELECT COALESCE(ec.name, 'Sin categoría') AS category_name, COALESCE(ec.icon, '📋') AS category_icon, SUM(e.amount) AS total
    FROM expenses e
    LEFT JOIN expense_categories ec ON ec.id = e.category_id
    WHERE 1=1 ${dateFilter("e.date")}
    GROUP BY e.category_id
    ORDER BY total DESC
  `).all();

  // Monthly revenue (last 12 months)
  const monthlyRevenue = db.query<{ month: string; total: number }, []>(`
    SELECT strftime('%Y-%m', date) AS month, SUM(amount) AS total
    FROM payments
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all().reverse();

  // Monthly expenses (last 12 months)
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
