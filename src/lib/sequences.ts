import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { createActivity } from "./activities";
import { connectionById, connectionOf, sendEmail, sentToday, slotsText, warmupLimit } from "./mailbox";
import { nextSendWindow, unsubscribeFooter, type Campaign } from "./campaigns";
import { renderTemplate } from "./automations";
import { templateVars } from "./emails";
import { isId, parse, text } from "./validation";
import { zonedToUtc } from "./slots";

// ===========================================================================
// Secuencias: varios correos y tareas espaciados en días que salen solos
// desde el buzón del responsable y se paran en cuanto el contacto responde,
// agenda una reunión o el deal se cierra.
// ===========================================================================

export type Sequence = {
  id: string; name: string; description: string | null; is_active: boolean; stop_on_reply: boolean; stop_on_meeting: boolean;
  steps: number; active: number; completed: number; replied: number; total: number; created_at: Date;
};

export type SequenceStep = {
  id: string; position: number; delay_days: number; kind: "email" | "task"; subject: string; body: string; task_type: string | null;
};

export type Enrollment = {
  id: string; sequence_id: string; sequence_name: string; deal_id: string | null; deal_title: string | null;
  person_id: string; person_name: string; status: "active" | "completed" | "stopped" | "failed"; next_step: number;
  steps: number; next_run_at: Date | null; stopped_reason: string | null; error: string | null; created_at: Date;
  user_name: string | null;
};

export async function listSequences(): Promise<Sequence[]> {
  return sql<Sequence[]>`
    SELECT s.id, s.name, s.description, s.is_active, s.stop_on_reply, s.stop_on_meeting, s.created_at,
           (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
           count(e.id) FILTER (WHERE e.status = 'active')::int AS active,
           count(e.id) FILTER (WHERE e.status = 'completed')::int AS completed,
           count(e.id) FILTER (WHERE e.stopped_reason = 'Respondió')::int AS replied,
           count(e.id)::int AS total
    FROM sequences s LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
    GROUP BY s.id ORDER BY s.is_active DESC, lower(s.name)`;
}

export async function getSequence(id: string) {
  const [s] = await sql<Omit<Sequence, "steps" | "active" | "completed" | "replied" | "total">[]>`
    SELECT id, name, description, is_active, stop_on_reply, stop_on_meeting, created_at FROM sequences WHERE id = ${id}`;
  if (!s) return null;
  const steps = await sql<SequenceStep[]>`
    SELECT id, position, delay_days, kind, subject, body, task_type FROM sequence_steps WHERE sequence_id = ${id} ORDER BY position`;
  return { ...s, steps };
}

const selectEnrollments = (where: ReturnType<typeof sql>) => sql<Enrollment[]>`
  SELECT e.id, e.sequence_id, s.name AS sequence_name, e.deal_id, d.title AS deal_title, e.person_id, p.full_name AS person_name,
         e.status, e.next_step, (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = e.sequence_id) AS steps,
         e.next_run_at, e.stopped_reason, e.error, e.created_at, u.name AS user_name
  FROM sequence_enrollments e
  JOIN sequences s ON s.id = e.sequence_id
  JOIN persons p ON p.id = e.person_id
  LEFT JOIN deals d ON d.id = e.deal_id
  LEFT JOIN users u ON u.id = e.user_id
  ${where}
  ORDER BY (e.status = 'active') DESC, e.created_at DESC
  LIMIT 300`;

export const listEnrollments = (ref: { sequenceId?: string; dealId?: string }) =>
  selectEnrollments(ref.sequenceId ? sql`WHERE e.sequence_id = ${ref.sequenceId}` : sql`WHERE e.deal_id = ${ref.dealId ?? null}`);

// ---------------------------------------------------------------------------
// Edición

const seqSchema = z.object({
  name: text("El nombre", 120),
  description: z.string().trim().max(1000).optional(),
  is_active: z.string().optional(),
  stop_on_reply: z.string().optional(),
  stop_on_meeting: z.string().optional(),
});

