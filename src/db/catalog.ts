import { db } from "./client";

export interface PriceTier {
  id: number;
  min_volume: number;
  max_volume: number | null;
  price: number;
  delivery_time: string;
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
  featured: number;
  featured_order: number;
}

export type ProductGroup = { category: Category | null; products: Product[] };

// ── Price tiers ─────────────────────────────────────────────────────────────

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

// ── Categorías ───────────────────────────────────────────────────────────────

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
  // SQLite no enforza FK ON DELETE sin PRAGMA foreign_keys=ON; limpiamos a mano.
  db.transaction(() => {
    db.run(`UPDATE products SET category_id = NULL, subcategory_id = NULL WHERE category_id = ?`, [id]);
    db.run(`DELETE FROM subcategories WHERE category_id = ?`, [id]);
    db.run(`DELETE FROM categories WHERE id = ?`, [id]);
  })();
}

// ── Subcategorías ────────────────────────────────────────────────────────────

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

// ── Productos ────────────────────────────────────────────────────────────────

export function getProducts() {
  return db.query<Product, []>(`SELECT * FROM products ORDER BY sort_order ASC, id DESC`).all();
}

export function getProduct(id: number) {
  return db.query<Product, [number]>(`SELECT * FROM products WHERE id = ?`).get(id);
}

export function getFeaturedProducts(): Product[] {
  return db
    .query<Product, []>(
      `SELECT * FROM products WHERE featured = 1 ORDER BY featured_order ASC, sort_order ASC, id DESC`,
    )
    .all();
}

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
