import { formatCustomValue, type FieldDefinition } from "@/lib/custom-fields";

/** Muestra los valores de los campos personalizados como lista de datos. */
export function CustomFieldValues({ defs, values, users = [] }: {
  defs: FieldDefinition[]; values: Record<string, unknown>; users?: { id: string; name: string }[];
}) {
  const has = (d: FieldDefinition) => {
    const v = values[d.key];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
  };
  // Solo los que tienen valor: una lista de «—» no aporta nada.
  const shown = defs.filter((d) => has(d));
  const empty = defs.filter((d) => !d.is_archived && !has(d)).length;
  if (shown.length === 0 && empty === 0) return null;
  return (
    <>
      {shown.map((def) => (
        <div key={def.id} className="dl-row">
          <dt>{def.label}</dt>
          <dd>{formatCustomValue(def, values[def.key], users)}</dd>
        </div>
      ))}
      {empty > 0 && <div className="dl-row dl-more"><dd className="meta">{empty} campo{empty === 1 ? "" : "s"} sin rellenar</dd></div>}
    </>
  );
}
