import { NextResponse, type NextRequest } from "next/server";
import { exchangeCode, graphClient, microsoftMessage } from "@/lib/microsoft";
import { saveConnection } from "@/lib/mailbox";
import type { Scheduling } from "@/lib/slots";
import { back, COOKIE, COOKIE_PATH, openState, publicOrigin } from "../shared";

export const dynamic = "force-dynamic";

const DAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

/** Vuelta del inicio de sesión de Microsoft: guarda la conexión del buzón. */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const url = new URL(req.url);
  const saved = openState(req.cookies.get(COOKIE)?.value);
  const done = (params: Record<string, string>) => {
    const res = NextResponse.redirect(back(origin, params));
    res.cookies.set(COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
    return res;
  };

  if (url.searchParams.get("error")) {
    const msg = url.searchParams.get("error_description")?.split("\n")[0] ?? url.searchParams.get("error")!;
    return done({ error: `Microsoft no ha dado acceso: ${msg}` });
  }
  const code = url.searchParams.get("code");
  if (!saved || !code || url.searchParams.get("state") !== saved.state) {
    return done({ error: "La conexión ha caducado o no es válida. Vuelve a intentarlo." });
  }

  try {
    const tokens = await exchangeCode(code, saved.verifier, saved.redirect);
    const client = graphClient(tokens, async () => {});
    const me = await client.call<{ mail: string | null; userPrincipalName: string; displayName: string | null }>(
      "/me?$select=mail,userPrincipalName,displayName");
    // Horario laboral de Outlook como punto de partida para ofrecer huecos.
    let scheduling: Partial<Scheduling> = {};
    try {
      const ms = await client.call<{ workingHours?: { daysOfWeek?: string[]; startTime?: string; endTime?: string } }>(
        "/me/mailboxSettings?$select=workingHours");
      const wh = ms.workingHours;
      if (wh) {
        scheduling = {
          days: (wh.daysOfWeek ?? []).map((d) => DAYS[d.toLowerCase()]).filter(Boolean),
          start: wh.startTime?.slice(0, 5), end: wh.endTime?.slice(0, 5),
        };
      }
    } catch { /* sin permiso para la configuración del buzón: se usan los valores por defecto */ }
    await saveConnection({ userId: saved.userId, email: me.mail ?? me.userPrincipalName, displayName: me.displayName, tokens, scheduling });
    return done({ connected: me.mail ?? me.userPrincipalName });
  } catch (err) {
    return done({ error: microsoftMessage(err) });
  }
}
