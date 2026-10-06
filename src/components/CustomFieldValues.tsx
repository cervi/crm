import { formatCustomValue, type FieldDefinition } from "@/lib/custom-fields";

/** Muestra los valores de los campos personalizados como lista de datos. */
export function CustomFieldValues({ defs, values, users = [] }: {
  defs: FieldDefinition[]; values: Record<string, unknown>; users?: { id: string; name: string }[];
}) {
  const shown = defs.filter((d) => !d.is_archived || values[d.key] !== undefined);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((def) => (
        <div key={def.id} className="dl-row">
          <dt>{def.label}</dt>
          <dd>{formatCustomValue(def, values[def.key], users)}</dd>
        </div>
      ))}
    </>
  );
}
