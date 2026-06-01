import { escapeHtml, formString } from "./html";
import type { PriceTier } from "../db/schema";

export const bodyValues = (body: Record<string, unknown>, key: string) => {
  const value = body[key];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
};

export const parsePriceTiers = (body: Record<string, unknown>): Omit<PriceTier, "id">[] => {
  const mins = bodyValues(body, "tier_min");
  const maxes = bodyValues(body, "tier_max");
  const prices = bodyValues(body, "tier_price");
  const deliveries = bodyValues(body, "tier_delivery");
  return mins.map((min, index) => {
    const minVolume = Number.parseInt(formString(min), 10);
    const maxRaw = formString(maxes[index]);
    const maxVolume = maxRaw ? Number.parseInt(maxRaw, 10) : null;
    const price = Number.parseFloat(formString(prices[index]));
    const deliveryTime = formString(deliveries[index]);
    if (!Number.isFinite(minVolume) || !Number.isFinite(price)) return null;
    return { min_volume: minVolume, max_volume: Number.isFinite(maxVolume) ? maxVolume : null, price, delivery_time: deliveryTime };
  }).filter((tier): tier is Omit<PriceTier, "id"> => Boolean(tier)).sort((a, b) => a.min_volume - b.min_volume);
};

export const renderPriceTierRows = (tiers: Omit<PriceTier, "id">[]) => tiers.map((tier) => `
  <tr>
    <td><input type="number" name="tier_min" min="1" required value="${tier.min_volume}" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="number" name="tier_max" min="1" value="${tier.max_volume ?? ""}" placeholder="Sin límite" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="number" name="tier_price" min="0" step="0.01" required value="${tier.price}" class="w-28 px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><input type="text" name="tier_delivery" value="${escapeHtml(tier.delivery_time)}" class="w-full px-2 py-1 border border-gray-300 rounded-md"></td>
    <td><button type="button" class="remove-tier text-red-600 hover:text-red-800">Quitar</button></td>
  </tr>
`).join("");
