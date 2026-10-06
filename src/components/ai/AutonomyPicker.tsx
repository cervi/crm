import { AUTONOMY_LEVELS, type Autonomy } from "@/lib/automations";

/**
 * Selector de autonomía (No / Preguntar / Sola). Cada opción es un pequeño
 * formulario que llama a `action` con su nivel.
 */
export function AutonomyPicker({ value, allowed, action, label, unavailableHint }: {
  value: Autonomy;
  allowed: Autonomy[];
  action: (level: Autonomy) => Promise<void>;
  label: string;
  unavailableHint?: string;
}) {
  return (
    <div className="autonomy" role="group" aria-label={label}>
      {AUTONOMY_LEVELS.map((l) => {
        const ok = allowed.includes(l.value);
        return (
          <form key={l.value} action={action.bind(null, l.value)}>
            <button type="submit" data-level={l.value} aria-pressed={value === l.value} disabled={!ok || value === l.value}
                    title={ok ? l.help : (unavailableHint ?? "No disponible todavía")}>
              {l.label}
            </button>
          </form>
        );
      })}
    </div>
  );
}
