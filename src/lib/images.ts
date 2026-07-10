import { join, resolve, sep } from "path";
import * as fs from "fs";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { isCloudinaryEnabled, uploadImageToCloudinary } from "./cloudinary";

// ── Anti-SSRF ──────────────────────────────────────────────────────────────
// Rechaza IPs internas/privadas para que un fetch a una URL controlada por el
// usuario no alcance loopback, redes privadas ni el endpoint de metadatos cloud
// (169.254.169.254).
const isPrivateIp = (ip: string): boolean => {
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;                       // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
    return false;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;                       // loopback / unspecified
  if (v.startsWith("fe80")) return true;                           // link-local
  if (v.startsWith("fc") || v.startsWith("fd")) return true;       // ULA
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));     // IPv4-mapped
  return false;
};

// Valida que una URL saliente apunte a un host público vía http(s). Lanza si no.
export const assertSafeOutboundUrl = async (rawUrl: string): Promise<void> => {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("URL inválida."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Esquema de URL no permitido.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // sin brackets de IPv6
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("Destino de red no permitido.");
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error("No se pudo resolver el host.");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("Destino de red no permitido.");
  }
};

// Resuelve una referencia "/uploads/..." a una ruta absoluta DENTRO de
// data/uploads, rechazando cualquier traversal ("../") que escape del sandbox.
export const resolveUploadPath = (ref: string): string => {
  const uploadsRoot = resolve(process.cwd(), "data", "uploads");
  const cleaned = ref.trim().replace(/^\/+/, ""); // p. ej. "uploads/products/x.png"
  const candidate = resolve(process.cwd(), "data", cleaned);
  if (candidate !== uploadsRoot && !candidate.startsWith(uploadsRoot + sep)) {
    throw new Error("Ruta de archivo no permitida.");
  }
  return candidate;
};

export const imageExtensionFromMime = (mime: string) => {
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "png";
};

export const saveImageBuffer = async (buffer: ArrayBuffer | Uint8Array, mime = "image/png", prefix = "enhanced") => {
  const bytes = buffer instanceof ArrayBuffer ? Buffer.from(new Uint8Array(buffer)) : Buffer.from(buffer);
  // Estándar: Cloudinary primero; fallback local si falla o no está configurado.
  if (isCloudinaryEnabled()) {
    try {
      return await uploadImageToCloudinary(bytes, "products");
    } catch (error) {
      console.error("[cloudinary] subida falló, guardando local:", error);
    }
  }
  const uploadDir = join(process.cwd(), "data", "uploads", "products");
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}.${imageExtensionFromMime(mime)}`;
  fs.writeFileSync(join(uploadDir, filename), bytes);
  return `/uploads/products/${filename}`;
};

export const dataImageToBuffer = (value: string) => {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  return { mime: match[1] || "image/png", buffer: Buffer.from(match[2] || "", "base64") };
};

export const looksLikeBase64Image = (value: string) =>
  value.length > 200 && /^[a-z0-9+/=\s]+$/i.test(value);

export const persistImageReference = async (value: string) => {
  const candidate = value.trim();
  const dataImage = dataImageToBuffer(candidate);
  if (dataImage) return await saveImageBuffer(dataImage.buffer, dataImage.mime, "enhanced");

  if (/^https?:\/\//i.test(candidate)) {
    try {
      await assertSafeOutboundUrl(candidate);
      const response = await fetch(candidate, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Image Enhancer" } });
      const mime = response.headers.get("content-type") || "";
      if (response.ok && mime.startsWith("image/")) {
        return await saveImageBuffer(await response.arrayBuffer(), mime, "enhanced");
      }
    } catch {
      // If the generated URL cannot be downloaded, keep the provider URL.
    }
    return candidate;
  }

  if (looksLikeBase64Image(candidate)) {
    return await saveImageBuffer(Buffer.from(candidate.replace(/\s+/g, ""), "base64"), "image/png", "enhanced");
  }

  throw new Error("El endpoint de mejora no devolvió una imagen válida.");
};

export const extractImageCandidate = (payload: unknown): string => {
  const preferredKeys = new Set(["imageurl", "image_url", "outputurl", "output_url", "url", "image", "result", "b64_json", "base64"]);

  const walk = (value: unknown, key = ""): string => {
    if (typeof value === "string") {
      const text = value.trim();
      const normalizedKey = key.toLowerCase();
      if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) return text;
      if ((normalizedKey.includes("image") || normalizedKey.includes("base64") || normalizedKey.includes("b64")) && looksLikeBase64Image(text)) return text;
      return "";
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item, key);
        if (found) return found;
      }
      return "";
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [entryKey, entryValue] of entries) {
        if (preferredKeys.has(entryKey.toLowerCase())) {
          const found = walk(entryValue, entryKey);
          if (found) return found;
        }
      }
      for (const [entryKey, entryValue] of entries) {
        const found = walk(entryValue, entryKey);
        if (found) return found;
      }
    }
    return "";
  };

  return walk(payload);
};

export const urlToDataUrl = async (url: string): Promise<string> => {
  await assertSafeOutboundUrl(url);
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Image Enhancer" } });
  if (!res.ok) throw new Error(`No se pudo descargar la imagen: HTTP ${res.status}`);
  const mime = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${mime};base64,${buf.toString("base64")}`;
};

export const mimeFromExtension = (path: string) => {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "image/png";
};

export const resolveImageBytes = async (value: string): Promise<{ bytes: Buffer; mime: string }> => {
  const trimmed = value.trim();
  const dataImage = dataImageToBuffer(trimmed);
  if (dataImage) return { bytes: dataImage.buffer, mime: dataImage.mime };
  if (/^\/uploads\//.test(trimmed)) {
    const localPath = resolveUploadPath(trimmed);
    if (!fs.existsSync(localPath)) throw new Error(`No se encontró el archivo local de la imagen: ${trimmed}`);
    return { bytes: fs.readFileSync(localPath), mime: mimeFromExtension(trimmed) };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    await assertSafeOutboundUrl(trimmed);
    const res = await fetch(trimmed, { headers: { "user-agent": "Mozilla/5.0 PIXKEY3D Image Enhancer" } });
    if (!res.ok) throw new Error(`No se pudo descargar la imagen: HTTP ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") || mimeFromExtension(trimmed) };
  }
  if (looksLikeBase64Image(trimmed)) {
    return { bytes: Buffer.from(trimmed.replace(/\s+/g, ""), "base64"), mime: "image/png" };
  }
  throw new Error("No se pudo preparar la imagen para enviar al proveedor.");
};
