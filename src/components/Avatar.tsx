/** Iniciales en un círculo neutro (el color no distingue personas: se distinguen por el nombre). */
export function Avatar({ name, kind = "person", size }: { name: string | null | undefined; kind?: "person" | "org"; size?: "sm" | "lg" }) {
  const clean = (name ?? "").trim();
  const words = clean.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2)).toUpperCase();
  return (
    <span className={["avatar", kind === "org" && "org", size].filter(Boolean).join(" ")}
          aria-hidden="true">
      {initials}
    </span>
  );
}
