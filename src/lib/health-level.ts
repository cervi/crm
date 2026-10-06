// Niveles de salud de un deal (sin dependencias: lo usan servidor y cliente).

export type HealthLevel = "good" | "warn" | "bad";
export const RED = 40;
export const levelOf = (score: number): HealthLevel => (score >= 65 ? "good" : score >= RED ? "warn" : "bad");
export const LEVEL_LABEL: Record<HealthLevel, string> = { good: "Buena", warn: "Regular", bad: "En riesgo" };
