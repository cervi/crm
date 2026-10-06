import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Nav } from "@/components/Nav";
import { Topbar, type Theme } from "@/components/Topbar";
import { countPending } from "@/lib/automations";
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
  // Propuestas de la IA esperando decisión (el aviso del menú lateral).
  const inboxCount = await countPending().catch(() => 0);
  return (
    <html lang="es" data-theme={theme === "system" ? undefined : theme}>
      <body>
        <div className="shell">
          <Nav inboxCount={inboxCount} />
          <div className="main">
            <Topbar theme={theme} />
            <div className="content">{children}</div>
          </div>
        </div>
      </body>
    </html>
  );
}
