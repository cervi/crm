import { recordClick } from "@/lib/emails";

export const dynamic = "force-dynamic";

/** Clic en un enlace de un correo: se cuenta y se redirige al enlace original. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const url = new URL(req.url).searchParams.get("u") ?? "";
  const target = /^[A-Za-z0-9_-]{20,40}$/.test(token) && /^https?:\/\//.test(url) ? await recordClick(token, url).catch(() => null) : null;
  if (!target) return new Response("Enlace no válido o caducado.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.redirect(target, 302);
}
