import { notFound } from "next/navigation";
import { surveyByToken } from "@/lib/accounts";
import { SurveyForm } from "./SurveyForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tu opinión", robots: { index: false } };

/** Encuesta de una pregunta (0 a 10) y un comentario, sin iniciar sesión. */
export default async function SurveyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await surveyByToken(token);
  if (!s) notFound();
  return (
    <main className="proposal survey" style={{ maxWidth: 620 }}>
      <header>
        {s.organization && <p className="meta">{s.organization}</p>}
        <h1>{s.kind === "onboarding" ? "¿Qué tal ha ido la puesta en marcha?" : "¿Qué tal vamos?"}</h1>
      </header>
      {s.answered_at ? <p role="status">Ya tenemos tu respuesta ({s.score}/10). ¡Gracias!</p> : <SurveyForm token={token} />}
    </main>
  );
}
