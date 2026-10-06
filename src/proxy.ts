import { NextResponse, type NextRequest } from "next/server";

/**
 * Protección de acceso provisional (hasta tener inicio de sesión por usuario):
 * usuario y contraseña comunes con HTTP Basic, definidos en BASIC_AUTH_USER y
 * BASIC_AUTH_PASSWORD. En producción, si no están definidos, no se sirve la
 * aplicación, para que nunca quede abierta por descuido.
 *
 * La API de entrada (/api/v1/*) no pasa por aquí: usa sus propias claves.
 */
export function proxy(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER ?? "";
  const pass = process.env.BASIC_AUTH_PASSWORD ?? "";

  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") {
      return new NextResponse("Acceso no configurado: define BASIC_AUTH_USER y BASIC_AUTH_PASSWORD.", { status: 503 });
    }
    return NextResponse.next(); // desarrollo local sin contraseña
  }

  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      // atob devuelve bytes; se interpretan como UTF-8 para admitir tildes y eñes.
      decoded = new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)));
    } catch { /* cabecera mal formada */ }
    const i = decoded.indexOf(":");
    if (i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass)) {
      return NextResponse.next();
    }
  }
  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="CRM", charset="UTF-8"' },
  });
}

/** Comparación en tiempo constante. */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = {
  matcher: ["/((?!api/v1/|_next/static|_next/image|favicon.ico).*)"],
};
