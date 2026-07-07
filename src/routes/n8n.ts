import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import { createQuote, getConfig, getProducts, getCategories, getDefaultPriceTiers, getProductPriceTiers, updateQuoteMessage } from "../db/schema";
import { sendPushToAll } from "../pwa";
import { join } from "path";
import * as fs from "fs";

// ── Helpers ─────────────────────────────────────────────────────────────────

const UPLOADS_DIR = join(import.meta.dir, "..", "..", "data", "uploads");

/** Descarga una imagen desde una URL, la valida y la guarda en data/uploads/.
 *  Devuelve la ruta de acceso público (ej. /uploads/n8n-abc.jpg) o null si falla. */
async function downloadImage(url: string, prefix: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) return null;

    const ext = contentType.split("/").pop() || "jpg";
    const buf = await res.arrayBuffer();
    // Validar magic bytes mínimos (PNG, JPG, GIF, WebP)
    const header = new Uint8Array(buf.slice(0, 4));
    const valid =
      (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) || // PNG
      (header[0] === 0xff && header[1] === 0xd8) ||                                            // JPEG
      (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) ||                      // GIF
      (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46);  // WebP (RIFF)
    if (!valid) return null;

    const filename = `${prefix}.${ext}`;
    const filePath = join(UPLOADS_DIR, filename);
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(buf));
    return `/uploads/${filename}`;
  } catch {
    return null;
  }
}

// ── Endpoint(s) para automatización externa (n8n), servidor-a-servidor ─────
// A diferencia de POST /api/quotes (público, protegido solo por rate-limit de
// IP), estas rutas se autentican con un bearer token estático en
// process.env.N8N_API_KEY. No hay rate-limit por IP aquí: la auth por API key
// ya cumple ese rol.
const n8nRoutes = new Hono();

const currency = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

const normalizeWhatsappNumber = (value: string) => {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  return digits || "524961266304";
};

const numberConfig = (value: unknown, fallback: number) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const integerConfig = (value: unknown, fallback: number) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const shippingForPieces = (config: Record<string, string>, totalPieces: number) => {
  const freeMinPieces = integerConfig(config.free_shipping_min_pieces, 501);
  const settings = {
    provider: String(config.shipping_provider || "Estafeta").trim() || "Estafeta",
    price: Math.max(0, numberConfig(config.shipping_price, 150)),
    freeMinPieces: freeMinPieces > 0 ? freeMinPieces : null,
  };
  const cost = settings.freeMinPieces && totalPieces >= settings.freeMinPieces ? 0 : settings.price;
  return { ...settings, cost };
};

const tierForQuantity = <T extends { min_volume: number; max_volume: number | null }>(tiers: T[], totalPieces: number) => {
  const sorted = [...tiers].sort((a, b) => a.min_volume - b.min_volume);
  if (sorted.length === 0) return null;
  return sorted.find((tier) => totalPieces >= tier.min_volume && (!tier.max_volume || totalPieces <= tier.max_volume)) || sorted[0];
};

const getCatalogData = () => {
  const config = getConfig();
  const defaultPriceTiers = getDefaultPriceTiers();
  const products = getProducts();
  const productsWithTiers = products.map((product) => ({
    product,
    priceTiers: product.use_default_pricing ? defaultPriceTiers : getProductPriceTiers(product.id),
  }));
  return { config, productsWithTiers };
};

type QuoteLine = {
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  tier: { min_volume: number; max_volume: number | null; delivery_time: string | null } | null;
  imageUrl?: string;
};