export async function createSequence(actor: Actor, data: unknown): Promise<string> {
  const v = parse(seqSchema, data);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequences (name, description, created_by) VALUES (${v.name}, ${v.description || null}, ${actor.id}) RETURNING id`;
  return row.id;
}

export async function updateSequence(id: string, data: unknown) {
  const v = parse(seqSchema, data);
  const res = await sql`
    UPDATE sequences SET name = ${v.name}, description = ${v.description || null}, is_active = ${v.is_active === "on"},
           stop_on_reply = ${v.stop_on_reply === "on"}, stop_on_meeting = ${v.stop_on_meeting === "on"}
    WHERE id = ${id}`;
  if (res.count === 0) throw new UserError("La secuencia no existe.");
}

export async function deleteSequence(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sequence_enrollments WHERE sequence_id = ${id} AND status = 'active'`;
  if (n > 0) throw new UserError(`Hay ${n} contacto${n === 1 ? "" : "s"} en marcha en esta secuencia: páralos o desactívala.`);
  await sql`DELETE FROM sequences WHERE id = ${id}`;
}

const stepSchema = z.object({
  kind: z.enum(["email", "task"], { message: "Tipo de paso no válido" }),
  delay_days: z.coerce.number().int().min(0, "Mínimo 0 días").max(90, "Máximo 90 días"),
  subject: text("El asunto", 300),
  body: z.string().max(20000).optional(),
  task_type: z.string().trim().optional(),
});

export async function saveStep(sequenceId: string, stepId: string | null, data: unknown) {
  const v = parse(stepSchema, data);
  if (v.kind === "email" && !v.body?.trim()) throw new UserError("Falta el texto del correo.");
  const taskType = v.kind === "task" ? v.task_type || "task" : null;
  if (stepId) {
    const res = await sql`UPDATE sequence_steps SET kind = ${v.kind}, delay_days = ${v.delay_days}, subject = ${v.subject},
                          body = ${v.body ?? ""}, task_type = ${taskType} WHERE id = ${stepId} AND sequence_id = ${sequenceId}`;
    if (res.count === 0) throw new UserError("El paso no existe.");
    return;
  }
  await sql`
    INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, subject, body, task_type)
    VALUES (${sequenceId}, (SELECT coalesce(max(position), 0) + 1 FROM sequence_steps WHERE sequence_id = ${sequenceId}),
            ${v.delay_days}, ${v.kind}, ${v.subject}, ${v.body ?? ""}, ${taskType})`;
}

export async function deleteStep(sequenceId: string, stepId: string) {
  await sql.begin(async (tx) => {
    const [st] = await tx<{ position: number }[]>`DELETE FROM sequence_steps WHERE id = ${stepId} AND sequence_id = ${sequenceId} RETURNING position`;
    if (!st) return;
    await tx`UPDATE sequence_steps SET position = position - 1 WHERE sequence_id = ${sequenceId} AND position > ${st.position}`;
    // Quien estaba esperando un paso posterior no se lo salta.
    await tx`UPDATE sequence_enrollments SET next_step = next_step - 1
             WHERE sequence_id = ${sequenceId} AND status = 'active' AND next_step >= ${st.position}`;
  });
}

// ---------------------------------------------------------------------------
// Inscribir y parar

