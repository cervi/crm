"use client";

import { useState } from "react";
import { Icon } from "./Icon";

export type Theme = "light" | "dark" | "system";

const OPTIONS: { value: Theme; label: string; icon: "sun" | "moon" | "system" }[] = [
  { value: "light", label: "Modo claro", icon: "sun" },
  { value: "dark", label: "Modo oscuro", icon: "moon" },
  { value: "system", label: "Como el sistema", icon: "system" },
];

/**
 * Claro / oscuro / sistema. La elección se guarda en una cookie para que el
 * servidor pinte ya el tema correcto (sin destello al cargar).
 */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);

  const choose = (value: Theme) => {
    setTheme(value);
    const root = document.documentElement;
    if (value === "system") delete root.dataset.theme;
    else root.dataset.theme = value;
    document.cookie = `theme=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  };

  return (
    <div className="theme-switch" role="group" aria-label="Tema">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" aria-pressed={theme === o.value} title={o.label} aria-label={o.label}
                onClick={() => choose(o.value)}>
          <Icon name={o.icon} />
        </button>
      ))}
    </div>
  );
}
