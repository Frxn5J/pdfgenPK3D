import { createHash } from "crypto";
import * as fs from "fs";
import { db } from "../db/client";
import { resolveUploadPath } from "./images";

// ── Cloudinary ───────────────────────────────────────────────────────────────
// Estándar de almacenamiento de imágenes. Configuración por variables de
// entorno: CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
// o bien CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET.
// Sin configurar, todo el flujo de subida cae al almacenamiento local previo
// (/uploads) — nada se rompe en dev ni en tests.
// Subida firmada vía REST API con fetch: evita cargar el SDK oficial por
// ~15 líneas de firma SHA-1.

type CloudinaryConfig = { cloud: string; key: string; secret: string };

const cloudinaryConfig = (): CloudinaryConfig | null => {
  const url = (process.env.CLOUDINARY_URL || "").trim();
  const m = url.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (m) return { key: m[1]!, secret: m[2]!, cloud: m[3]! };
  const cloud = (process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const key = (process.env.CLOUDINARY_API_KEY || "").trim();
  const secret = (process.env.CLOUDINARY_API_SECRET || "").trim();
  return cloud && key && secret ? { cloud, key, secret } : null;
};

export const isCloudinaryEnabled = () => cloudinaryConfig() !== null;

export const isCloudinaryUrl = (url: string) => /^https:\/\/res\.cloudinary\.com\//i.test(url);

// Inserta transformaciones de entrega (formato/calidad automáticos + ancho)
// en una URL de Cloudinary ya subida. Cloudinary las procesa en su CDN.
export const cloudinaryTransformed = (url: string, w: number) =>
  url.replace("/image/upload/", `/image/upload/f_auto,q_auto,w_${w}/`);

export const uploadImageToCloudinary = async (bytes: Buffer | Uint8Array, folder: string): Promise<string> => {
  const config = cloudinaryConfig();
  if (!config) throw new Error("Cloudinary no está configurado.");
  const timestamp = Math.floor(Date.now() / 1000);
  const targetFolder = folder ? `catalogo/${folder}` : "catalogo";
  // Firma: SHA-1 de los parámetros ordenados alfabéticamente + api_secret
  const signature = createHash("sha1")
    .update(`folder=${targetFolder}&timestamp=${timestamp}${config.secret}`)
    .digest("hex");
  const form = new FormData();
  // El tercer argumento (filename) es obligatorio: sin él, FormData manda
  // filename="" y Cloudinary responde "Missing required parameter - file".
  form.append("file", new Blob([bytes instanceof Buffer ? new Uint8Array(bytes) : bytes]), "upload.img");
  form.append("api_key", config.key);
  form.append("timestamp", String(timestamp));
  form.append("folder", targetFolder);
  form.append("signature", signature);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloud}/image/upload`, {
    method: "POST",
    body: form,
  });
  const json = (await res.json().catch(() => null)) as { secure_url?: string; error?: { message?: string } } | null;
  if (!res.ok || !json?.secure_url) {
    throw new Error(`Cloudinary respondió ${res.status}: ${json?.error?.message || "sin secure_url"}`);
  }
  return json.secure_url;
};

// ── Migración de imágenes locales existentes ────────────────────────────────
// Se ejecuta al arrancar (fire-and-forget): sube a Cloudinary cada referencia
// "/uploads/..." de imagen en DB y actualiza la fila con la nueva URL.
// Idempotente: las referencias ya migradas dejan de matchear LIKE '/uploads/%'.
// Los archivos locales NO se borran (respaldo). Las fuentes (.woff2 etc.) se
// quedan locales — Cloudinary es solo para imágenes.

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
// Comprobantes de pago y recibos (quotes.payment_proof_url, expenses.receipt_url)
// NO se migran: son documentos privados y se quedan en el server, protegidos
// por sesión de admin (ver /uploads/payments en app.ts).
const MIGRATION_TARGETS: Array<{ table: string; column: string }> = [
  { table: "products", column: "image_url" },
  { table: "quote_items", column: "custom_image_url" },
];

const folderFromRef = (ref: string) => {
  // "/uploads/products/x.png" -> "products"; "/uploads/x.png" -> ""
  const parts = ref.replace(/^\/uploads\//, "").split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
};

export const migrateLocalImagesToCloudinary = async (): Promise<void> => {
  if (!isCloudinaryEnabled()) return;
  const migratedByRef = new Map<string, string>(); // misma ruta referenciada N veces -> 1 sola subida
  let migrated = 0;
  let failed = 0;

  const uploadRef = async (ref: string): Promise<string | null> => {
    const cached = migratedByRef.get(ref);
    if (cached) return cached;
    const localPath = resolveUploadPath(ref);
    if (!fs.existsSync(localPath)) return null; // referencia rota: se deja como está
    const url = await uploadImageToCloudinary(fs.readFileSync(localPath), folderFromRef(ref));
    migratedByRef.set(ref, url);
    return url;
  };

  for (const { table, column } of MIGRATION_TARGETS) {
    const rows = db
      .query<{ id: number; ref: string }, []>(`SELECT id, ${column} AS ref FROM ${table} WHERE ${column} LIKE '/uploads/%'`)
      .all();
    for (const row of rows) {
      if (!IMAGE_EXT.test(row.ref)) continue;
      try {
        const url = await uploadRef(row.ref);
        if (!url) continue;
        db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [url, row.id]);
        migrated++;
      } catch (error) {
        failed++;
        console.error(`[cloudinary] fallo migrando ${table}.${column} id=${row.id} (${row.ref}):`, error);
      }
    }
  }

  const configRows = db
    .query<{ key: string; value: string }, []>(`SELECT key, value FROM config WHERE value LIKE '/uploads/%'`)
    .all();
  for (const row of configRows) {
    if (!IMAGE_EXT.test(row.value)) continue; // excluye fuentes y otros archivos
    try {
      const url = await uploadRef(row.value);
      if (!url) continue;
      db.run(`UPDATE config SET value = ? WHERE key = ?`, [url, row.key]);
      migrated++;
    } catch (error) {
      failed++;
      console.error(`[cloudinary] fallo migrando config.${row.key} (${row.value}):`, error);
    }
  }

  if (migrated || failed) {
    console.log(`[cloudinary] migración de imágenes: ${migrated} referencias actualizadas, ${failed} fallos.`);
  }
};
