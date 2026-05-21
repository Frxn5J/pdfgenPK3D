import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { db, getConfig, updateConfig, getProducts, getProduct, getDefaultPriceTiers } from "../db/schema";
import { join } from "path";
import * as fs from "fs";

// Middleware for admin auth (moved from app.ts to avoid circular dependency)
export const requireAuth = async (c: any, next: any) => {
  const session = getCookie(c, "admin_session");
  // Very basic auth check for prototype
  if (session === "authenticated") {
    await next();
  } else {
    return c.redirect("/admin/login");
  }
};

const adminRoutes = new Hono();

const formString = (value: unknown) => typeof value === "string" ? value : "";
const formFile = (value: unknown) => value instanceof File && value.size > 0 ? value : null;
const safeFilename = (name: string) => name.replace(/[^a-zA-Z0-9.-]/g, "_");
const isFontFile = (file: File) => /\.(woff2?|ttf|otf)$/i.test(file.name);
const saveUpload = async (file: File, folder: string, prefix: string) => {
  const uploadDir = join(process.cwd(), "data", "uploads", folder);
  fs.mkdirSync(uploadDir, { recursive: true });
  const filename = `${prefix}-${Date.now()}-${safeFilename(file.name)}`;
  const uploadPath = join(uploadDir, filename);
  const buffer = await file.arrayBuffer();
  fs.writeFileSync(uploadPath, Buffer.from(buffer));
  return `/uploads/${folder}/${filename}`;
};
const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => htmlEntities[char] || char);
const configValue = (config: Record<string, string>, key: string, fallback = "") => escapeHtml(config[key] || fallback);
const defaultFontFamily = "'Central Bold', Central, Montserrat, Arial, sans-serif";

const AdminLayout = (title: string, content: string) => `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Admin</title>
    <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 font-sans min-h-screen">
    <nav class="bg-blue-800 text-white shadow-md">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div class="flex items-center justify-between h-16">
                <div class="flex items-center">
                    <a href="/admin" class="font-bold text-xl tracking-tight">PIXKEY3D Admin</a>
                    <div class="ml-10 flex items-baseline space-x-4">
                        <a href="/admin/config" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Configuración</a>
                        <a href="/admin/products" class="px-3 py-2 rounded-md text-sm font-medium hover:bg-blue-700">Productos</a>
                        <a href="/" target="_blank" class="px-3 py-2 rounded-md text-sm font-medium text-blue-200 hover:text-white hover:bg-blue-700">Ver Catálogo ↗</a>
                    </div>
                </div>
                <div>
                    <form action="/admin/logout" method="post" class="inline">
                        <button type="submit" class="text-sm font-medium text-blue-200 hover:text-white">Cerrar Sesión</button>
                    </form>
                </div>
            </div>
        </div>
    </nav>
    <main class="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        ${content}
    </main>
</body>
</html>
`;

