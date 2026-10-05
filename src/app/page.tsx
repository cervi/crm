import { redirect } from "next/navigation";
import { listPipelines } from "@/lib/pipelines";

export const dynamic = "force-dynamic";

// La portada abre el primer pipeline activo.
export default async function Home() {
  const [first] = await listPipelines();
  if (first) redirect(`/pipelines/${first.id}`);
  return <main className="empty">Todavía no hay pipelines creados.</main>;
}
