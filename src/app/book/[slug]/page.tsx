import { notFound } from "next/navigation";
import { BookingForm } from "./BookingForm";
import { bookingSlots, linkContext, pageBySlug } from "@/lib/booking";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const page = await pageBySlug((await params).slug);
  return { title: page ? `${page.title} con ${page.user_name}` : "Reservar", robots: { index: false } };
}

/** Página pública de reservas: los huecos libres de una persona del equipo. */
export default async function BookingPage({ params, searchParams }: {
  params: Promise<{ slug: string }>; searchParams: Promise<{ r?: string }>;
}) {
  const [{ slug }, { r }] = await Promise.all([params, searchParams]);
  const page = await pageBySlug(slug);
  if (!page) notFound();
  const [available, ctx] = await Promise.all([bookingSlots(page).catch(() => null), linkContext(page, r)]);
  return (
    <main className="booking">
      <header className="booking-head">
        <p className="meta">{page.user_name}</p>
        <h1>{page.title}</h1>
        <p className="muted">{page.duration_minutes} minutos{available ? ` · hora de ${available.timezone.split("/").pop()!.replace(/_/g, " ")}` : ""}</p>
        {page.description && <p>{page.description}</p>}
      </header>
      {!available ? (
        <p className="callout">Ahora mismo no se pueden hacer reservas. Inténtalo más tarde.</p>
      ) : available.slots.length === 0 ? (
        <p className="callout">No quedan huecos libres en las próximas dos semanas. Escríbenos y buscamos otro momento.</p>
      ) : (
        <BookingForm
          slug={slug} token={r ?? null} timezone={available.timezone}
          slots={available.slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }))}
          person={ctx ? { name: ctx.name ?? "", email: ctx.email ?? "" } : null}
        />
      )}
    </main>
  );
}