adminRoutes.get("/login", (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Login - Admin</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 flex items-center justify-center min-h-screen">
        <div class="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
            <h1 class="text-2xl font-bold mb-6 text-center text-gray-800">Administración</h1>
            <form action="/admin/login" method="post" class="space-y-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Usuario</label>
                    <input type="text" name="username" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Contraseña</label>
                    <input type="password" name="password" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                </div>
                <button type="submit" class="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500">
                    Ingresar
                </button>
            </form>
        </div>
    </body>
    </html>
  `);
});

adminRoutes.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const validUsername = process.env.ADMIN_USERNAME || "Frxn5J";
  const validPassword = process.env.ADMIN_PASSWORD;

  if (!validPassword) {
    return c.text("ADMIN_PASSWORD no está configurado en el entorno.", 500);
  }

  if (body.username === validUsername && body.password === validPassword) {
    setCookie(c, "admin_session", "authenticated", {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 // 1 day
    });
    return c.redirect("/admin");
  }

  return c.redirect("/admin/login?error=1");
});

adminRoutes.post("/logout", (c) => {
  deleteCookie(c, "admin_session");
  return c.redirect("/admin/login");
});

// Protect all routes below
adminRoutes.use("/*", requireAuth);

adminRoutes.get("/", (c) => {
  return c.redirect("/admin/products");
});

adminRoutes.get("/config", (c) => {
  const config = getConfig();
  const tiers = getDefaultPriceTiers();

  return c.html(AdminLayout("Configuración", `
    <div class="bg-white shadow rounded-lg p-6 mb-6">
        <h2 class="text-xl font-bold mb-4">Configuración General</h2>
        <form action="/admin/config" method="post" enctype="multipart/form-data" class="space-y-6">
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Nombre de la Empresa</label>
                    <input type="text" name="company_name" value="${configValue(config, "company_name")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Subtítulo de Portada</label>
                    <input type="text" name="cover_subtitle" value="${configValue(config, "cover_subtitle", "Catálogo de Productos")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Título de Sección Productos</label>
                    <input type="text" name="products_title" value="${configValue(config, "products_title", "Nuestros Productos")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Logo (URL o subir archivo)</label>
                    <input type="text" name="company_logo_url" value="${configValue(config, "company_logo")}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                    <input type="file" name="company_logo_file" accept="image/*" class="block w-full text-sm text-gray-500">
                </div>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Bienvenida</label>
                <textarea name="welcome_text" rows="8" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "welcome_text")}</textarea>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Texto de Contacto / Pie de página</label>
                <textarea name="contact_text" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${configValue(config, "contact_text")}</textarea>
            </div>

            <hr class="my-6">
            <h3 class="text-lg font-semibold mb-4">Personalización Visual (Tema)</h3>

            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Primario</label>
                    <input type="color" name="color_primary" value="${configValue(config, "color_primary", "#ef4444")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Secundario</label>
                    <input type="color" name="color_secondary" value="${configValue(config, "color_secondary", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color Acento</label>
                    <input type="color" name="color_accent" value="${configValue(config, "color_accent", "#f87171")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Fondos y Textos de Secciones</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Portada</label>
                    <input type="color" name="bg_cover" value="${configValue(config, "bg_cover", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Portada</label>
                    <input type="color" name="color_cover_text" value="${configValue(config, "color_cover_text", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Bienvenida</label>
                    <input type="color" name="bg_welcome" value="${configValue(config, "bg_welcome", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Productos</label>
                    <input type="color" name="bg_products" value="${configValue(config, "bg_products", "#f9fafb")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Contacto</label>
                    <input type="color" name="bg_contact" value="${configValue(config, "bg_contact", "#1f2937")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Contacto</label>
                    <input type="color" name="color_contact_text" value="${configValue(config, "color_contact_text", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Tarjetas</label>
                    <input type="color" name="bg_card" value="${configValue(config, "bg_card", "#ffffff")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Borde Tarjetas</label>
                    <input type="color" name="color_card_border" value="${configValue(config, "color_card_border", "#e5e7eb")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fondo Encabezado Tabla</label>
                    <input type="color" name="bg_table_header" value="${configValue(config, "bg_table_header", "#f3f4f6")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Encabezado Tabla</label>
                    <input type="color" name="color_table_header_text" value="${configValue(config, "color_table_header_text", "#4b5563")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Tipografía y Colores Generales</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Principal</label>
                    <input type="color" name="color_body_text" value="${configValue(config, "color_body_text", "#374151")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Encabezados</label>
                    <input type="color" name="color_heading_text" value="${configValue(config, "color_heading_text", "#111827")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Texto Secundario (Muted)</label>
                    <input type="color" name="color_muted_text" value="${configValue(config, "color_muted_text", "#6b7280")}" class="mt-1 block w-full h-10 px-1 py-1 border border-gray-300 rounded-md">
                </div>
            </div>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 mt-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fuente Principal (Body)</label>
                    <input type="text" name="font_body" value="${configValue(config, "font_body", defaultFontFamily)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 'Central Bold', Arial, sans-serif">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Fuente Encabezados</label>
                    <input type="text" name="font_heading" value="${configValue(config, "font_heading", defaultFontFamily)}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 'Central Bold', Arial, sans-serif">
                </div>
            </div>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 mt-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Archivo de Fuente Principal</label>
                    ${config.font_body_file ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${configValue(config, "font_body_file")}" target="_blank" class="text-blue-600 underline">${configValue(config, "font_body_file")}</a></p>` : '<p class="text-xs text-gray-500 mt-1">Sin archivo subido. Se usará el nombre de fuente escrito arriba.</p>'}
                    <input type="file" name="font_body_file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" class="mt-2 block w-full text-sm text-gray-500">
                    <label class="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox" name="remove_font_body_file" value="1" class="rounded border-gray-300">
                        Quitar fuente subida del texto principal
                    </label>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Archivo de Fuente Encabezados</label>
                    ${config.font_heading_file ? `<p class="text-xs text-gray-500 mt-1">Actual: <a href="${configValue(config, "font_heading_file")}" target="_blank" class="text-blue-600 underline">${configValue(config, "font_heading_file")}</a></p>` : '<p class="text-xs text-gray-500 mt-1">Sin archivo subido. Se usará el nombre de fuente escrito arriba.</p>'}
                    <input type="file" name="font_heading_file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" class="mt-2 block w-full text-sm text-gray-500">
                    <label class="mt-2 flex items-center gap-2 text-xs text-gray-600">
                        <input type="checkbox" name="remove_font_heading_file" value="1" class="rounded border-gray-300">
                        Quitar fuente subida de encabezados
                    </label>
                </div>
            </div>
            <p class="text-xs text-gray-500 mt-2">Formatos permitidos: .woff, .woff2, .ttf y .otf. Si subes un archivo, se usa primero; el campo de texto queda como respaldo.</p>

            <h4 class="text-md font-semibold mt-6 mb-2">Estilos Visuales</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-3 lg:grid-cols-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700">Redondeo General (Bordes)</label>
                    <input type="text" name="border_radius" value="${configValue(config, "border_radius", "0.5rem")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 0.5rem o 8px">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Redondeo de Botones</label>
                    <input type="text" name="button_radius" value="${configValue(config, "button_radius", "0.5rem")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 9999px para píldora">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Sombra de Tarjetas</label>
                    <input type="text" name="card_shadow" value="${configValue(config, "card_shadow", "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Estilo de Tarjeta</label>
                    <select name="card_style" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="flat" ${config.card_style === 'flat' ? 'selected' : ''}>Plana (Sombra)</option>
                        <option value="bordered" ${config.card_style === 'bordered' ? 'selected' : ''}>Con Borde</option>
                        <option value="minimal" ${config.card_style === 'minimal' ? 'selected' : ''}>Minimalista</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Densidad del Diseño</label>
                    <select name="layout_density" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="comfortable" ${config.layout_density === 'comfortable' ? 'selected' : ''}>Cómoda</option>
                        <option value="compact" ${config.layout_density === 'compact' ? 'selected' : ''}>Compacta</option>
                        <option value="spacious" ${config.layout_density === 'spacious' ? 'selected' : ''}>Amplia</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Ajuste de Imagen Producto</label>
                    <select name="product_image_fit" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="cover" ${config.product_image_fit === 'cover' ? 'selected' : ''}>Cubrir</option>
                        <option value="contain" ${config.product_image_fit === 'contain' ? 'selected' : ''}>Contener</option>
                    </select>
                </div>
            </div>

            <h4 class="text-md font-semibold mt-6 mb-2">Formas Decorativas (Portadas y Secciones)</h4>
            <div class="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                <div class="flex items-center">
                    <input type="checkbox" name="decorative_shapes_enabled" id="decorative_shapes_enabled" value="1" ${config.decorative_shapes_enabled === '1' ? 'checked' : ''} class="h-4 w-4 text-blue-600 border-gray-300 rounded">
                    <label for="decorative_shapes_enabled" class="ml-2 block text-sm font-medium text-gray-700">Habilitar formas decorativas de fondo</label>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Tipo de Formas</label>
                    <select name="decorative_shape_style" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="organic" ${config.decorative_shape_style === 'organic' ? 'selected' : ''}>Orgánicas</option>
                        <option value="circles" ${config.decorative_shape_style === 'circles' ? 'selected' : ''}>Círculos</option>
                        <option value="diagonal" ${config.decorative_shape_style === 'diagonal' ? 'selected' : ''}>Diagonales</option>
                        <option value="dots" ${config.decorative_shape_style === 'dots' ? 'selected' : ''}>Puntos</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Color de Formas (soporta rgba)</label>
                    <input type="text" name="decorative_shape_color" value="${configValue(config, "decorative_shape_color", "rgba(239, 68, 68, 0.1)")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: rgba(255,255,255,0.05)">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Opacidad de Formas</label>
                    <input type="text" name="decorative_shape_opacity" value="${configValue(config, "decorative_shape_opacity", "0.45")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="0 a 1">
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700">Blur de Formas</label>
                    <input type="text" name="decorative_shape_blur" value="${configValue(config, "decorative_shape_blur", "0px")}" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Ej: 16px o 0px">
                </div>
            </div>

            <div class="mt-6">
                <label class="block text-sm font-medium text-gray-700">CSS Personalizado (Avanzado)</label>
                <textarea name="custom_css" rows="6" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md font-mono text-sm" placeholder="/* Añade tus propias reglas CSS aquí */">${configValue(config, "custom_css")}</textarea>
                <p class="text-xs text-gray-500 mt-2">Este CSS se inyecta al catálogo público después del tema. Puedes agregar clases, pseudo-elementos, fondos, formas y reglas de impresión.</p>
            </div>

            <div class="pt-4 border-t">
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Configuración</button>
            </div>
        </form>
    </div>
  `));
});

adminRoutes.post("/config", async (c) => {
  const body = await c.req.parseBody();
  const currentConfig = getConfig();

  let logoUrl = formString(body.company_logo_url);
  let fontBodyFileUrl = body.remove_font_body_file === "1" ? "" : (currentConfig.font_body_file || "");
  let fontHeadingFileUrl = body.remove_font_heading_file === "1" ? "" : (currentConfig.font_heading_file || "");

  // Handle file upload
  const file = formFile(body.company_logo_file);
  if (file) {
    const filename = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    logoUrl = `/uploads/${filename}`;
  }

  const fontBodyFile = formFile(body.font_body_file);
  if (fontBodyFile) {
    if (!isFontFile(fontBodyFile)) return c.text("Formato de fuente principal no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    fontBodyFileUrl = await saveUpload(fontBodyFile, "fonts", "body-font");
  }

  const fontHeadingFile = formFile(body.font_heading_file);
  if (fontHeadingFile) {
    if (!isFontFile(fontHeadingFile)) return c.text("Formato de fuente de encabezados no permitido. Usa .woff, .woff2, .ttf u .otf.", 400);
    fontHeadingFileUrl = await saveUpload(fontHeadingFile, "fonts", "heading-font");
  }

  updateConfig({
    company_name: body.company_name as string,
    company_logo: logoUrl,
    cover_subtitle: body.cover_subtitle as string,
    products_title: body.products_title as string,
    welcome_text: body.welcome_text as string,
    contact_text: body.contact_text as string,
    color_primary: body.color_primary as string,
    color_secondary: body.color_secondary as string,
    color_accent: body.color_accent as string,
    bg_cover: body.bg_cover as string,
    color_cover_text: body.color_cover_text as string,
    bg_welcome: body.bg_welcome as string,
    bg_products: body.bg_products as string,
    bg_contact: body.bg_contact as string,
    color_contact_text: body.color_contact_text as string,
    bg_card: body.bg_card as string,
    color_card_border: body.color_card_border as string,
    bg_table_header: body.bg_table_header as string,
    color_table_header_text: body.color_table_header_text as string,
    color_body_text: body.color_body_text as string,
    color_heading_text: body.color_heading_text as string,
    color_muted_text: body.color_muted_text as string,
    font_body: body.font_body as string,
    font_heading: body.font_heading as string,
    font_body_file: fontBodyFileUrl,
    font_heading_file: fontHeadingFileUrl,
    border_radius: body.border_radius as string,
    button_radius: body.button_radius as string,
    card_shadow: body.card_shadow as string,
    card_style: body.card_style as string,
    layout_density: body.layout_density as string,
    product_image_fit: body.product_image_fit as string,
    decorative_shapes_enabled: (body.decorative_shapes_enabled ? "1" : "0"),
    decorative_shape_style: body.decorative_shape_style as string,
    decorative_shape_color: body.decorative_shape_color as string,
    decorative_shape_opacity: body.decorative_shape_opacity as string,
    decorative_shape_blur: body.decorative_shape_blur as string,
    custom_css: body.custom_css as string,
  });

  return c.redirect("/admin/config");
});

adminRoutes.get("/products", (c) => {
  const products = getProducts();

  return c.html(AdminLayout("Productos", `
    <div class="bg-white shadow rounded-lg overflow-hidden">
        <div class="px-6 py-4 border-b border-gray-200 flex justify-between items-center">
            <h2 class="text-xl font-bold text-gray-800">Catálogo de Productos</h2>
            <a href="/admin/products/new" class="bg-green-600 text-white px-4 py-2 rounded-md hover:bg-green-700 text-sm font-medium">
                + Nuevo Producto
            </a>
        </div>

        <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
                <tr>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Imagen</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Nombre</th>
                    <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Precios</th>
                    <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Acciones</th>
                </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
                ${products.map(p => `
                <tr>
                    <td class="px-6 py-4 whitespace-nowrap">
                        ${p.image_url
                            ? `<img src="${escapeHtml(p.image_url)}" class="h-10 w-10 rounded object-cover">`
                            : `<div class="h-10 w-10 rounded bg-gray-200"></div>`
                        }
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <div class="text-sm font-medium text-gray-900">${escapeHtml(p.name)}</div>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap">
                        <span class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${p.use_default_pricing ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}">
                            ${p.use_default_pricing ? 'Globales' : 'Personalizados'}
                        </span>
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <a href="/admin/products/${p.id}/edit" class="text-indigo-600 hover:text-indigo-900 mr-3">Editar</a>
                        <form action="/admin/products/${p.id}/delete" method="post" class="inline" onsubmit="return confirm('¿Seguro que deseas eliminar este producto?');">
                            <button type="submit" class="text-red-600 hover:text-red-900">Eliminar</button>
                        </form>
                    </td>
                </tr>
                `).join('')}
                ${products.length === 0 ? '<tr><td colspan="4" class="px-6 py-10 text-center text-gray-500">No hay productos. Crea uno nuevo.</td></tr>' : ''}
            </tbody>
        </table>
    </div>
  `));
});

adminRoutes.get("/products/new", (c) => {
  return c.html(AdminLayout("Nuevo Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Agregar Nuevo Producto</h2>
        <form action="/admin/products/new" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Descripción</label>
                <textarea name="description" rows="3" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"></textarea>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Imagen (URL o subir archivo)</label>
                <input type="text" name="image_url" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                <input type="file" name="image_file" accept="image/*" class="block w-full text-sm text-gray-500">
            </div>

            <div>
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="use_default_pricing" name="use_default_pricing" type="checkbox" checked value="1" class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="use_default_pricing" class="font-medium text-gray-700">Usar tabla de precios por volumen global</label>
                        <p class="text-gray-500">Si desmarcas esta opción, podrás definir precios específicos después de guardar.</p>
                    </div>
                </div>
            </div>

            <div class="flex justify-end gap-3 pt-4 border-t">
                <a href="/admin/products" class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300">Cancelar</a>
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Producto</button>
            </div>
        </form>
    </div>
  `));
});

