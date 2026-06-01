import { Database } from "bun:sqlite";
import { join } from "path";
import * as fs from "fs";

const dataDir = join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// CATALOG_DB_PATH permite apuntar a otra base (p.ej. ":memory:" en tests) sin
// tocar la base real. En producción queda sin definir y usa data/catalog.sqlite.
export const db = new Database(process.env.CATALOG_DB_PATH || join(dataDir, "catalog.sqlite"), { create: true });

const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";

export function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  try {
    db.run(`ALTER TABLE quote_items ADD COLUMN override_filament_grams REAL`);
  } catch {}
  try {
    db.run(`ALTER TABLE quote_items ADD COLUMN override_print_time_mins INTEGER`);
  } catch {}

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
  seedConfig("company_logo", "");
  seedConfig("cover_subtitle", "Catálogo de Productos");
  seedConfig("products_title", "Nuestros Productos");
  seedConfig("quote_whatsapp_number", "4961266304");
  seedConfig("shipping_provider", "Estafeta");
  seedConfig("shipping_price", "150");
  seedConfig("free_shipping_min_pieces", "501");
  seedConfig("welcome_text", defaultWelcome);
  seedConfig("contact_text", defaultContact);

  const designPromptDefault = "Transforma esta imagen en un diseño profesional listo para impresión 3D y catálogo: conserva la forma y los elementos principales del diseño original, mejora la nitidez, ajusta a fondo blanco puro, iluminación de estudio suave, sombras naturales discretas, sin texto, sin marcas de agua, sin manos, sin props ni elementos extra. {userPrompt}";
  seedConfig("design_creator_prompt", designPromptDefault);
  const previousTextOnlyDefault = "Diseña una imagen profesional de producto para una tienda de impresión 3D, basada en la siguiente descripción del cliente: {userPrompt}. Aplica las siguientes pautas: fondo blanco puro, iluminación de estudio suave, composición centrada, alta nitidez, sin texto, sin marcas de agua, sin manos ni props extra. Estilo realista, listo para catálogo.";
  db.run(`UPDATE config SET value = ? WHERE key = 'design_creator_prompt' AND value = ?`, [designPromptDefault, previousTextOnlyDefault]);

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
  seedConfig("card_style", "flat");
  seedConfig("layout_density", "comfortable");
  seedConfig("product_image_fit", "cover");
  seedConfig("decorative_shapes_enabled", "1");
  seedConfig("decorative_shape_style", "organic");
  seedConfig("decorative_shape_color", "rgba(239, 68, 68, 0.1)");
  seedConfig("decorative_shape_opacity", "0.45");
  seedConfig("decorative_shape_blur", "0px");
  seedConfig("custom_css", "");

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
  seedConfig("session_secret", "");

  // Users table for multi-user roles
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'visor',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
