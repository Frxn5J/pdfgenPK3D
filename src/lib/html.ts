import { join } from "path";
import * as fs from "fs";

export const formString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return formString(value[0]);
  return "";
};

export const formStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : ""));
  if (typeof value === "string") return [value];
  return [];
};

export const formFile = (value: unknown): File | null => {
  if (value instanceof File && value.size > 0) return value;
  if (Array.isArray(value)) return value.map(formFile).find(Boolean) || null;
  return null;
};

export const safeFilename = (name: string) => name.replace(/[^a-zA-Z0-9.-]/g, "_");

export const isFontFile = (file: File) => /\.(woff2?|ttf|otf)$/i.test(file.name);

export const saveUpload = async (file: File, folder: string, prefix: string) => {
  const uploadDir = join(process.cwd(), "data", "uploads", folder);
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${safeFilename(file.name)}`;
  const uploadPath = join(uploadDir, filename);
  const buffer = await file.arrayBuffer();
  fs.writeFileSync(uploadPath, Buffer.from(buffer));
  return `/uploads/${folder}/${filename}`;
};

// Detecta el tipo real de imagen por magic bytes (no por extensión/MIME del
// cliente). Devuelve la extensión segura o null si no es una imagen permitida.
export const sniffImageExtension = (buf: Buffer): "png" | "jpg" | "gif" | "webp" | null => {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";
  return null;
};

// Guarda una imagen subida validando su contenido real y forzando la extensión
// derivada del tipo detectado (ignora la del nombre original). Evita que un
// .svg/.html con cabecera falsa se sirva como contenido ejecutable. Lanza si el
// archivo no es una imagen permitida o supera el tamaño máximo.
const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const saveImageUpload = async (file: File, folder: string, prefix: string) => {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("La imagen supera el tamaño máximo permitido (10 MB).");
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const ext = sniffImageExtension(bytes);
  if (!ext) throw new Error("Archivo de imagen no válido. Usa PNG, JPG, WebP o GIF.");
  const uploadDir = join(process.cwd(), "data", "uploads", folder);
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}.${ext}`;
  fs.writeFileSync(join(uploadDir, filename), bytes);
  return folder ? `/uploads/${folder}/${filename}` : `/uploads/${filename}`;
};

export const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => htmlEntities[char] || char);

export const configValue = (config: Record<string, string>, key: string, fallback = "") =>
  escapeHtml(config[key] || fallback);

export const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";