adminRoutes.post("/products/new", async (c) => {
  const body = await c.req.parseBody();

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    const filename = `prod-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    imageUrl = `/uploads/${filename}`;
  }

  const useDefaultPricing = body.use_default_pricing === "1" ? 1 : 0;

  const result = db.query(`
    INSERT INTO products (name, description, image_url, use_default_pricing, sort_order)
    VALUES (?, ?, ?, ?, 0) RETURNING id
  `).get(formString(body.name), formString(body.description) || null, imageUrl || null, useDefaultPricing) as {id: number};

  return c.redirect(useDefaultPricing ? "/admin/products" : `/admin/products/${result.id}/edit`);
});

adminRoutes.post("/products/:id/delete", (c) => {
  const id = c.req.param("id");
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  return c.redirect("/admin/products");
});

// Helper route to just serve edit form
adminRoutes.get("/products/:id/edit", (c) => {
  const id = parseInt(c.req.param("id"));
  const product = getProduct(id);
  if (!product) return c.notFound();

  // Basic implementation to avoid complexity. Just update basic info.
  return c.html(AdminLayout("Editar Producto", `
    <div class="bg-white shadow rounded-lg p-6">
        <h2 class="text-xl font-bold mb-6">Editar Producto: ${escapeHtml(product.name)}</h2>
        <form action="/admin/products/${id}/edit" method="post" enctype="multipart/form-data" class="space-y-6">
            <div>
                <label class="block text-sm font-medium text-gray-700">Nombre del Producto *</label>
                <input type="text" name="name" value="${escapeHtml(product.name)}" required class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Descripción</label>
                <textarea name="description" rows="3" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md">${escapeHtml(product.description || '')}</textarea>
            </div>

            <div>
                <label class="block text-sm font-medium text-gray-700">Imagen actual</label>
                ${product.image_url ? `<img src="${escapeHtml(product.image_url)}" class="h-32 object-contain mb-2 border p-1 rounded">` : '<p class="text-sm text-gray-500 mb-2">Sin imagen</p>'}
                <input type="text" name="image_url" value="${escapeHtml(product.image_url || '')}" placeholder="URL de imagen..." class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md mb-2">
                <input type="file" name="image_file" accept="image/*" class="block w-full text-sm text-gray-500">
                <p class="text-xs text-gray-500 mt-1">Sube una nueva para reemplazar la actual.</p>
            </div>

            <div>
                <div class="flex items-start">
                    <div class="flex items-center h-5">
                        <input id="use_default_pricing" name="use_default_pricing" type="checkbox" value="1" ${product.use_default_pricing ? 'checked' : ''} class="focus:ring-blue-500 h-4 w-4 text-blue-600 border-gray-300 rounded">
                    </div>
                    <div class="ml-3 text-sm">
                        <label for="use_default_pricing" class="font-medium text-gray-700">Usar tabla de precios por volumen global</label>
                    </div>
                </div>
            </div>

            <div class="flex justify-end gap-3 pt-4 border-t">
                <a href="/admin/products" class="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300">Cancelar</a>
                <button type="submit" class="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">Guardar Cambios</button>
            </div>
        </form>
    </div>
  `));
});

adminRoutes.post("/products/:id/edit", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.parseBody();

  let imageUrl = formString(body.image_url);

  // Handle file upload
  const file = formFile(body.image_file);
  if (file) {
    const filename = `prod-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const uploadPath = join(process.cwd(), "data", "uploads", filename);
    const buffer = await file.arrayBuffer();
    fs.writeFileSync(uploadPath, Buffer.from(buffer));
    imageUrl = `/uploads/${filename}`;
  }

  const useDefaultPricing = body.use_default_pricing === "1" ? 1 : 0;

  db.run(`
    UPDATE products SET name = ?, description = ?, image_url = ?, use_default_pricing = ? WHERE id = ?
  `, [formString(body.name), formString(body.description) || null, imageUrl || null, useDefaultPricing, id]);

  return c.redirect("/admin/products");
});

export { adminRoutes };
