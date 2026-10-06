import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionUser } from "@/lib/session";

/**
 * Control de acceso: toda la aplicación pide sesión iniciada, salvo la
 * pantalla de entrada, la de puesta en marcha y las páginas públicas (enlace
 * de reservas, formularios y seguimiento). La API de entrada (/api/v1/*) no
 * pasa por aquí: usa sus propias claves.
 *
 * Además deja la ruta pedida en la cabecera x-pathname, para que las páginas
 * sepan a dónde volver tras iniciar sesión.
 */
const PUBLIC = [/^\/login(\/|$)/, /^\/setup(\/|$)/, /^\/book\//, /^\/f\//, /^\/t\//, /^\/p\//, /^\/api\/public\//];

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const forward = new Headers(req.headers);
  forward.set("x-pathname", pathname + search);
  const pass = () => NextResponse.next({ request: { headers: forward } });

  if (PUBLIC.some((re) => re.test(pathname))) return pass();

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
