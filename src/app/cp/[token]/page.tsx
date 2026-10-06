import { notFound } from "next/navigation";
import { planByToken, SIDE_LABEL } from "@/lib/close-plan";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const p = await planByToken((await params).token);
  return { title: p ? `Plan de trabajo: ${p.organization ?? p.title}` : "Plan de trabajo", robots: { index: false } };
}

const fmt = (d: string | null) => (d ? new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`)) : "sin fecha");

/** Plan de cierre compartido con el cliente (solo lectura, con su enlace). */
export default async function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const p = await planByToken((await params).token);
  if (!p) notFound();
  const done = p.steps.filter((s) => s.done).length;
  return (
    <main className="proposal shared-plan">
      <header>
        <p className="meta">{p.organization ?? p.title}</p>
        <h1>Plan de trabajo conjunto</h1>
        <p className="meta">{done} de {p.steps.length} pasos hechos{p.owner ? ` · Tu contacto: ${p.owner}` : ""}</p>
      </header>
      <ol className="plan-steps public">
        {p.steps.map((s) => (
          <li key={s.id} className={[s.done && "done", s.overdue && "overdue"].filter(Boolean).join(" ")}>
            <span className="plan-check" aria-hidden="true">{s.done ? "✓" : ""}</span>
            <span className="plan-title">{s.title}</span>
            <span className="meta">{SIDE_LABEL[s.side]}{s.owner_name ? ` · ${s.owner_name}` : ""}</span>
            <span className="meta">{s.done ? "Hecho" : fmt(s.due_date)}</span>
          </li>
        ))}
      </ol>
      <p className="meta">¿Algo no encaja con vuestras fechas? Responde al correo de tu contacto y lo ajustamos.</p>
    </main>
  );
}
