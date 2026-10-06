import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { sql } from "./db";
import { UserError } from "./errors";
import { generate, parseJsonReply } from "./ai";
import { runJob } from "./agent-jobs";

// ===========================================================================
// Perfil de cliente ideal, enriquecimiento de empresas desde su web y
// cualificación de los leads (encaja / no encaja / falta saber).
//
// Mientras el perfil esté vacío, nadie se descarta: los leads quedan «sin
// perfil» y la puntuación de siempre sigue funcionando.
// ===========================================================================

export type Icp = {
  sectors: string[]; min_employees: number | null; max_employees: number | null; countries: string[]; roles: string[];
  exclusions: string[]; must_have: string | null; framework: string | null; updated_at: Date;
};

export async function getIcp(): Promise<Icp> {
  const [i] = await sql<Icp[]>`SELECT sectors, min_employees, max_employees, countries, roles, exclusions, must_have, framework, updated_at FROM icp_profile`;
  return i;
}

export const icpEmpty = (i: Icp) =>
  !i.sectors.length && i.min_employees === null && i.max_employees === null && !i.countries.length && !i.roles.length
  && !i.exclusions.length && !i.must_have?.trim() && !i.framework?.trim();

export async function saveIcp(data: Record<string, unknown>) {
  const list = (k: string) => [...new Set(String(data[k] ?? "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean))].slice(0, 40).map((x) => x.slice(0, 80));
  const int = (k: string) => {
    const v = String(data[k] ?? "").trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new UserError("El número de empleados tiene que ser un número entero.");
    return n;
  };
  const min = int("min_employees"), max = int("max_employees");
  if (min !== null && max !== null && min > max) throw new UserError("El mínimo de empleados es mayor que el máximo.");
  await sql`UPDATE icp_profile SET sectors = ${list("sectors")}::text[], min_employees = ${min}, max_employees = ${max},
                   countries = ${list("countries")}::text[], roles = ${list("roles")}::text[], exclusions = ${list("exclusions")}::text[],
                   must_have = ${String(data.must_have ?? "").trim().slice(0, 3000) || null},
                   framework = ${String(data.framework ?? "").trim().slice(0, 3000) || null}, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Enriquecimiento desde la web de la empresa

const COUNTRY_BY_TLD: Record<string, string> = {
  es: "España", pt: "Portugal", fr: "Francia", de: "Alemania", it: "Italia", mx: "México", ar: "Argentina", co: "Colombia", cl: "Chile",
  pe: "Perú", uk: "Reino Unido", pl: "Polonia", nl: "Países Bajos", be: "Bélgica", ie: "Irlanda", ch: "Suiza", at: "Austria", uy: "Uruguay",
};
export const countryFromDomain = (domain: string) => COUNTRY_BY_TLD[domain.toLowerCase().split(".").pop() ?? ""] ?? null;

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd]|fe80)/i;

/** Solo webs públicas: nada de direcciones internas (salvo en pruebas locales). */
async function assertPublic(url: URL) {
  if (process.env.ALLOW_PRIVATE_WEBHOOKS) return;
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Protocolo no permitido");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some((a) => PRIVATE.test(a))) throw new Error("Dirección no pública");
}

export type WebFacts = { url: string; title: string | null; description: string | null; lang: string | null; text: string };

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

/** Lee la portada de una web (máx. 600 KB, 8 s, 3 redirecciones). */
export async function readWebsite(domain: string): Promise<WebFacts | null> {
  const tpl = process.env.ENRICH_URL_TEMPLATE;
  let url = new URL(tpl ? tpl.replace("{domain}", encodeURIComponent(domain)) : `https://${domain}/`);
  for (let i = 0; i < 4; i++) {
    await assertPublic(url);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 (compatible; CRM-enriquecimiento/1)", accept: "text/html" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { url = new URL(res.headers.get("location")!, url); continue; }
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
        if (html.length > 600_000) { await reader.cancel(); break; }
      }
    }
    const meta = (name: string) => decode((new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)
      ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i").exec(html))?.[1]?.trim() ?? "") || null;
    const title = decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "") || meta("og:title");
    const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 4000);
    return { url: url.toString(), title: title?.slice(0, 300) ?? null, description: (meta("description") ?? meta("og:description"))?.slice(0, 600) ?? null,
             lang: /<html[^>]+lang=["']([^"']+)["']/i.exec(html)?.[1] ?? null, text };
  }
  return null;
}