// Mensaje de texto plano equivalente al del endpoint público, sin las
// secciones HTML/WhatsApp que ahí solo aplican a la UI del catálogo.
const buildQuoteMessage = (input: {
  quoteId?: number;
  customerName: string;
  postalCode: string;
  requiresInvoice: boolean;
  totalPieces: number;
  lines: QuoteLine[];
  subtotal: number;
  iva: number;
  shippingProvider: string;
  shippingCost: number;
  grandTotal: number;
}): string => {
  const hasMissingPrice = input.lines.some((line) => !line.tier);
  const itemLines = input.lines.map((line) => {
    const unit = line.tier ? currency.format(line.unitPrice) : "A cotizar";
    const subtotal = line.tier ? currency.format(line.subtotal) : "A cotizar";
    return `- ${line.productName} x${line.quantity}: ${unit} c/u = ${subtotal}`;
  }).join("\n");
  const ivaLine = input.requiresInvoice ? `IVA (16%): ${hasMissingPrice ? "A cotizar" : currency.format(input.iva || 0)}\n` : "";
  const folioLine = input.quoteId ? `Folio: #${input.quoteId}\n` : "";
  return `${folioLine}Cliente: ${input.customerName}\nCódigo postal: ${input.postalCode}\n\n${itemLines}\n\nSubtotal: ${hasMissingPrice ? "A cotizar" : currency.format(input.subtotal)}\n${ivaLine}Envío (${input.shippingProvider}): ${input.shippingCost > 0 ? currency.format(input.shippingCost) : "Gratis"}\nTotal: ${hasMissingPrice ? "A cotizar" : currency.format(input.grandTotal)}\n`;
};

// Compara dos tokens en tiempo constante. Si las longitudes difieren, es
// inválido de inmediato: timingSafeEqual lanza si los buffers no son del
// mismo tamaño, y comparar longitudes primero no filtra info explotable
// (la longitud del token no es secreta).
const isValidApiKey = (received: string, expected: string): boolean => {
  const receivedBuf = Buffer.from(received);
  const expectedBuf = Buffer.from(expected);
  if (receivedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(receivedBuf, expectedBuf);
};

// Devuelve una Response de error si la auth falla, o null si el request puede continuar.
const checkN8nAuth = (c: any) => {
  const apiKey = (process.env.N8N_API_KEY || "").trim();
  if (!apiKey) return c.json({ error: "n8n API no configurada." }, 503);

  const authHeader = c.req.header("authorization") || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token || !isValidApiKey(token, apiKey)) {
    return c.json({ error: "No autorizado." }, 401);
  }
  return null;
};

// ── Catálogo para que el agente/LLM de n8n resuelva nombre de producto → ID ─
n8nRoutes.get("/api/n8n/products", (c) => {
  const authError = checkN8nAuth(c);
  if (authError) return authError;

  const { productsWithTiers } = getCatalogData();
  const categoryById = new Map(getCategories().map((cat) => [cat.id, cat.name]));

  const products = productsWithTiers.map(({ product, priceTiers }) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    category: product.category_id ? categoryById.get(product.category_id) || null : null,
    priceTiers: priceTiers.map((tier) => ({
      minVolume: tier.min_volume,
      maxVolume: tier.max_volume,
      price: tier.price,
      deliveryTime: tier.delivery_time,
    })),
  }));

  return c.json({ products });
});

