const LABEL = { fit: "Encaja", no_fit: "No encaja", unknown: "Falta saber" } as const;

/** Encaje del lead con el perfil de cliente ideal; el motivo, al pasar el ratón. */
export function FitBadge({ fit, reason }: { fit: keyof typeof LABEL | null; reason?: string | null }) {
  if (!fit) return <span className="meta">—</span>;
  const tone = fit === "fit" ? "won" : fit === "no_fit" ? "lost" : "";
  return <span className={`badge ${tone}`} title={reason ?? undefined}>{LABEL[fit]}</span>;
}
