import { sql } from "./db";

export type SearchHit = {
  type: "deal" | "person" | "organization" | "lead";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
};

const HREF = { deal: "/deals/", person: "/persons/", organization: "/organizations/", lead: "/leads/" } as const;

/**
 * Búsqueda global en deals, contactos, empresas y leads. Coincidencia por
 * fragmento sin distinguir mayúsculas; primero los que empiezan por el texto.
 */
export async function globalSearch(query: string, perType = 5): Promise<SearchHit[]> {
  const q = query.trim().toLowerCase().slice(0, 100);
  if (q.length < 2) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const prefix = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await sql<(Omit<SearchHit, "href"> & { rank: number })[]>`
    (SELECT 'deal' AS type, d.id, d.title, concat_ws(' · ', o.name, s.name,
              CASE d.status WHEN 'won' THEN 'Ganado' WHEN 'lost' THEN 'Perdido' END) AS subtitle,
            (lower(d.title) LIKE ${prefix})::int AS rank
     FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN organizations o ON o.id = d.organization_id
     WHERE d.deleted_at IS NULL AND (lower(d.title) LIKE ${like} OR lower(coalesce(o.name, '')) LIKE ${like})
     ORDER BY 5 DESC, (d.status = 'open') DESC, d.updated_at DESC LIMIT ${perType})
    UNION ALL
    (SELECT 'person', p.id, p.full_name,
            concat_ws(' · ', (SELECT o.name FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
                              WHERE po.person_id = p.id AND po.status = 'current' LIMIT 1),
                      (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC LIMIT 1)),
            (lower(p.full_name) LIKE ${prefix})::int
     FROM persons p
     WHERE p.deleted_at IS NULL AND (lower(p.full_name) LIKE ${like}
           OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like})
           OR EXISTS (SELECT 1 FROM person_phones ph WHERE ph.person_id = p.id AND ph.phone LIKE ${like}))
     ORDER BY 5 DESC, lower(p.full_name) LIMIT ${perType})
    UNION ALL
    (SELECT 'organization', o.id, o.name, o.domain, (lower(o.name) LIKE ${prefix})::int
     FROM organizations o
     WHERE o.deleted_at IS NULL AND (lower(o.name) LIKE ${like} OR lower(coalesce(o.domain, '')) LIKE ${like})
     ORDER BY 5 DESC, lower(o.name) LIMIT ${perType})
    UNION ALL
    (SELECT 'lead', l.id, coalesce(p.full_name, l.title),
            concat_ws(' · ', 'Lead', l.source_detail, l.source), (lower(coalesce(p.full_name, l.title)) LIKE ${prefix})::int
     FROM leads l LEFT JOIN persons p ON p.id = l.person_id
     WHERE l.deleted_at IS NULL AND l.status = 'open'
       AND (lower(l.title) LIKE ${like} OR lower(coalesce(l.source_detail, '')) LIKE ${like})
     ORDER BY 5 DESC, l.created_at DESC LIMIT ${perType})`;
  return rows.map(({ rank: _rank, ...r }) => ({ ...r, href: `${HREF[r.type]}${r.id}` }));
}
