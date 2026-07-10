import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { initDb } from "./db/schema";
import { ensureSessionSecret } from "./lib/session";
import { publicRoutes } from "./routes/public";
import { adminRoutes } from "./routes/admin";
import { getCookie, setCookie } from "hono/cookie";
import { join } from "path";
import * as fs from "fs";

// Initialize database
initDb();
// Asegura que el secreto de sesión exista (se genera y persiste si falta).
ensureSessionSecret();

const app = new Hono();

app.use("*", logger());

// Cabeceras de seguridad: HSTS (prod tras TLS), nosniff, anti-clickjacking,
// referrer-policy. La CSP es permisiva en scripts/estilos inline porque las
// páginas usan Tailwind CDN (JIT con eval) y mucho JS/CSS inline; aun así fija
// frame-ancestors 'none', object-src 'none' y base-uri 'self' como defensa.
app.use("*", secureHeaders({
  strictTransportSecurity: "max-age=31536000; includeSubDomains",
  xFrameOptions: "SAMEORIGIN",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    frameAncestors: ["'none'"],
  },
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
  },
}));

// Ensure upload directory exists
const uploadDir = join(process.cwd(), "data", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve static files
app.use("/public/*", serveStatic({ root: "./src/" }));
app.use("/uploads/*", serveStatic({ root: "./data/" }));
// For Tailwind output
app.use("/styles.css", serveStatic({ path: "./src/public/styles.css" }));

app.route("/", publicRoutes);
app.route("/admin", adminRoutes);

export { app };