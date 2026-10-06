import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Búsqueda rápida para los selectores de empresa y contacto. */
export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
  const like = `%${q}%`;

  if (type === "organizations") {
    const rows = await sql<{ id: string; label: string; hint: string | null }[]>`
      SELECT id, name AS label, domain AS hint FROM organizations
      WHERE deleted_at IS NULL AND (${q === ""} OR lower(name) LIKE ${like} OR lower(coalesce(domain, '')) LIKE ${like})
      ORDER BY (lower(name) LIKE ${`${q}%`}) DESC, lower(name) LIMIT 20`;
    return NextResponse.json(rows);
  }
  if (type === "persons") {
    const rows = await sql<{ id: string; label: string; hint: string | null }[]>`
      SELECT p.id, p.full_name AS label,
             concat_ws(' · ', o.name, (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC LIMIT 1)) AS hint
      FROM persons p
      LEFT JOIN LATERAL (SELECT organization_id FROM person_organizations
                         WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) cur ON true
      LEFT JOIN organizations o ON o.id = cur.organization_id
      WHERE p.deleted_at IS NULL AND (${q === ""} OR lower(p.full_name) LIKE ${like}
            OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like}))
      ORDER BY (lower(p.full_name) LIKE ${`${q}%`}) DESC, lower(p.full_name) LIMIT 20`;
    return NextResponse.json(rows);
  }
  return NextResponse.json({ error: "type debe ser organizations o persons" }, { status: 400 });
}
