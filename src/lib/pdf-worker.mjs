// Worker para generar PDF con Playwright.
// Bun no puede ejecutar Playwright directamente en Windows,
// así que este script se ejecuta con Node.js vía Bun.spawn.
//
// Uso: node src/lib/pdf-worker.mjs <quoteId> <sessionToken> <port> [key value...]
// Las keys/values adicionales se pasan como query params a la URL de admin.
// Escribe el PDF binario a stdout.

import { chromium } from "playwright";

const args = process.argv.slice(2);
const [quoteId, sessionToken, port, ...rest] = args;

if (!quoteId || !sessionToken || !port) {
  console.error("Uso: node pdf-worker.mjs <quoteId> <sessionToken> <port> [key value...]");
  process.exit(1);
}

// Parsear argumentos extra como pares key=value (ya URL-encoded)
const queryParams = new URLSearchParams();
for (let i = 0; i < rest.length; i += 2) {
  const key = rest[i];
  const val = rest[i + 1];
  if (key && val !== undefined) queryParams.set(key, decodeURIComponent(val));
}
const qs = queryParams.toString();

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();

  await page.context().addCookies([
    {
      name: "admin_session",
      value: sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const baseUrl = `http://localhost:${port}/admin/quotes/${quoteId}/pdf`;
  const url = qs ? `${baseUrl}?${qs}` : baseUrl;

  await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });

  // Esperar a que el script numeroALetras complete
  try {
    await page.waitForSelector("#grand-total-letters", { timeout: 10_000 });
    await page.waitForFunction(
      () => {
        const el = document.getElementById("grand-total-letters");
        return el && el.textContent !== "..." && el.textContent !== "";
      },
      { timeout: 10_000 },
    );
  } catch {
    // Si no se encuentra el selector, continuar de todas formas
  }

  const pdfBuf = await page.pdf({
    format: "Letter",
    printBackground: true,
    margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
  });

  process.stdout.write(pdfBuf);
} finally {
  await browser.close();
}