/** Inscribe al contacto de un deal (por defecto, el principal). */
export async function enroll(actor: Actor, sequenceId: string, dealId: string, personId?: string | null): Promise<string> {
  if (!isId(sequenceId)) throw new UserError("Elige una secuencia.");
  if (personId && !isId(personId)) personId = null;
  const seq = await getSequence(sequenceId);
  if (!seq) throw new UserError("La secuencia no existe.");
  if (!seq.is_active) throw new UserError("La secuencia está desactivada.");
  if (seq.steps.length === 0) throw new UserError("La secuencia no tiene pasos.");
  const [d] = await sql<{ owner_id: string | null; status: string; person_id: string | null; email: string | null; unsubscribed: boolean }[]>`
    SELECT d.owner_id, d.status, p.id AS person_id, p.unsubscribed_at IS NOT NULL AS unsubscribed,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
    FROM deals d
    LEFT JOIN LATERAL (
      SELECT p.* FROM deal_participants dp JOIN persons p ON p.id = dp.person_id AND p.deleted_at IS NULL
      WHERE dp.deal_id = d.id AND (${personId ?? null}::uuid IS NULL OR p.id = ${personId ?? null}::uuid)
      ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1
    ) p ON true
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  if (!d) throw new UserError("El deal no existe.");
  if (d.status !== "open") throw new UserError("El deal ya está cerrado.");
  if (!d.person_id) throw new UserError("El deal no tiene contacto.");
  if (!d.email && seq.steps.some((s) => s.kind === "email")) throw new UserError("El contacto no tiene email.");
  if (d.unsubscribed) throw new UserError("El contacto se dio de baja de las comunicaciones.");
  const sender = (d.owner_id && (await connectionOf(d.owner_id))?.status === "active") ? d.owner_id
    : actor.id && (await connectionOf(actor.id))?.status === "active" ? actor.id : d.owner_id ?? actor.id;
  const first = seq.steps[0];
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by)
    VALUES (${sequenceId}, ${dealId}, ${d.person_id}, ${sender}, 0, now() + make_interval(days => ${first.delay_days}), ${actor.id})
    ON CONFLICT (sequence_id, person_id) WHERE status = 'active' DO NOTHING
    RETURNING id`;
  if (!row) throw new UserError("Ese contacto ya está en esta secuencia.");
  await recordEvent(sql, actor, "deal", dealId, "sequence.enrolled", { sequence_id: sequenceId, sequence: seq.name, enrollment_id: row.id });
  return row.id;
}

export async function stopEnrollment(actor: Actor, enrollmentId: string, reason = "Parada a mano") {
  const [e] = await sql<{ deal_id: string | null; name: string }[]>`
    UPDATE sequence_enrollments x SET status = 'stopped', stopped_reason = ${reason}, finished_at = now(), next_run_at = NULL
    FROM sequences s WHERE x.id = ${enrollmentId} AND x.status = 'active' AND s.id = x.sequence_id
    RETURNING x.deal_id, s.name`;
  if (!e) throw new UserError("Esa inscripción ya no está en marcha.");
  if (e.deal_id) await recordEvent(sql, actor, "deal", e.deal_id, "sequence.stopped", { sequence: e.name, reason });
}

// ---------------------------------------------------------------------------
// Motor (lo llama la revisión periódica)

const SYSTEM: Actor = { type: "system", id: null };

/** Para las inscripciones cuyo contacto ya respondió, agendó o cuyo deal se cerró. */
async function stopFinished(): Promise<number> {
  const stop = async (reason: string, where: ReturnType<typeof sql>) => {
    const rows = await sql<{ deal_id: string | null; name: string }[]>`
      UPDATE sequence_enrollments e SET status = 'stopped', stopped_reason = ${reason}, finished_at = now(), next_run_at = NULL
      FROM sequences s
      WHERE s.id = e.sequence_id AND e.status = 'active' AND ${where}
      RETURNING e.deal_id, s.name`;
    for (const r of rows) if (r.deal_id) await recordEvent(sql, SYSTEM, "deal", r.deal_id, "sequence.stopped", { sequence: r.name, reason });
    return rows.length;
  };
  let n = 0;
  n += await stop("Respondió", sql`s.stop_on_reply AND EXISTS (
    SELECT 1 FROM emails m WHERE m.person_id = e.person_id AND m.direction = 'in' AND m.sent_at > e.created_at
      AND m.reply_class IS DISTINCT FROM 'ooo' AND m.reply_class IS DISTINCT FROM 'bounce')`);
  n += await stop("Agendó una reunión", sql`s.stop_on_meeting AND EXISTS (
    SELECT 1 FROM activities a JOIN activity_types t ON t.key = a.type AND t.is_session
    WHERE (a.deal_id = e.deal_id OR a.person_id = e.person_id) AND a.created_at > e.created_at AND a.enrollment_id IS NULL
      AND (a.due_at IS NULL OR a.due_at >= e.created_at))`);
  n += await stop("El deal se cerró", sql`EXISTS (
    SELECT 1 FROM deals d WHERE d.id = e.deal_id AND (d.status <> 'open' OR d.deleted_at IS NOT NULL))`);
  n += await stop("Se dio de baja", sql`EXISTS (SELECT 1 FROM persons p WHERE p.id = e.person_id AND p.unsubscribed_at IS NOT NULL)`);
  return n;
}

