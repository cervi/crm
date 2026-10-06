import { LEVEL_LABEL, levelOf } from "@/lib/health-level";

type Sig = { label: string; tone: "risk" | "good"; points?: number };

/** Salud del deal (0–100) con color; las señales, al pasar el ratón. */
export function HealthBadge({ score, signals = [], compact }: { score: number | null; signals?: Sig[]; compact?: boolean }) {
  if (score === null || score === undefined) return compact ? null : <span className="meta">—</span>;
  const level = levelOf(score);
  const title = signals.length
    ? signals.map((s) => `${s.tone === "risk" ? "▼" : "▲"} ${s.label}`).join("\n")
    : "Sin señales destacables";
  return (
    <span className={`health health-${level}`} title={title} aria-label={`Salud ${score} de 100: ${LEVEL_LABEL[level]}`}>
      <i aria-hidden="true" /><strong>{score}</strong>{!compact && <> {LEVEL_LABEL[level]}</>}
    </span>
  );
}
