import { z } from "zod";
import { sql, json, transaction, type Db } from "./db";
import { recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { id, optDate, optId, optMoney, optText, optional, parse, text } from "./validation";

export type Deal = {
  id: string;
  title: string;
  organization_id: string | null;
  organization_name: string | null;
  pipeline_id: string;
  pipeline_name: string;
  stage_id: string;
  stage_name: string;
  status: "open" | "won" | "lost";
  value: string | null;
  currency: string;
  expected_close_date: string | null;
  owner_id: string | null;
  owner_name: string | null;
  lead_id: string | null;
  source: string | null;
  stage_entered_at: Date;
  days_in_stage: number;
  rotten_after_days: number | null;
  won_at: Date | null;
  lost_at: Date | null;
  lost_reason_id: string | null;
  lost_reason: string | null;
  lost_note: string | null;
  custom: Record<string, unknown>;
  created_at: Date;
};

export async function getDeal(dealId: string, db: Db = sql): Promise<Deal | null> {
  const [d] = await db<Deal[]>`
    SELECT d.id, d.title, d.organization_id, o.name AS organization_name, d.pipeline_id, p.name AS pipeline_name,
           d.stage_id, s.name AS stage_name, d.status, d.value::text, d.currency,
           d.expected_close_date::text, d.owner_id, u.name AS owner_name, d.lead_id, d.source,
           d.stage_entered_at,
           floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
           s.rotten_after_days, d.won_at, d.lost_at, d.lost_reason_id, lr.label AS lost_reason,
           d.lost_note, d.custom, d.created_at
    FROM deals d
    JOIN pipelines p ON p.id = d.pipeline_id
    JOIN stages s ON s.id = d.stage_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN lost_reasons lr ON lr.id = d.lost_reason_id
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  return d ?? null;
}

export type DealListRow = {
  id: string;
  title: string;
  status: "open" | "won" | "lost";
  value: string | null;
  currency: string;
  pipeline_name: string;
  stage_name: string;
  organization_id: string | null;
  organization_name: string | null;
  owner_name: string | null;
  updated_at: Date;
};

/** Deals de una empresa o de un contacto, todos los estados. */
export async function listDeals({ organizationId, personId }: { organizationId?: string; personId?: string }) {
  return sql<DealListRow[]>`
    SELECT d.id, d.title, d.status, d.value::text, d.currency, p.name AS pipeline_name, s.name AS stage_name,
           d.organization_id, o.name AS organization_name, u.name AS owner_name, d.updated_at
    FROM deals d
    JOIN pipelines p ON p.id = d.pipeline_id
    JOIN stages s ON s.id = d.stage_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN users u ON u.id = d.owner_id
    WHERE d.deleted_at IS NULL
      AND (${organizationId ?? null}::uuid IS NULL OR d.organization_id = ${organizationId ?? null}::uuid)
      AND (${personId ?? null}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id AND dp.person_id = ${personId ?? null}::uuid))
    ORDER BY (d.status = 'open') DESC, d.updated_at DESC`;
}

export async function dealParticipants(dealId: string) {
  return sql<{ person_id: string; full_name: string; email: string | null; role: string | null; is_primary: boolean;
               job_title: string | null; organization_name: string | null }[]>`
    SELECT p.id AS person_id, p.full_name,
           (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           dp.role, dp.is_primary, cur.job_title, o.name AS organization_name
    FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
    LEFT JOIN LATERAL (
      SELECT organization_id, job_title FROM person_organizations
      WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1
    ) cur ON true
    LEFT JOIN organizations o ON o.id = cur.organization_id
    WHERE dp.deal_id = ${dealId}
    ORDER BY dp.is_primary DESC, p.full_name`;
}

export async function stageHistory(dealId: string) {
  return sql<{ stage_name: string; pipeline_name: string; changed_at: Date; days: number | null }[]>`
    SELECT s.name AS stage_name, p.name AS pipeline_name, h.changed_at,
           floor(extract(epoch FROM coalesce(lead(h.changed_at) OVER w, now()) - h.changed_at) / 86400)::int AS days
    FROM deal_stage_history h
    JOIN stages s ON s.id = h.to_stage_id
    JOIN pipelines p ON p.id = h.pipeline_id
    WHERE h.deal_id = ${dealId}
    WINDOW w AS (ORDER BY h.changed_at, h.id)
    ORDER BY h.changed_at, h.id`;
}

// ---------------------------------------------------------------------------
// Alta y edición

const dealSchema = z.object({
  title: text("El título", 300),
  organization_id: optId,
  person_id: optId,
  pipeline_id: id,
  stage_id: optId,
  value: optMoney,
  currency: optional(z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Moneda no válida")),
  expected_close_date: optDate,
  owner_id: optId,
  source: optText(200),
});

/** Primera fase activa de un pipeline. */
async function firstStage(db: Db, pipelineId: string): Promise<string> {
  const [s] = await db<{ id: string }[]>`
    SELECT id FROM stages WHERE pipeline_id = ${pipelineId} AND is_active ORDER BY position LIMIT 1`;
  if (!s) throw new UserError("El pipeline no tiene fases.");
  return s.id;
}

export async function createDeal(
  actor: Actor,
  data: unknown,
  custom: Record<string, unknown> = {},
  opts: { db?: Db; leadId?: string | null } = {},
): Promise<string> {
  const v = parse(dealSchema, data);
  const run = async (tx: Db) => {
    const stageId = v.stage_id ?? (await firstStage(tx, v.pipeline_id));
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO deals ${tx({
        title: v.title,
        organization_id: v.organization_id ?? null,
        pipeline_id: v.pipeline_id,
        stage_id: stageId,
        value: v.value ?? null,
        currency: v.currency ?? "EUR",
        expected_close_date: v.expected_close_date ?? null,
        owner_id: v.owner_id ?? null,
        source: v.source ?? null,
        lead_id: opts.leadId ?? null,
        custom: json(custom),
      })} RETURNING id`;
    if (v.person_id) {
      await tx`INSERT INTO deal_participants (deal_id, person_id, is_primary) VALUES (${row.id}, ${v.person_id}, true)`;
    }
    await recordEvent(tx, actor, "deal", row.id, "deal.created", {
      title: v.title, pipeline_id: v.pipeline_id, stage_id: stageId, value: v.value ?? null,
    });
    return row.id;
  };
  return opts.db ? run(opts.db) : transaction(run);
}

