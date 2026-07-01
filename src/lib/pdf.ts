import { getQuote } from "../db/schema";
import { signSession } from "./session";
import { join } from "path";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);

function qs(v: string | null | undefined): string {
  return encodeURIComponent(v ?? "");
}

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

  const workerPath = join(import.meta.dir, "pdf-worker.mjs");

  // Pasar los campos extra como argumentos para que el worker los ponga en la URL
  const extra = [
    "cond_entrega", qs(quote.cond_entrega),
    "cond_pago", qs(quote.cond_pago),
    "cond_prioritario", qs(quote.cond_prioritario),
    "forma_pago", qs(quote.forma_pago),
  ];

  const proc = Bun.spawn(["node", workerPath, String(quoteId), token, String(PORT), ...extra]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`PDF worker failed (exit ${exitCode}): ${stderr}`);
  }

  const buf = await new Response(proc.stdout).arrayBuffer();
  return new Uint8Array(buf);
}
