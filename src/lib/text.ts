export const stripTags = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

export const decodeEntities = (value: string) =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");

export const cleanText = (value: unknown) =>
  decodeEntities(stripTags(String(value ?? ""))).replace(/\s+/g, " ").trim();

export const metaContent = (html: string, key: string) => {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escapedKey}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escapedKey}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return decodeEntities(match).trim();
  }
  return "";
};

export const tagText = (html: string, tag: string) =>
  cleanText(html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))?.[1] || "");

export const uniqueImages = (values: unknown[]) => {
  const seen = new Set<string>();
  const images: string[] = [];
  const add = (value: unknown) => {
    const url = String(value ?? "").trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    images.push(url);
  };
  values.forEach(add);
  return images.slice(0, 12);
};

export const collectImageCandidates = (value: unknown, output: unknown[] = []): unknown[] => {
  if (!value || output.length > 80) return output;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value) && /\.(png|jpe?g|webp)(\?|$)/i.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageCandidates(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectImageCandidates(item, output);
  }
  return output;
};
