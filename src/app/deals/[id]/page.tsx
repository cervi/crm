import { notFound } from "next/navigation";
import { getDeal } from "@/lib/deals";
import { isId } from "@/lib/validation";
import { DealDetail } from "@/components/deal/DealDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = isId(id) ? await getDeal(id) : null;
  return { title: d?.title ?? "Deal" };
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id) || !(await getDeal(id))) notFound();
  return (
    <main className="page">
      <DealDetail dealId={id} back={`/deals/${id}`} />
    </main>
  );
}
