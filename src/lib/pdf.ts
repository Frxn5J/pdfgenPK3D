import { chromium } from "playwright";
import { getQuote } from "../db/schema";
import { signSession } from "./session";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

export async function renderQuotePdf(quoteId: number): Promise<Uint8Array> {
  const quote = getQuote(quoteId);
  if (!quote) throw new Error(`Cotización #${quoteId} no encontrada`);

  // Token de sesión admin temporal (1 minuto)
  const token = await signSession({
    id: 0,
    username: "admin",
    role: "admin",
    exp: Date.now() + 60_000,
  });

  const params = new URLSearchParams({
    cond_entrega: quote.cond_entrega ?? "",
    cond_pago: quote.cond_pago ?? "",
    cond_prioritario: quote.cond_prioritario ?? "",
    forma_pago: quote.forma_pago ?? "",
  });
  const url = `http://localhost:${PORT}/admin/quotes/${quoteId}/pdf?${params}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.context().addCookies([
      {
        name: "admin_session",
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 });

    // Esperar a que el script numeroALetras complete
    try {
      await page.waitForSelector("#grand-total-letters", { timeout: 10_000 });
      await page.waitForFunction(
        `(() => {
          const el = document.getElementById("grand-total-letters");
          return !!el && el.textContent !== "..." && el.textContent !== "";
        })()`,
        undefined,
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
    return pdfBuf;
  } finally {
    await browser.close();
  }
}
