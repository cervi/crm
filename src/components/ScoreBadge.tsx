import { TEMPERATURE_LABEL, temperature, type ScoreReason } from "@/lib/scoring";

/** Puntuación del lead con su temperatura; los motivos, al pasar el ratón. */
export function ScoreBadge({ score, reasons = [] }: { score: number | null; reasons?: ScoreReason[] }) {
  const t = temperature(score);
  if (score === null || !t) return <span className="meta">—</span>;
  const title = reasons.length ? reasons.map((r) => `${r.points > 0 ? "+" : ""}${r.points} ${r.label}`).join("\n") : "Sin señales todavía";
  return (
    <span className={`score score-${t}`} title={title} aria-label={`Puntuación ${score} (${TEMPERATURE_LABEL[t]})`}>
      <strong>{score}</strong> {TEMPERATURE_LABEL[t]}
    </span>
  );
}

/** Lista de motivos, para la ficha del lead. */
export function ScoreReasons({ reasons }: { reasons: ScoreReason[] }) {
  if (reasons.length === 0) return <p className="meta">Sin señales todavía: la puntuación sube con la etapa, los formularios, los correos y las reuniones.</p>;
  return (
    <ul className="score-reasons">
      {reasons.map((r, i) => (
        <li key={i}><span className={r.points > 0 ? "tone-good" : "tone-bad"}>{r.points > 0 ? "+" : ""}{r.points}</span> {r.label}</li>
      ))}
    </ul>
  );
}
