/** Iniciales con un tono estable derivado del nombre (mismo nombre, mismo color). */
export function Avatar({ name, kind = "person", size }: { name: string | null | undefined; kind?: "person" | "org"; size?: "sm" | "lg" }) {
  const clean = (name ?? "").trim();
  const words = clean.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const ch of clean.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return (
    <span className={["avatar", kind === "org" && "org", size].filter(Boolean).join(" ")}
          style={{ "--h": hash } as React.CSSProperties} aria-hidden="true">
      {initials}
    </span>
  );
}
