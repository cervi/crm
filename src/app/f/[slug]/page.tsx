import { notFound } from "next/navigation";
import { PublicForm } from "./PublicForm";
import { chatAvailable, formBySlug } from "@/lib/webforms";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const f = await formBySlug((await params).slug);
  return { title: f?.title ?? "Formulario", robots: { index: false } };
}

/** Formulario web público (también se puede incrustar con ?embed=1). */
export default async function FormPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ embed?: string }> }) {
  const [{ slug }, { embed }] = await Promise.all([params, searchParams]);
  const f = await formBySlug(slug);
  if (!f) notFound();
  const withChat = await chatAvailable(f);
  return (
    <main className={embed ? "webform embed" : "webform"}>
      <header>
        <h1>{f.title}</h1>
        {f.description && <p className="muted">{f.description}</p>}
      </header>
      <PublicForm slug={slug} fields={f.fields} chat={withChat} startedAt={Date.now()} />
    </main>
  );
}
