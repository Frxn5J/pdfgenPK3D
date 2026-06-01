import type { Quote } from "../db/schema";

export const money = (value: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(value || 0);

export const plainMoney = (value: number) =>
  new Intl.NumberFormat("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value || 0);

export const volumeText = (min: number | null, max: number | null) => {
  if (!min) return "Sin rango";
  return max ? `${min} a ${max} piezas` : `${min} o más piezas`;
};

export const renderStatusBadge = (status: string) => {
  if (status === "despachado") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-green-100 text-green-800 border border-green-200">Despachada</span>`;
  }
  if (status === "produccion") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-blue-100 text-blue-800 border border-blue-200">En Producción</span>`;
  }
  if (status === "finalizado") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-purple-100 text-purple-800 border border-purple-200">Finalizada</span>`;
  }
  if (status === "spam") {
    return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800 border border-red-200">Spam</span>`;
  }
  return `<span class="px-2.5 py-1 text-xs font-bold rounded-full bg-yellow-100 text-yellow-800 border border-yellow-200">No despachada</span>`;
};

export const quoteFolio = (quote: Pick<Quote, "id">) => `COT-${String(quote.id).padStart(3, "0")}`;

export const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("es-MX");
};
