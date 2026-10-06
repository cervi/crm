import { timingSafeEqual, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { runAutomations } from "@/lib/automations";

export const dynamic = "force-dynamic";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Lanza una revisión de las automatizaciones. Para alojamientos sin procesos
 * permanentes (Vercel): un cron llama aquí con `Authorization: Bearer $CRON_SECRET`.
 */
async function handle(req: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (secret.length < 16) return NextResponse.json({ error: "Falta CRON_SECRET (mínimo 16 caracteres)." }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  const sent = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!sent || !timingSafeEqual(digest(sent), digest(secret))) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  return NextResponse.json(await runAutomations());
}

export const GET = handle;
export const POST = handle;