/** Vencimiento de las tareas de una secuencia: al final del día de hoy (hora local). */
function endOfToday() {
  const tz = process.env.TZ || "Europe/Madrid";
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  return zonedToUtc(y, m, d, 23, 59, tz).toISOString();
}

type CampaignCtx = Pick<Campaign, "send_days" | "send_from" | "send_to" | "status"> & {
  campaign_id: string; personal_line: string | null; organization: string | null; organization_id: string | null;
};

async function campaignContext(contactId: string): Promise<CampaignCtx | null> {
  const [c] = await sql<CampaignCtx[]>`
    SELECT c.id AS campaign_id, c.status, c.send_days, c.send_from, c.send_to, cc.personal_line, o.name AS organization, o.id AS organization_id
    FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id
    LEFT JOIN LATERAL (SELECT organization_id FROM person_organizations WHERE person_id = cc.person_id AND status = 'current' LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    WHERE cc.id = ${contactId}`;
  return c ?? null;
}

/** ¿Puede salir ya este correo de campaña? Si no, cuándo reintentar (o null si hay que parar). */
async function campaignGate(c: CampaignCtx, mailboxId: string | null): Promise<{ ok: true } | { ok: false; retryAt: Date | null; reason: string }> {
  if (c.status === "finished") return { ok: false, retryAt: null, reason: "Campaña terminada" };
  if (c.status !== "active") return { ok: false, retryAt: new Date(Date.now() + 3600000), reason: "Campaña en pausa" };
  const window = nextSendWindow(c);
  if (window.getTime() > Date.now() + 60000) return { ok: false, retryAt: window, reason: "Fuera del horario de envío" };
  if (!mailboxId) return { ok: false, retryAt: null, reason: "Sin buzón de outbound" };
  const conn = await connectionById(mailboxId);
  if (!conn) return { ok: false, retryAt: null, reason: "El buzón de outbound ya no está conectado" };
  if (conn.paused) return { ok: false, retryAt: new Date(Date.now() + 3600000), reason: "Buzón en pausa" };
  if (await sentToday(mailboxId) >= warmupLimit(conn)) {
    // Cupo del día agotado: mañana, dentro del horario.
    return { ok: false, retryAt: nextSendWindow(c, new Date(Date.now() + 86400000 - (Date.now() % 86400000))), reason: "Límite diario del buzón" };
  }
  return { ok: true };
}

