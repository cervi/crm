import { ActionForm } from "./ActionForm";
import { CustomFieldInputs } from "./CustomFieldInputs";
import { EntityPicker } from "./EntityPicker";
import type { ActionState } from "@/lib/errors";
import type { FieldDefinition } from "@/lib/custom-fields";
import type { Organization } from "@/lib/organizations";
import type { Person } from "@/lib/persons";
import type { UserRow } from "@/lib/users";

type Action = (state: ActionState, form: FormData) => Promise<ActionState>;

export function OwnerSelect({ users, value, label = "Responsable" }: { users: UserRow[]; value?: string | null; label?: string }) {
  return (
    <label className="field"><span className="label">{label}</span>
      <select name="owner_id" defaultValue={value ?? ""}>
        <option value="">—</option>
        {users.filter((u) => u.kind === "human").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    </label>
  );
}

export function OrganizationForm({ action, org, defs, users, submitLabel }: {
  action: Action; org?: Organization | null; defs: FieldDefinition[]; users: UserRow[]; submitLabel: string;
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <div className="grid-2">
        <label className="field span-2"><span className="label">Nombre *</span><input name="name" required defaultValue={org?.name} /></label>
        <label className="field"><span className="label">Dominio</span>
          <input name="domain" placeholder="empresa.com" defaultValue={org?.domain ?? ""} /></label>
        <label className="field"><span className="label">Web</span><input name="website" defaultValue={org?.website ?? ""} /></label>
        <label className="field"><span className="label">Sector</span><input name="industry" defaultValue={org?.industry ?? ""} /></label>
        <label className="field"><span className="label">Empleados</span>
          <input type="number" min={0} name="employee_count" defaultValue={org?.employee_count ?? ""} /></label>
        <label className="field"><span className="label">País</span><input name="country" defaultValue={org?.country ?? ""} /></label>
        <label className="field"><span className="label">Ciudad</span><input name="city" defaultValue={org?.city ?? ""} /></label>
        <label className="field span-2"><span className="label">Dirección</span><input name="address" defaultValue={org?.address ?? ""} /></label>
        <OwnerSelect users={users} value={org?.owner_id} />
      </div>
      <fieldset className="fieldset">
        <legend>Customer Success</legend>
        <div className="grid-2">
          <label className="field"><span className="label">Responsable de CS</span>
            <input name="cs_manager_name" defaultValue={org?.cs_manager_name ?? ""} placeholder="Quién llevará la cuenta" /></label>
          <label className="field"><span className="label">Email del responsable de CS</span>
            <input name="cs_manager_email" type="email" defaultValue={org?.cs_manager_email ?? ""} placeholder="Si se deja vacío, se usa la dirección de CS por defecto" /></label>
        </div>
      </fieldset>
      <CustomFieldInputs defs={defs} values={org?.custom} users={users} />
    </ActionForm>
  );
}

export function PersonForm({ action, person, email, phone, defs, users, submitLabel, withCompany, company }: {
  action: Action; person?: Person | null; email?: string | null; phone?: string | null;
  defs: FieldDefinition[]; users: UserRow[]; submitLabel: string;
  withCompany?: boolean; company?: { id: string; label: string } | null;
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <div className="grid-2">
        <label className="field"><span className="label">Nombre</span><input name="first_name" defaultValue={person?.first_name ?? ""} /></label>
        <label className="field"><span className="label">Apellidos</span><input name="last_name" defaultValue={person?.last_name ?? ""} /></label>
        <label className="field"><span className="label">Email principal</span><input type="email" name="email" defaultValue={email ?? ""} /></label>
        <label className="field"><span className="label">Teléfono principal</span><input type="tel" name="phone" defaultValue={phone ?? ""} /></label>
        <label className="field"><span className="label">LinkedIn</span><input name="linkedin_url" defaultValue={person?.linkedin_url ?? ""} /></label>
        <OwnerSelect users={users} value={person?.owner_id} />
        {withCompany && (
          <>
            <EntityPicker name="organization_id" type="organizations" label="Empresa" initial={company} />
            <label className="field"><span className="label">Cargo</span><input name="job_title" /></label>
          </>
        )}
        <label className="field checkbox span-2">
          <input type="checkbox" name="marketing_consent" defaultChecked={person?.marketing_consent} />
          Acepta comunicaciones comerciales (RGPD)
        </label>
      </div>
      <CustomFieldInputs defs={defs} values={person?.custom} users={users} />
    </ActionForm>
  );
}