const updateSchema = dealSchema.omit({ person_id: true }).extend({ stage_id: id });

export async function updateDeal(actor: Actor, dealId: string, data: unknown, custom: Record<string, unknown>) {
  const v = parse(updateSchema, data);
  await transaction(async (tx) => {
    const before = await getDeal(dealId, tx);
    if (!before) throw new UserError("El deal no existe.");
    await tx`
      UPDATE deals SET ${tx({
        title: v.title,
        organization_id: v.organization_id ?? null,
        pipeline_id: v.pipeline_id,
        stage_id: v.stage_id,
        value: v.value ?? null,
        currency: v.currency ?? before.currency,
        expected_close_date: v.expected_close_date ?? null,
        owner_id: v.owner_id ?? null,
        source: v.source ?? null,
        custom: json(custom),
      })} WHERE id = ${dealId}`;
    if (before.pipeline_id !== v.pipeline_id) {
      await recordEvent(tx, actor, "deal", dealId, "deal.pipeline_changed", {
        from_pipeline_id: before.pipeline_id, to_pipeline_id: v.pipeline_id, to_stage_id: v.stage_id,
      });
    } else if (before.stage_id !== v.stage_id) {
      await recordEvent(tx, actor, "deal", dealId, "deal.stage_changed", {
        from_stage_id: before.stage_id, to_stage_id: v.stage_id,
      });
    }
    await recordEvent(tx, actor, "deal", dealId, "deal.updated", {});
  });
}

/** Mueve un deal abierto a otra fase de su pipeline (tablero / barra de fases). */
export async function moveDealToStage(actor: Actor, dealId: string, stageId: string) {
  await transaction(async (tx) => {
    const [d] = await tx<{ stage_id: string; pipeline_id: string; status: string; stage_name: string }[]>`
      SELECT d.stage_id, d.pipeline_id, d.status, s.name AS stage_name
      FROM deals d JOIN stages s ON s.id = d.stage_id
      WHERE d.id = ${dealId} AND d.deleted_at IS NULL FOR UPDATE OF d`;
    if (!d) throw new UserError("El deal no existe.");
    if (d.stage_id === stageId) return;
    const [target] = await tx<{ pipeline_id: string; name: string; is_active: boolean }[]>`
      SELECT pipeline_id, name, is_active FROM stages WHERE id = ${stageId}`;
    if (!target || !target.is_active || target.pipeline_id !== d.pipeline_id) {
      throw new UserError("Esa fase no pertenece al pipeline del deal.");
    }
    await tx`UPDATE deals SET stage_id = ${stageId} WHERE id = ${dealId}`;
    await recordEvent(tx, actor, "deal", dealId, "deal.stage_changed", {
      from_stage_id: d.stage_id, from_stage: d.stage_name, to_stage_id: stageId, to_stage: target.name,
    });
  });
}

// ---------------------------------------------------------------------------
// Cierre

