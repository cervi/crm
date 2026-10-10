import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";

type Opt = { value: string; label: string };

/** Filtros de las listas de contactos y empresas (como los de Pipedrive, sin guardar). */
export function ListFiltersBar({ base, sp, users, tags, placeholder }: {
  base: string; sp: Record<string, string | undefined>; users: Opt[]; tags: Opt[]; placeholder: string;
}) {
  const active = ["owner", "tag", "activity", "deals"].some((k) => sp[k]);
  return (
    <form className="toolbar list-filters" action={base}>
      <input name="q" defaultValue={sp.q ?? ""} placeholder={placeholder} aria-label="Buscar" />
      <AutoSubmitSelect name="owner" defaultValue={sp.owner ?? ""} aria-label="Responsable">
        <option value="">Cualquier responsable</option>
        <option value="me">Míos</option>
        <option value="none">Sin responsable</option>
        {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </AutoSubmitSelect>
      {tags.length > 0 && (
        <AutoSubmitSelect name="tag" defaultValue={sp.tag ?? ""} aria-label="Etiqueta">
          <option value="">Cualquier etiqueta</option>
          {tags.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </AutoSubmitSelect>
      )}
      <AutoSubmitSelect name="activity" defaultValue={sp.activity ?? ""} aria-label="Actividades">
        <option value="">Con o sin actividad</option>
        <option value="none">Sin actividad programada</option>
        <option value="overdue">Con actividades vencidas</option>
      </AutoSubmitSelect>
      <AutoSubmitSelect name="deals" defaultValue={sp.deals ?? ""} aria-label="Deals">
        <option value="">Con o sin deals</option>
        <option value="open">Con deals abiertos</option>
        <option value="none">Sin deals abiertos</option>
      </AutoSubmitSelect>
      <AutoSubmitSelect name="sort" defaultValue={sp.sort ?? "name"} aria-label="Ordenar">
        <option value="name">Por nombre</option>
        <option value="recent">Más recientes</option>
        <option value="next">Próxima actividad</option>
        <option value="last">Último contacto</option>
      </AutoSubmitSelect>
      <button className="sr-only" tabIndex={-1}>Buscar</button>
      {(active || sp.q) && <Link href={base} className="meta">Quitar filtros</Link>}
    </form>
  );
}
