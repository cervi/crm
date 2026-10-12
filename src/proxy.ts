import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionUser } from "@/lib/session";
import { isOn } from "@/lib/switches";

/**
 * Control de acceso: toda la aplicación pide sesión iniciada, salvo la
 * pantalla de entrada, la de puesta en marcha y las páginas públicas (enlace
 * de reservas, formularios y seguimiento). La API de entrada (/api/v1/*) no
 * pasa por aquí: usa sus propias claves.
 *
 * Además deja la ruta pedida en la cabecera x-pathname, para que las páginas
 * sepan a dónde volver tras iniciar sesión.
 */
const PUBLIC = [/^\/login(\/|$)/, /^\/setup(\/|$)/, /^\/book\//, /^\/f\//, /^\/t\//, /^\/p\//, /^\/cp\//, /^\/u\//, /^\/s\//, /^\/firma\//, /^\/acceso\//, /^\/d\//, /^\/api\/public\//, /^\/api\/integrations\/(google|microsoft)\/(login|callback)$/];

/** Las que apaga el interruptor «Páginas públicas» (no la entrada, la baja, el acceso ni el seguimiento). */
const CLOSABLE = [/^\/book\//, /^\/f\//, /^\/p\//, /^\/cp\//, /^\/s\//, /^\/firma\//, /^\/d\//, /^\/api\/public\/(chat|d|firma)\//];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const forward = new Headers(req.headers);
  forward.set("x-pathname", pathname + search);
  const pass = () => NextResponse.next({ request: { headers: forward } });

  if (PUBLIC.some((re) => re.test(pathname))) {
    if (CLOSABLE.some((re) => re.test(pathname)) && !(await isOn("public_pages").catch(() => true))) {
      const msg = "Esta página no está disponible ahora mismo.";
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: msg }, { status: 503 })
        : new NextResponse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No disponible</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#3b4757"><p>${msg}</p></body>`,
            { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return pass();
  }

  const user = await sessionUser(req.cookies.get(SESSION_COOKIE)?.value).catch(() => null);
  if (user) return pass();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Inicia sesión para continuar." }, { status: 401 });
  }
  const login = new URL("/login", req.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  const res = NextResponse.redirect(login);
  if (req.cookies.has(SESSION_COOKIE)) res.cookies.delete(SESSION_COOKIE); // sesión caducada o revocada
  return res;
}

export const config = {
  matcher: ["/((?!api/v1/|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
