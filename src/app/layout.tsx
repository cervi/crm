import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Nav } from "@/components/Nav";
import type { Theme } from "@/components/ThemeSwitch";
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
  return (
    <html lang="es" data-theme={theme === "system" ? undefined : theme}>
      <body>
        <div className="shell">
          <Nav theme={theme} />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
