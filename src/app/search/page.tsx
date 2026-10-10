import Link from "next/link";
import { globalSearch, type SearchHit } from "@/lib/search";
import { Avatar } from "@/components/Avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Búsqueda" };

const GROUPS: { type: SearchHit["type"]; label: string }[] = [
  { type: "deal", label: "Deals" },
  { type: "person", label: "Contactos" },
  { type: "organization", label: "Empresas" },
  { type: "lead", label: "Leads" },
];

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const hits = await globalSearch(q, 50);
  return (
    <main className="page medium">
      <div className="page-head"><h1>Resultados de «{q}»</h1></div>
      {q.trim().length < 2 && <p className="muted">Escribe al menos dos letras en el buscador.</p>}
      {q.trim().length >= 2 && hits.length === 0 && <p className="muted">No hay deals, contactos, empresas ni leads que coincidan.</p>}
      <div className="stack">
        {GROUPS.map((g) => {
          const items = hits.filter((h) => h.type === g.type);
          if (!items.length) return null;
          return (
            <section key={g.type} className="panel">
              <h2>{g.label} <span className="muted">{items.length}</span></h2>
              <ul className="items">
                {items.map((h) => (
                  <li key={h.id} className="item cell-main">
                    <Avatar name={h.title} kind={h.type === "organization" ? "org" : "person"} size="sm" />
                    <div><Link href={h.href}><strong>{h.title}</strong></Link>{h.subtitle && <div className="meta">{h.subtitle}</div>}</div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
