import { redirect } from "next/navigation";
import { listPipelines } from "@/lib/pipelines";

export const dynamic = "force-dynamic";

export default async function PipelinesIndex() {
  const [first] = await listPipelines();
  if (first) redirect(`/pipelines/${first.id}`);
  return <main className="empty">Todavía no hay pipelines. Créalos en Ajustes.</main>;
}
