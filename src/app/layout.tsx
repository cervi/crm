import type { Metadata } from "next";
import { Nav } from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "CRM", template: "%s · CRM" },
  description: "CRM interno",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="shell">
          <Nav />
          <div className="content">{children}</div>
        </div>
      </body>
    </html>
  );
}
