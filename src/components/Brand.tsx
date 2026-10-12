import { LogoMark } from "@/components/LogoMark";
import { getCompany } from "@/lib/company";

/** Marca de la pantalla de entrada: el logo y el nombre de la empresa (Ajustes de empresa), o «CRM». */
export async function Brand({ light = false }: { light?: boolean }) {
  const c = await getCompany();
  return (
    <div className={`auth-brand${light ? " light" : ""}`}>
      {c.logo ? <img src={c.logo} alt="" className="brand-logo" /> : <LogoMark size={28} />}
      {c.name ?? "CRM"}
    </div>
  );
}
