import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { Nav } from "@/components/Nav";
import { Topbar, type Theme } from "@/components/Topbar";
import { countPending } from "@/lib/automations";
import { activityTypes } from "@/lib/activity-types";
import { currentUser } from "@/lib/auth";
import { unreadCount } from "@/lib/notifications";
import { getNavPrefs } from "@/lib/nav-prefs";
import { runningJob, STEP_LABELS } from "@/lib/pipedrive-import";
import { ImportBanner } from "@/components/ImportBanner";
import "@fontsource-variable/instrument-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CRM", template: "%s · CRM" },
  description: "CRM interno",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0f131a" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // El tema elegido viaja en una cookie: el servidor lo aplica antes de pintar.
  const saved = (await cookies()).get("theme")?.value;
  const theme: Theme = saved === "light" || saved === "dark" ? saved : "system";
  const dataTheme = theme === "system" ? undefined : theme;
  // Entrada y puesta en marcha: sin menú ni barra superior.
  const path = (await headers()).get("x-pathname") ?? "";
  const user = await currentUser().catch(() => null);
  if (!user || /^\/(login|setup|book|f|t|p)(\/|$|\?)/.test(path)) {
    return (
      <html lang="es" data-theme={dataTheme} suppressHydrationWarning>
        <body><div className="bare">{children}</div></body>
      </html>
    );
  }
  // Con contraseña temporal, lo primero es cambiarla.
  if (user.must_change_password && !path.startsWith("/account")) redirect("/account?change=1");
  // Propuestas de la IA esperando decisión (el aviso del menú lateral).
  const [inboxCount, unread, navPrefs, importing] = await Promise.all([countPending().catch(() => 0), unreadCount(user.id).catch(() => 0),
    getNavPrefs(user.id).catch(() => ({})),
    runningJob().then((j) => (j && !j.options?.since ? j : null)).catch(() => null)]);
  // Etiquetas de los tipos de actividad (configurables) disponibles en todo el servidor.
  await activityTypes().catch(() => null);
  return (
    <html lang="es" data-theme={dataTheme} suppressHydrationWarning>
      <body>
        <div className="shell">
          <Nav inboxCount={inboxCount} prefs={navPrefs} />
          <div className="main">
            <Topbar theme={theme} user={{ name: user.name, email: user.email, role: user.role }} unread={unread} />
            {importing && (
              <ImportBanner canDrive={user.role === "admin"} labels={STEP_LABELS}
                            initial={{ status: importing.status, step: importing.step,
                                       total: Object.values(importing.counts ?? {}).reduce((n, c) => n + (c.created ?? 0) + (c.updated ?? 0) + (c.skipped ?? 0), 0) }} />
            )}
            <div className="content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
