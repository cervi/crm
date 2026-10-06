import { inputName, type FieldDefinition } from "@/lib/custom-fields";

type Props = {
  defs: FieldDefinition[];
  values?: Record<string, unknown>;
  users?: { id: string; name: string }[];
};

/** Inputs de los campos personalizados de una entidad. */
export function CustomFieldInputs({ defs, values = {}, users = [] }: Props) {
  const active = defs.filter((d) => !d.is_archived);
  if (active.length === 0) return null;
  return (
    <fieldset className="fieldset">
      <legend>Campos personalizados</legend>
      <div className="grid-2">
        {active.map((def) => <CustomInput key={def.id} def={def} value={values[def.key]} users={users} />)}
      </div>
    </fieldset>
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
      return (
        <label className="field">{label}
          <select name={name} defaultValue={str} required={def.is_required}>
            <option value="">—</option>
            {(def.options ?? []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
      );
    case "multi_option": {
      const picked = new Set(Array.isArray(value) ? value.map(String) : []);
      return (
        <fieldset className="field">
          {label}
          <div className="checks">
            {(def.options ?? []).map((o) => (
              <label key={o.key} className="checkbox">
                <input type="checkbox" name={name} value={o.key} defaultChecked={picked.has(o.key)} /> {o.label}
              </label>
            ))}
          </div>
        </fieldset>
      );
    }
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
