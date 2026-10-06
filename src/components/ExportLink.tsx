import { Icon } from "./Icon";

/**
 * Botón «Exportar CSV»: descarga lo que se está viendo, con los mismos filtros.
 * Es un enlace normal: funciona sin JavaScript.
 */
export function ExportLink({ dataset, params = {}, label = "Exportar CSV", small = false }: {
  dataset: string;
  params?: Record<string, string | null | undefined>;
  label?: string;
  small?: boolean;
}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const href = `/api/export/${dataset}${q.size ? `?${q}` : ""}`;
  return (
    <a href={href} className={small ? "btn secondary small" : "btn secondary"} download>
      <Icon name="download" />{label}
    </a>
  );
}