n8nRoutes.post("/api/n8n/quotes", async (c) => {
  try {
    const authError = checkN8nAuth(c);
    if (authError) return authError;

    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const customerName = String(body.customerName ?? body.customer_name ?? "").trim().slice(0, 200);
    const postalCode = String(body.postalCode ?? body.postal_code ?? "").trim().slice(0, 10);
    const requiresInvoice = Boolean(body.requiresInvoice ?? body.requires_invoice ?? false);
    const rawItems = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
    const condEntrega = String(body.cond_entrega ?? body.cond_entrega ?? "").trim().slice(0, 500);
    const condPago = String(body.cond_pago ?? body.cond_pago ?? "").trim().slice(0, 500);
    const condPrioritario = String(body.cond_prioritario ?? body.cond_prioritario ?? "").trim().slice(0, 500);
    const formaPago = String(body.forma_pago ?? body.forma_pago ?? "").trim().slice(0, 500);

    if (!customerName || !postalCode) {
      return c.json({ error: "Nombre y código postal son obligatorios." }, 400);
    }
    if (!/^\d{4,5}$/.test(postalCode)) {
      return c.json({ error: "Código postal inválido." }, 400);
    }
    if (rawItems.length === 0) {
      return c.json({ error: "Agrega al menos un producto para cotizar." }, 400);
    }

    const { config, productsWithTiers } = getCatalogData();
    const productMap = new Map(productsWithTiers.map((entry) => [entry.product.id, entry]));
    // Items sin imageUrl se deduplican por productId; los que tienen imageUrl
    // se mantienen como líneas separadas (cada llavero personalizado es único).
    // Si el item ya trae unitPrice pre-calculado (desde LLM), se usa directo.
    const selectedMap = new Map<string, {
      product: typeof productsWithTiers[number]["product"],
      priceTiers: typeof productsWithTiers[number]["priceTiers"],
      quantity: number,
      imageUrl?: string,
      overrideUnitPrice?: number,
      overrideSubtotal?: number,
    }>();
    let imageItemIdx = 0;

    for (const rawItem of rawItems) {
      const item = rawItem as Record<string, unknown>;
      const productId = Number.parseInt(String(item.productId ?? item.product_id ?? item.id ?? ""), 10);
      const quantity = Math.min(100000, Math.max(1, Number.parseInt(String(item.quantity ?? "1"), 10) || 1));
      const imageUrl = String(item.imageUrl ?? item.image_url ?? "").trim() || undefined;
      const overrideUnitPrice = Number(item.unitPrice ?? item.unit_price);
      const overrideSubtotal = Number(item.subtotal);
      const productEntry = productMap.get(productId);
      if (!productEntry) continue;

      const hasOverride = Number.isFinite(overrideUnitPrice) && overrideUnitPrice > 0;
      const extra = hasOverride ? { overrideUnitPrice, overrideSubtotal: Number.isFinite(overrideSubtotal) ? overrideSubtotal : overrideUnitPrice * quantity } : {};

      if (imageUrl) {
        // Item con imagen → línea independiente
        const key = `img_${imageItemIdx++}`;
        selectedMap.set(key, { ...productEntry, quantity, imageUrl, ...extra });
      } else {
        // Item sin imagen → deduplicar por productId
        const existing = selectedMap.get(String(productId));
        if (existing?.overrideUnitPrice) {
          // Si el existente ya tiene precio fijo, sumar cantidades
          selectedMap.set(String(productId), {
            ...existing,
            quantity: existing.quantity + quantity,
          });
        } else if (hasOverride) {
          selectedMap.set(String(productId), { ...productEntry, quantity, ...extra });
        } else {
          selectedMap.set(String(productId), { ...productEntry, quantity: (existing?.quantity || 0) + quantity });
        }
      }
    }

    const totalPieces = Array.from(selectedMap.values()).reduce((total, item) => total + item.quantity, 0);
    if (totalPieces <= 0) {
      return c.json({ error: "No se encontraron productos válidos para cotizar." }, 400);
    }

    // Descargar imágenes ANTES de crear la cotización
    const downloadedImages = new Map<string, string | null>();
    const prefix = `n8n-${Date.now()}`;
    for (const [key, entry] of selectedMap) {
      if (entry.imageUrl) {
        const localUrl = await downloadImage(entry.imageUrl, `${prefix}-${key}`);
        downloadedImages.set(key, localUrl);
      }
    }

    const lines: QuoteLine[] = Array.from(selectedMap.entries()).map(([key, { product, priceTiers, quantity, imageUrl, overrideUnitPrice, overrideSubtotal }]) => {
      const hasOverride = overrideUnitPrice !== undefined && overrideUnitPrice > 0;
      const tier = hasOverride ? null : tierForQuantity(priceTiers, totalPieces);
      const unitPrice = hasOverride ? overrideUnitPrice : (tier ? Number(tier.price) : 0);
      const subtotal = hasOverride && overrideSubtotal !== undefined && overrideSubtotal > 0 ? overrideSubtotal : unitPrice * quantity;
      return {
        productId: product.id,
        productName: product.name,
        quantity,
        unitPrice,
        subtotal,
        tier: tier ? { min_volume: tier.min_volume, max_volume: tier.max_volume, delivery_time: tier.delivery_time } : null,
        imageUrl: imageUrl ? downloadedImages.get(key) || undefined : undefined,
      };
    });

    const subtotal = lines.reduce((sum, line) => sum + line.subtotal, 0);
    const iva = requiresInvoice ? Math.round(subtotal * 0.16 * 100) / 100 : 0;
    const shipping = shippingForPieces(config, totalPieces);
    const grandTotal = subtotal + iva + shipping.cost;
    const whatsappNumber = normalizeWhatsappNumber(config.quote_whatsapp_number || "4961266304");
    const messageWithoutFolio = buildQuoteMessage({
      customerName,
      postalCode,
      requiresInvoice,
      totalPieces,
      lines,
      subtotal,
      iva,
      shippingProvider: shipping.provider,
      shippingCost: shipping.cost,
      grandTotal,
    });

    const quoteId = createQuote({
      customer_name: customerName,
      postal_code: postalCode,
      total_pieces: totalPieces,
      subtotal,
      shipping_provider: shipping.provider,
      shipping_cost: shipping.cost,
      shipping_free_threshold: shipping.freeMinPieces,
      grand_total: grandTotal,
      whatsapp_number: whatsappNumber,
      message: messageWithoutFolio,
      source: "n8n",
      status: "draft",
      cond_entrega: condEntrega,
      cond_pago: condPago,
      cond_prioritario: condPrioritario,
      forma_pago: formaPago,
      items: lines.map((line) => ({
        product_id: line.productId,
        product_name: line.productName,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        subtotal: line.subtotal,
        pricing_min_volume: line.tier?.min_volume ?? null,
        pricing_max_volume: line.tier?.max_volume ?? null,
        delivery_time: line.tier?.delivery_time ?? null,
        custom_image_url: line.imageUrl ?? null,
      })),
    });

    const message = buildQuoteMessage({
      quoteId,
      customerName,
      postalCode,
      requiresInvoice,
      totalPieces,
      lines,
      subtotal,
      iva,
      shippingProvider: shipping.provider,
      shippingCost: shipping.cost,
      grandTotal,
    });
    updateQuoteMessage(quoteId, message);

    // Aviso push al admin. Fire-and-forget: nunca debe bloquear ni romper la
    // respuesta a n8n.
    sendPushToAll({
      title: `Nueva cotización #${quoteId}`,
      body: `${customerName} · ${totalPieces} pza(s) · ${currency.format(grandTotal)}`,
      url: "/admin/quotes",
      tag: `quote-${quoteId}`,
    }).catch((e) => console.warn("[push] quote notify failed", e));

    return c.json({
      id: quoteId,
      message,
      totals: {
        totalPieces,
        subtotal,
        shippingProvider: shipping.provider,
        shippingCost: shipping.cost,
        freeShippingMinPieces: shipping.freeMinPieces,
        grandTotal,
      },
    });
  } catch (error) {
    console.error("[n8n] quotes save failed", error);
    return c.json({ error: "No se pudo guardar la cotización." }, 500);
  }
});

// ── Descargar PDF de cotización (autenticado con bearer token) ────────────
n8nRoutes.get("/api/n8n/pdf/:id", async (c) => {
  try {
    const authError = checkN8nAuth(c);
    if (authError) return authError;

    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "ID inválido." }, 400);

    const { renderQuotePdf } = await import("../lib/pdf");
    const pdfBuf = await renderQuotePdf(id);

    return c.body(pdfBuf, 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="cotizacion-${id}.pdf"`,
    });
  } catch (error: any) {
    console.error("[n8n] pdf download failed", error);
    if (error.message?.includes("no encontrada")) return c.json({ error: "Cotización no encontrada." }, 404);
    return c.json({ error: "No se pudo generar el PDF." }, 500);
  }
});

export { n8nRoutes };
