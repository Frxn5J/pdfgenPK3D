import { settingValue } from "./llm";
import { cleanText, decodeEntities, metaContent, tagText, uniqueImages, collectImageCandidates } from "./text";

export type PrintProfile = {
  id: string;
  name: string;
  filamentGrams: number;
  printTimeMins: number;
  filamentType: string;
  filamentColor: string;
};

export type MakerWorldCollectionItem = {
  id: string;
  title: string;
  thumbnail: string;
  itemUrl: string;
  summary: string;
};

export type MakerWorldDraft = {
  sourceUrl: string;
  name: string;
  description: string;
  images: string[];
  printProfiles: PrintProfile[];
};

export const normalizeMakerWorldUrl = (rawUrl: string) => {
  const url = new URL(rawUrl);
  if (!url.hostname.endsWith("makerworld.com")) throw new Error("El link debe ser de makerworld.com");
  if (!url.pathname.startsWith("/es/") && /^\/(en|zh|de|fr|it|ja|sv|pt|ko)\//.test(url.pathname)) {
    url.pathname = url.pathname.replace(/^\/[a-z]{2}\//, "/es/");
  }
  return url.toString();
};

export const isMakerWorldCollection = (rawUrl: string) => {
  try { return /\/collections\//i.test(new URL(rawUrl).pathname); } catch { return false; }
};

export const isCloudflareChallenge = (html: string) => {
  if (!html) return true;
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
  if (title === "Just a moment..." || title === "Just a moment…") return true;
  if (/Checking if the site connection is secure/i.test(html)) return true;
  if (html.length < 50000 && /cdn-cgi\/challenge-platform/i.test(html)) return true;
  return false;
};

const flaresolverrUrl = () => settingValue("flaresolverr_url", "FLARESOLVERR_URL", "");

export const fetchViaFlareSolverr = async (targetUrl: string): Promise<string> => {
  const base = flaresolverrUrl();
  if (!base) throw new Error("FLARESOLVERR_URL no está configurada");
  console.log("[MakerWorld/FlareSolverr] POST", base, "→", targetUrl);
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "request.get", url: targetUrl, maxTimeout: 90000 }),
  });
  const rawBody = await res.text();
  console.log("[MakerWorld/FlareSolverr] HTTP", res.status, "body len", rawBody.length);
  if (!res.ok) throw new Error(`FlareSolverr HTTP ${res.status} body=${rawBody.slice(0, 400)}`);
  let payload: { status?: string; message?: string; solution?: { response?: string; status?: number; url?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error(`FlareSolverr devolvió JSON inválido: ${rawBody.slice(0, 400)}`);
  }
  console.log("[MakerWorld/FlareSolverr] payload", { status: payload.status, message: payload.message, solutionStatus: payload.solution?.status, solutionUrl: payload.solution?.url, responseLen: payload.solution?.response?.length });
  if (payload.status !== "ok" || !payload.solution?.response) {
    throw new Error(`FlareSolverr falló: ${payload.message || "respuesta inválida"}`);
  }
  return payload.solution.response;
};

