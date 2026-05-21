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
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      use_default_pricing BOOLEAN DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )
  `);

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
  seedConfig("welcome_text", defaultWelcome);
  seedConfig("contact_text", defaultContact);

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

export interface Product {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  use_default_pricing: boolean;
  sort_order: number;
}

export function getProducts() {
  return db.query<Product, []>(`SELECT * FROM products ORDER BY sort_order ASC, id DESC`).all();
}

export function getProduct(id: number) {
  return db.query<Product, [number]>(`SELECT * FROM products WHERE id = ?`).get(id);
}

export function getProductPriceTiers(productId: number) {
  return db.query<PriceTier, [number]>(`SELECT * FROM product_price_tiers WHERE product_id = ? ORDER BY min_volume ASC`).all(productId);
}