/** Enriquecer una empresa: solo rellena lo que está vacío (lo escrito a mano manda). */
export async function enrichOrganization(orgId: string): Promise<boolean> {
  const [o] = await sql<{ id: string; name: string; domain: string | null; industry: string | null; employee_count: number | null;
                          country: string | null; city: string | null; website: string | null; description: string | null }[]>`
    SELECT id, name, domain, industry, employee_count, country, city, website, description FROM organizations WHERE id = ${orgId}`;
  if (!o?.domain) return false;
  let web: WebFacts | null = null;
  try { web = await readWebsite(o.domain); } catch { web = null; }
  const ai = web ? parseJsonReply<{ sector?: string; empleados_aprox?: number; pais?: string; ciudad?: string; descripcion?: string }>(
    await generate("enrich_company", { empresa: o.name, dominio: o.domain, web: { titulo: web.title, descripcion: web.description, idioma: web.lang, texto: web.text.slice(0, 3000) } },
                   { maxTokens: 400 })) : null;
  const employees = Number(ai?.empleados_aprox);
  const found = {
    website: o.website ?? (web ? `https://${o.domain}` : null),
    description: o.description ?? (ai?.descripcion?.trim().slice(0, 600) || web?.description || web?.title || null),
    industry: o.industry ?? (ai?.sector?.trim().slice(0, 100) || null),
    employee_count: o.employee_count ?? (Number.isFinite(employees) && employees > 0 ? Math.round(employees) : null),
    country: o.country ?? (ai?.pais?.trim().slice(0, 80) || countryFromDomain(o.domain)),
    city: o.city ?? (ai?.ciudad?.trim().slice(0, 80) || null),
  };
  await sql`UPDATE organizations SET website = ${found.website}, description = ${found.description}, industry = ${found.industry},
                   employee_count = ${found.employee_count}, country = ${found.country}, city = ${found.city}, enriched_at = now(),
                   enrichment = ${sql.json({ source: web?.url ?? null, ai: Boolean(ai), title: web?.title ?? null } as never)}
            WHERE id = ${orgId}`;
  return Boolean(web);
}