const fetchViaPublicProxy = async (targetUrl: string): Promise<string> => {
  const proxies = [
    (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];
  for (const makeUrl of proxies) {
    try {
      const res = await fetch(makeUrl(targetUrl), {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
      });
      if (res.ok) {
        const html = await res.text();
        if (!isCloudflareChallenge(html)) return html;
      }
    } catch { /* try next proxy */ }
  }
  throw new Error("Los proxies públicos devolvieron el desafío de Cloudflare");
};

export const fetchMakerWorldHtml = async (targetUrl: string): Promise<string> => {
  const errors: string[] = [];
  if (flaresolverrUrl()) {
    try {
      const html = await fetchViaFlareSolverr(targetUrl);
      if (!isCloudflareChallenge(html)) return html;
      errors.push("FlareSolverr devolvió desafío de Cloudflare");
    } catch (e) {
      errors.push(`FlareSolverr: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  try {
    const response = await fetch(targetUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "es-ES,es;q=0.9,en;q=0.8",
      },
    });
    if (response.ok) {
      const html = await response.text();
      if (!isCloudflareChallenge(html)) return html;
      errors.push("Fetch directo devolvió desafío de Cloudflare");
    } else {
      errors.push(`Fetch directo HTTP ${response.status}`);
    }
  } catch (e) {
    errors.push(`Fetch directo: ${e instanceof Error ? e.message : "error"}`);
  }
  try {
    return await fetchViaPublicProxy(targetUrl);
  } catch (e) {
    errors.push(`Proxies públicos: ${e instanceof Error ? e.message : "error"}`);
  }
  throw new Error(`No se pudo descargar la página de MakerWorld. ${errors.join("; ")}`);
};

export const scrapeMakerWorld = async (rawUrl: string, clientHtml?: string): Promise<MakerWorldDraft> => {
  const sourceUrl = normalizeMakerWorldUrl(rawUrl);
  const html = clientHtml && !isCloudflareChallenge(clientHtml)
    ? clientHtml
    : await fetchMakerWorldHtml(sourceUrl);
  const nextRaw = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let design: Record<string, any> | undefined;
  if (nextRaw) {
    try {
      const nextData = JSON.parse(decodeEntities(nextRaw));
      design = nextData?.props?.pageProps?.design;
    } catch {
      design = undefined;
    }
  }
  const title = cleanText(design?.title || metaContent(html, "og:title") || tagText(html, "title")).replace(/ - Free 3D Print Model - MakerWorld$/i, "");
  const description = cleanText(design?.summary || metaContent(html, "description") || metaContent(html, "og:description"));
  const images = uniqueImages([
    design?.coverUrl,
    ...(collectImageCandidates(design) || []),
    metaContent(html, "og:image"),
    ...Array.from(html.matchAll(/https:\/\/makerworld\.bblmw\.com[^"'<>\s]+\.(?:png|jpe?g|webp)(?:\?[^"'<>\s]*)?/gi)).map((match) => match[0]),
  ]);
  const printProfiles: PrintProfile[] = [];
  const instanceFiles: any[] = Array.isArray(design?.instances) ? design.instances : [];
  for (let i = 0; i < instanceFiles.length; i++) {
    const inst = instanceFiles[i];
    const ps = inst?.profileSetting || inst?.instanceSetting || inst?.profile || {};
    const filamentArr: any[] = Array.isArray(ps?.filamentInfo) ? ps.filamentInfo : Array.isArray(ps?.filaments) ? ps.filaments : [];
    const fi = filamentArr[0] || {};
    const rawTime = Number(ps?.printTime ?? inst?.printTime ?? 0);
    const printTimeMins = rawTime > 3600 ? Math.round(rawTime / 60) : rawTime;
    const filamentGrams = Math.round(Number(ps?.weight ?? ps?.filamentWeight ?? inst?.weight ?? 0) * 10) / 10;
    if (printTimeMins > 0 || filamentGrams > 0) {
      printProfiles.push({
        id: String(inst?.id ?? i),
        name: cleanText(inst?.name || inst?.title || `Perfil ${i + 1}`),
        filamentGrams,
        printTimeMins,
        filamentType: cleanText(fi?.type || fi?.filamentType || ""),
        filamentColor: String(fi?.color || fi?.filamentColor || ""),
      });
    }
  }
  if (!printProfiles.length && instanceFiles.length > 0) {
    console.log("[Profile debug] instances[0]:", JSON.stringify(instanceFiles[0]).slice(0, 500));
  }
  return { sourceUrl, name: title || "Producto MakerWorld", description, images, printProfiles };
};

export const scrapeMakerWorldCollection = async (rawUrl: string, clientHtml?: string): Promise<MakerWorldCollectionItem[]> => {
  const sourceUrl = normalizeMakerWorldUrl(rawUrl);
  const html = clientHtml && !isCloudflareChallenge(clientHtml)
    ? clientHtml
    : await fetchMakerWorldHtml(sourceUrl);
  const nextRaw = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!nextRaw) throw new Error("No se encontraron datos de la colección en la página");
  let pageProps: Record<string, any> = {};
  try {
    const nextData = JSON.parse(decodeEntities(nextRaw));
    pageProps = nextData?.props?.pageProps || {};
  } catch {
    throw new Error("No se pudo parsear los datos de la colección");
  }
  const designs: any[] = (
    pageProps?.favoriteDesigns?.hits ||
    pageProps?.favorite?.designs ||
    pageProps?.collectionDetail?.designs ||
    pageProps?.collection?.designs ||
    pageProps?.designs ||
    []
  );
  if (!designs.length) throw new Error("No se encontraron artículos en esta colección. Puede estar vacía o requerir sesión iniciada en MakerWorld.");
  return designs.map((d: any) => {
    const id = String(d.id || d.designId || "");
    const handle = String(d.handle || d.slug || "");
    const itemUrl = `https://makerworld.com/es/models/${handle ? `${id}-${handle}` : id}`;
    return {
      id,
      title: cleanText(d.title || d.name || `Artículo ${id}`),
      thumbnail: String(d.coverUrl || d.cover || d.thumbnail || ""),
      itemUrl,
      summary: cleanText(d.summary || d.description || ""),
    };
  }).filter((item: MakerWorldCollectionItem) => item.id);
};