export async function winDeal(actor: Actor, dealId: string) {
  await transaction(async (tx) => {
    const d = await getDeal(dealId, tx);
    if (!d) throw new UserError("El deal no existe.");
    if (d.status === "won") return;
    await tx`UPDATE deals SET status = 'won' WHERE id = ${dealId}`;
    // deal.won es el disparador del traspaso a Customer Success (resumen con IA, fase 2).
    await recordEvent(tx, actor, "deal", dealId, "deal.won", {
      value: d.value, organization_id: d.organization_id, pipeline_id: d.pipeline_id,
    });
  });
}

const loseSchema = z.object({ lost_reason_id: optId, lost_note: optText(2000) });

/**
 * Marca el deal como perdido con su motivo. Si el motivo tiene días de
 * seguimiento, crea una tarea para volver a contactar en esa fecha.
 */
export async function loseDeal(actor: Actor, dealId: string, data: unknown) {
  const v = parse(loseSchema, data);
  if (!v.lost_reason_id) throw new UserError("Indica el motivo de pérdida.");
  return transaction(async (tx) => {
    const d = await getDeal(dealId, tx);
    if (!d) throw new UserError("El deal no existe.");
    const [reason] = await tx<{ label: string; followup_days: number | null }[]>`
      SELECT label, followup_days FROM lost_reasons WHERE id = ${v.lost_reason_id!} AND is_active`;
    if (!reason) throw new UserError("Motivo de pérdida no válido.");
    await tx`UPDATE deals SET status = 'lost', lost_reason_id = ${v.lost_reason_id!}, lost_note = ${v.lost_note ?? null}
             WHERE id = ${dealId}`;
    let followUpId: string | null = null;
    if (reason.followup_days) {
      const [primary] = await tx<{ person_id: string }[]>`
        SELECT person_id FROM deal_participants WHERE deal_id = ${dealId} ORDER BY is_primary DESC LIMIT 1`;
      const [task] = await tx<{ id: string }[]>`
        INSERT INTO activities (type, subject, note, due_at, deal_id, person_id, organization_id, owner_id)
        VALUES ('task', ${`Retomar contacto: ${d.title}`},
                ${`Deal perdido por «${reason.label}». Seguimiento programado a ${reason.followup_days} días.`},
                now() + make_interval(days => ${reason.followup_days}), ${dealId}, ${primary?.person_id ?? null},
                ${d.organization_id}, ${d.owner_id})
        RETURNING id`;
      followUpId = task.id;
    }
    await recordEvent(tx, actor, "deal", dealId, "deal.lost", {
      reason: reason.label, note: v.lost_note ?? null, follow_up_activity_id: followUpId,
      follow_up_days: reason.followup_days,
    });
    return { followUpDays: reason.followup_days };
  });
}

export async function reopenDeal(actor: Actor, dealId: string) {
  await transaction(async (tx) => {
    const d = await getDeal(dealId, tx);
    if (!d) throw new UserError("El deal no existe.");
    if (d.status === "open") return;
    await tx`UPDATE deals SET status = 'open' WHERE id = ${dealId}`;
    await recordEvent(tx, actor, "deal", dealId, "deal.reopened", { previous_status: d.status });
  });
}

// ---------------------------------------------------------------------------
// Contactos del deal

export async function addParticipant(actor: Actor, dealId: string, data: unknown) {
  const v = parse(z.object({ person_id: id, role: optText(100) }), data);
  await transaction(async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM deal_participants WHERE deal_id = ${dealId}`;
    await tx`INSERT INTO deal_participants (deal_id, person_id, role, is_primary)
             VALUES (${dealId}, ${v.person_id}, ${v.role ?? null}, ${n === 0})
             ON CONFLICT (deal_id, person_id) DO UPDATE SET role = EXCLUDED.role`;
    await recordEvent(tx, actor, "deal", dealId, "deal.participant_added", { person_id: v.person_id });
  });
}

export async function removeParticipant(actor: Actor, dealId: string, personId: string) {
  await transaction(async (tx) => {
    const [removed] = await tx<{ is_primary: boolean }[]>`
      DELETE FROM deal_participants WHERE deal_id = ${dealId} AND person_id = ${personId} RETURNING is_primary`;
    if (removed?.is_primary) {
      await tx`UPDATE deal_participants SET is_primary = true
               WHERE deal_id = ${dealId} AND person_id = (
                 SELECT person_id FROM deal_participants WHERE deal_id = ${dealId} ORDER BY created_at LIMIT 1)`;
    }
    await recordEvent(tx, actor, "deal", dealId, "deal.participant_removed", { person_id: personId });
  });
}

export async function listLostReasons(includeInactive = false) {
  return sql<{ id: string; label: string; followup_days: number | null; is_active: boolean }[]>`
    SELECT id, label, followup_days, is_active FROM lost_reasons
    WHERE ${includeInactive} OR is_active ORDER BY label`;
}
