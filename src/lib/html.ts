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
