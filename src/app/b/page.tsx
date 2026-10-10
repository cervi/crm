import { redirect } from "next/navigation";

// La versión B ya es la portada: los enlaces antiguos llevan a «Hoy».
export default async function OldB({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const { owner } = await searchParams;
  redirect(owner ? `/?owner=${encodeURIComponent(owner)}` : "/");
}
