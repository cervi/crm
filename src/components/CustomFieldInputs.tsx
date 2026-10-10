import { inputName, type FieldDefinition } from "@/lib/custom-fields";
import { ChoiceField } from "./ChoiceField";

type Props = {
  defs: FieldDefinition[];
  values?: Record<string, unknown>;
  users?: { id: string; name: string }[];
};

/** Inputs de los campos personalizados de una entidad. */
export function CustomFieldInputs({ defs, values = {}, users = [] }: Props) {
  const active = defs.filter((d) => !d.is_archived);
  if (active.length === 0) return null;
  const filled = (d: FieldDefinition) => {
    const v = values[d.key];
    return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && v !== false;
  };
  // A la vista: los obligatorios y los que ya tienen valor. El resto, plegado,
  // para que crear un deal no sea un muro de casillas.
  const main = active.filter((d) => d.is_required || filled(d));
  const rest = active.filter((d) => !main.includes(d));
  const grid = (list: FieldDefinition[]) => (
    <div className="grid-2 cf-grid">
      {list.map((def) => <CustomInput key={def.id} def={def} value={values[def.key]} users={users} />)}
    </div>
  );
  return (
    <div className="cf-block">
      {main.length > 0 && grid(main)}
      {rest.length > 0 && (
        <details className="cf-more" open={main.length === 0 && rest.length <= 6}>
          <summary>
            <span>{main.length ? "Más campos" : "Campos personalizados"}</span>
            <span className="meta">{rest.length} campo{rest.length === 1 ? "" : "s"} · opcionales</span>
          </summary>
          {grid(rest)}
        </details>
      )}
    </div>
  );
}

function CustomInput({ def, value, users }: { def: FieldDefinition; value: unknown; users: { id: string; name: string }[] }) {
  const name = inputName(def);
  const label = <span className="label">{def.label}{def.is_required && " *"}</span>;
  const str = value === undefined || value === null ? "" : String(value);

  switch (def.field_type) {
    case "long_text":
      return <label className="field span-2">{label}<textarea name={name} defaultValue={str} rows={3} /></label>;
    case "boolean":
      return (
        <label className="field checkbox">
          <input type="checkbox" name={name} defaultChecked={value === true} /> {def.label}
        </label>
      );
    case "single_option":
      return <ChoiceField name={name} label={def.label} options={def.options ?? []} initial={str ? [str] : []} multiple={false} required={def.is_required} />;
    case "multi_option":
      return <ChoiceField name={name} label={def.label} options={def.options ?? []} required={def.is_required}
                          initial={Array.isArray(value) ? value.map(String) : []} multiple />;
    case "user":
      return (
        <label className="field">{label}
          <select name={name} defaultValue={str} required={def.is_required}>
            <option value="">—</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      );
    default: {
      const type = {
        number: "number", money: "number", date: "date", datetime: "datetime-local",
        url: "text", email: "email", phone: "tel", text: "text",
      }[def.field_type as string] ?? "text";
      return (
        <label className="field">{label}
          <input type={type} name={name} defaultValue={str} required={def.is_required}
                 step={def.field_type === "money" ? "0.01" : def.field_type === "number" ? "any" : undefined} />
        </label>
      );
    }
  }
}