export async function processSequences(limit = 50): Promise<{ sent: number; tasks: number; stopped: number; failed: number }> {
  const out = { sent: 0, tasks: 0, stopped: await stopFinished(), failed: 0 };
  const due = await sql<{ id: string; sequence_id: string; deal_id: string | null; person_id: string; user_id: string | null;
                          enrolled_by: string | null; next_step: number; mailbox_id: string | null; campaign_contact_id: string | null }[]>`
    UPDATE sequence_enrollments SET next_run_at = now() + interval '10 minutes'   -- reclamada: nadie más la procesa a la vez
    WHERE id IN (
      SELECT e.id FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id AND s.is_active
      WHERE e.status = 'active' AND e.next_run_at <= now()
      ORDER BY e.next_run_at LIMIT ${limit} FOR UPDATE OF e SKIP LOCKED)
    RETURNING id, sequence_id, deal_id, person_id, user_id, enrolled_by, next_step, mailbox_id, campaign_contact_id`;
  for (const e of due) {
    // Campañas de outbound: horario, buzón en pausa y límite diario (con calentamiento).
    const camp = e.campaign_contact_id ? await campaignContext(e.campaign_contact_id) : null;
    if (e.campaign_contact_id) {
      const gate = camp ? await campaignGate(camp, e.mailbox_id) : { ok: false as const, retryAt: null, reason: "La campaña ya no existe" };
      if (!gate.ok) {
        if (gate.retryAt) await sql`UPDATE sequence_enrollments SET next_run_at = ${gate.retryAt} WHERE id = ${e.id}`;
        else await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = ${gate.reason}, finished_at = now(), next_run_at = NULL WHERE id = ${e.id}`;
        continue;
      }
    }
    const steps = await sql<SequenceStep[]>`
      SELECT id, position, delay_days, kind, subject, body, task_type FROM sequence_steps WHERE sequence_id = ${e.sequence_id} ORDER BY position`;
    const step = steps[e.next_step];
    const actor: Actor = { type: "user", id: e.enrolled_by };
    try {
      if (step) {
        const [p] = await sql<{ full_name: string; email: string | null; organization_id: string | null }[]>`
          SELECT p.full_name, (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
                 (SELECT organization_id FROM deals WHERE id = ${e.deal_id}) AS organization_id
          FROM persons p WHERE p.id = ${e.person_id}`;
        const vars = { ...(e.deal_id ? await templateVars(e.deal_id) : {}), nombre: (p?.full_name ?? "").split(/\s+/)[0] ?? "",
                       ...(camp ? { empresa: camp.organization ?? "", gancho: camp.personal_line ?? "" } : {}) };
        if (step.kind === "email") {
          const conn = e.mailbox_id ? await connectionById(e.mailbox_id) : e.user_id ? await connectionOf(e.user_id) : null;
          if (!conn || conn.status !== "active") throw new Error("La cuenta de correo del responsable no está conectada.");
          if (!p?.email) throw new Error("El contacto ya no tiene email.");
          const all = { ...vars, ...(step.body.includes("{huecos}") ? { huecos: await slotsText(conn) } : {}) };
          // En campañas, la línea personalizada vacía no deja huecos raros y siempre va el enlace de baja.
          const body = renderTemplate(step.body, all).replace(/\n{3,}/g, "\n\n").trim() + (camp ? unsubscribeFooter(e.person_id) : "");
          const sent = await sendEmail(conn, actor, {
            to: { email: p.email, name: p.full_name }, subject: renderTemplate(step.subject, all), body,
            dealId: e.deal_id, personId: e.person_id, organizationId: p.organization_id ?? camp?.organization_id ?? null,
          });
          await sql`UPDATE emails SET enrollment_id = ${e.id}, campaign_id = ${camp?.campaign_id ?? null} WHERE id = ${sent.emailId}`;
          out.sent++;
        } else {
          const [d] = e.deal_id ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${e.deal_id}` : [];
          const activityId = await createActivity(actor, {
            type: step.task_type ?? "task", subject: renderTemplate(step.subject, vars).slice(0, 300),
            note: step.body ? renderTemplate(step.body, vars) : undefined, due_at: endOfToday(),
            deal_id: e.deal_id ?? undefined, person_id: e.person_id, owner_id: d?.owner_id ?? e.user_id ?? undefined,
          });
          await sql`UPDATE activities SET enrollment_id = ${e.id} WHERE id = ${activityId}`;
          out.tasks++;
        }
      }
      const next = steps[e.next_step + 1];
      if (next) {
        await sql`UPDATE sequence_enrollments SET next_step = next_step + 1, error = NULL, attempts = 0,
                         next_run_at = now() + make_interval(days => ${next.delay_days}) WHERE id = ${e.id}`;
      } else {
        await sql`UPDATE sequence_enrollments SET status = 'completed', next_step = ${steps.length}, next_run_at = NULL, finished_at = now(), error = NULL, attempts = 0
                  WHERE id = ${e.id}`;
        if (e.campaign_contact_id) await sql`UPDATE campaign_contacts SET status = 'completed', updated_at = now() WHERE id = ${e.campaign_contact_id} AND status = 'enrolled'`;
      }
    } catch (err) {
      out.failed++;
      // Se reintenta dentro de una hora; al tercer fallo seguido se da por fallida.
      const msg = err instanceof Error ? err.message.slice(0, 300) : "Error";
      await sql`
        UPDATE sequence_enrollments SET error = ${msg}, attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END,
          finished_at = CASE WHEN attempts + 1 >= 3 THEN now() END,
          next_run_at = CASE WHEN attempts + 1 >= 3 THEN NULL ELSE now() + interval '1 hour' END
        WHERE id = ${e.id}`;
    }
  }
  return out;
}