/** Trabajo: empresas recientes con dominio y sin enriquecer. */
export async function runEnrichment(): Promise<string | number | null> {
  return runJob("lead_enrich", async () => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM organizations WHERE domain IS NOT NULL AND enriched_at IS NULL AND deleted_at IS NULL AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC LIMIT 8`;
    let n = 0;
    for (const r of rows) if (await enrichOrganization(r.id).catch(() => false)) n++;
    return n;
  });
}

// ---------------------------------------------------------------------------
// Cualificación

export type Fit = "fit" | "no_fit" | "unknown";
export const FIT_LABEL: Record<Fit, string> = { fit: "Encaja", no_fit: "No encaja", unknown: "Falta saber" };
export type LeadFit = { fit: Fit; reason: string; missing: string[] };

type QualFacts = {
  id: string; title: string; job_title: string | null; industry: string | null; employee_count: number | null; country: string | null;
  domain: string | null; organization: string | null; description: string | null; message: string | null; source: string | null;
};

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const like = (a: string, b: string) => { const x = norm(a), y = norm(b); return x.includes(y) || y.includes(x); };
const COUNTRY_ALIASES: Record<string, string> = { es: "espana", spain: "espana", pt: "portugal", fr: "francia", france: "francia", de: "alemania",
  germany: "alemania", it: "italia", italy: "italia", mx: "mexico", uk: "reino unido", gb: "reino unido", "united kingdom": "reino unido", pl: "polonia", poland: "polonia" };
const country = (c: string) => COUNTRY_ALIASES[norm(c)] ?? norm(c);

/** Encaje con el perfil por reglas (lo que se sabe con certeza). */
export function ruleFit(icp: Icp, f: QualFacts): LeadFit {
  const no: string[] = [], yes: string[] = [], missing: string[] = [];
  const haystack = [f.domain, f.industry, f.description, f.organization].filter(Boolean).join(" ");
  const excluded = icp.exclusions.find((x) => haystack && norm(haystack).includes(norm(x)));
  if (excluded) return { fit: "no_fit", reason: `Coincide con una exclusión: «${excluded}».`, missing: [] };
  if (icp.sectors.length) {
    if (!f.industry) missing.push("sector");
    else if (icp.sectors.some((s) => like(f.industry!, s))) yes.push(`sector ${f.industry}`);
    else no.push(`sector ${f.industry} (buscáis ${icp.sectors.join(", ")})`);
  }
  if (icp.min_employees !== null || icp.max_employees !== null) {
    const range = `${icp.min_employees ?? 0}–${icp.max_employees ?? "∞"}`;
    if (f.employee_count === null) missing.push("tamaño de la empresa");
    else if ((icp.min_employees === null || f.employee_count >= icp.min_employees) && (icp.max_employees === null || f.employee_count <= icp.max_employees)) yes.push(`${f.employee_count} empleados`);
    else no.push(`${f.employee_count} empleados (buscáis ${range})`);
  }
  if (icp.countries.length) {
    if (!f.country) missing.push("país");
    else if (icp.countries.some((c) => country(c) === country(f.country!))) yes.push(f.country);
    else no.push(`país ${f.country}`);
  }
  if (icp.roles.length) {
    if (!f.job_title) missing.push("cargo del contacto");
    else if (icp.roles.some((r) => norm(f.job_title!).includes(norm(r)))) yes.push(`cargo ${f.job_title}`);
    else missing.push(`un contacto con cargo de ${icp.roles.slice(0, 3).join(" / ")}`);
  }
  if (no.length) return { fit: "no_fit", reason: `No encaja: ${no.join("; ")}.`, missing };
  if (missing.length) return { fit: "unknown", reason: yes.length ? `Encaja en ${yes.join(", ")}; falta saber ${missing.join(", ")}.` : `Falta saber ${missing.join(", ")}.`, missing };
  return { fit: "fit", reason: yes.length ? `Encaja: ${yes.join(", ")}.` : "Encaja con el perfil.", missing: [] };
}

export async function qualifyLead(leadId: string, icp?: Icp): Promise<LeadFit | null> {
  const profile = icp ?? await getIcp();
  const [f] = await sql<QualFacts[]>`
    SELECT l.id, l.title, po.job_title, o.industry, o.employee_count, o.country, o.domain, o.name AS organization, o.description, l.source,
           (SELECT content FROM notes n WHERE n.lead_id = l.id ORDER BY created_at LIMIT 1) AS message
    FROM leads l
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations WHERE person_id = l.person_id AND status = 'current' ORDER BY created_at DESC LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = coalesce(l.organization_id, po.organization_id)
    WHERE l.id = ${leadId}`;
  if (!f) return null;
  let r: LeadFit;
  if (icpEmpty(profile)) {
    r = { fit: "unknown", reason: "Sin perfil de cliente ideal: defínelo en Ajustes para cualificar.", missing: [] };
  } else {
    r = ruleFit(profile, f);
    // Con IA y criterios en texto libre (o datos dudosos), la IA decide con el contexto completo.
    if (r.fit !== "no_fit" && (profile.must_have || profile.framework || r.fit === "unknown")) {
      const ai = parseJsonReply<{ encaje?: string; motivo?: string; falta?: string[] }>(await generate("qualify_lead", {
        perfil: { sectores: profile.sectors, empleados: [profile.min_employees, profile.max_employees], paises: profile.countries, cargos: profile.roles,
                  exclusiones: profile.exclusions, otros_criterios: profile.must_have, como_cualificamos: profile.framework },
        lead: { contacto: f.title, cargo: f.job_title, empresa: f.organization, sector: f.industry, empleados: f.employee_count, pais: f.country,
                web: f.domain, a_que_se_dedica: f.description, mensaje: f.message?.slice(0, 1500), origen: f.source },
        segun_las_reglas: r,
      }, { maxTokens: 400 }));
      const map: Record<string, Fit> = { encaja: "fit", no_encaja: "no_fit", falta_info: "unknown" };
      if (ai?.encaje && map[ai.encaje] && ai.motivo) r = { fit: map[ai.encaje], reason: `${ai.motivo.trim().slice(0, 400)} (IA)`, missing: (ai.falta ?? []).map(String).slice(0, 5) };
    }
  }
  await sql`UPDATE leads SET fit = ${r.fit}, fit_reason = ${r.reason}, fit_missing = ${r.missing}::text[], qualified_at = now() WHERE id = ${leadId}`;
  return r;
}

/** Trabajo: leads abiertos sin cualificar (o cualificados antes del último cambio de perfil). */
export async function runQualification(): Promise<string | number | null> {
  return runJob("lead_qualify", async () => {
    const icp = await getIcp();
    const rows = await sql<{ id: string }[]>`
      SELECT l.id FROM leads l
      WHERE l.status = 'open' AND l.deleted_at IS NULL
        AND (l.qualified_at IS NULL OR l.qualified_at < ${icp.updated_at}
             OR (l.fit = 'unknown' AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = l.organization_id AND o.enriched_at > l.qualified_at)))
      ORDER BY l.created_at DESC LIMIT 25`;
    for (const r of rows) await qualifyLead(r.id, icp);
    return rows.length;
  });
}
