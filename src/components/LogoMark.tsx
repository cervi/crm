import { useId } from "react";

/** El símbolo del CRM: círculo con degradado y una S. Es el mismo dibujo que el favicon (src/app/icon.svg). */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const id = `lg${useId().replace(/:/g, "")}`;
  return (
    <svg className={["logo-mark", className].filter(Boolean).join(" ")} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" /><stop offset=".55" stopColor="#6d4ce6" /><stop offset="1" stopColor="#d9468f" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill={`url(#${id})`} />
      <path d="M21.2 10.6c-1.1-1.5-3-2.4-5.1-2.4-2.9 0-5 1.6-5 3.9 0 5.4 10.6 3 10.6 8.5 0 2.5-2.3 4.2-5.4 4.2-2.3 0-4.3-1-5.5-2.7"
            fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
