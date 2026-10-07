import Link from "next/link";

type Opt = { value: string; label: string };

/** Filtros de las listas de contactos y empresas (como los de Pipedrive, sin guardar). */
export function ListFiltersBar({ base, sp, users, tags, placeholder }: {
  base: string; sp: Record<string, string | undefined>; users: Opt[]; tags: Opt[]; placeholder: string;
}) {
  const active = ["owner", "tag", "activity", "deals"].some((k) => sp[k]);
  return (
    <form className="toolbar list-filters" action={base}>
      <input name="q" defaultValue={sp.q ?? ""} placeholder={placeholder} aria-label="Buscar" />
      <select name="owner" defaultValue={sp.owner ?? ""} aria-label="Responsable">
        <option value="">Cualquier responsable</option>
        <option value="me">Míos</option>
        <option value="none">Sin responsable</option>
        {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
      {tags.length > 0 && (
        <select name="tag" defaultValue={sp.tag ?? ""} aria-label="Etiqueta">
          <option value="">Cualquier etiqueta</option>
          {tags.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
      )}
      <select name="activity" defaultValue={sp.activity ?? ""} aria-label="Actividades">
        <option value="">Con o sin actividad</option>
        <option value="none">Sin actividad programada</option>
        <option value="overdue">Con actividades vencidas</option>
      </select>
      <select name="deals" defaultValue={sp.deals ?? ""} aria-label="Deals">
        <option value="">Con o sin deals</option>
        <option value="open">Con deals abiertos</option>
        <option value="none">Sin deals abiertos</option>
      </select>
      <select name="sort" defaultValue={sp.sort ?? "name"} aria-label="Ordenar">
        <option value="name">Por nombre</option>
        <option value="recent">Más recientes</option>
        <option value="next">Próxima actividad</option>
        <option value="last">Último contacto</option>
      </select>
      <button className="btn secondary">Filtrar</button>
      {(active || sp.q) && <Link href={base} className="meta">Quitar filtros</Link>}
    </form>
  );
}
