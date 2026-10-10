import { sql } from "./db";
import { createActivity } from "./activities";
import { winDeal } from "./deals";
import { AI_ACTOR } from "./events";
import { workdayAt } from "./next-activity";
import { notify } from "./notifications";

// ===========================================================================
// Piloto automático: lo que el CRM hace solo, sin reglas que configurar,
// para que ningún deal se quede parado. Cada cosa se enciende o apaga en
// Ajustes → Piloto automático y respeta «Pausar todo» de las automatizaciones.
// Todo lo que hace queda apuntado (autopilot_log) y se ve allí.
// ===========================================================================

export type Autopilot = {
  nextStep: { on: boolean; days: number };       // deal abierto sin nada pendiente → tarea «decidir siguiente paso»
  emailHot: { on: boolean; opens: number };      // correo abierto N veces sin respuesta → llamada
  docHot: { on: boolean; views: number };        // documento compartido abierto N veces → llamada
  signWon: { on: boolean };                      // contrato firmado por todos → deal ganado
  overdueNudge: { on: boolean; days: number };   // actividades vencidas hace N días → aviso al responsable (una vez)
};

export const AUTOPILOT_DEFAULTS: Autopilot = {
  nextStep: { on: true, days: 1 }, emailHot: { on: true, opens: 3 }, docHot: { on: true, views: 2 }, signWon: { on: true }, overdueNudge: { on: true, days: 2 },
};

export async function getAutopilot(): Promise<Autopilot & { paused: boolean }> {
  const [s] = await sql<{ autopilot: Partial<Autopilot>; paused: boolean }[]>`SELECT autopilot, paused FROM automation_settings LIMIT 1`.catch(() => []);
  const a = s?.autopilot ?? {};
  return {
    nextStep: { ...AUTOPILOT_DEFAULTS.nextStep, ...a.nextStep }, emailHot: { ...AUTOPILOT_DEFAULTS.emailHot, ...a.emailHot },
    docHot: { ...AUTOPILOT_DEFAULTS.docHot, ...a.docHot }, signWon: { ...AUTOPILOT_DEFAULTS.signWon, ...a.signWon },
    overdueNudge: { ...AUTOPILOT_DEFAULTS.overdueNudge, ...a.overdueNudge }, paused: s?.paused ?? false,
  };
}

export async function saveAutopilot(data: Record<string, unknown>) {
  const on = (k: string) => data[k] === "on";
  const n = (k: string, min: number, max: number, def: number) => { const v = Number(data[k]); return Number.isInteger(v) && v >= min && v <= max ? v : def; };
  const a: Autopilot = {
    nextStep: { on: on("next_step"), days: n("next_step_days", 0, 30, 1) },
    emailHot: { on: on("email_hot"), opens: n("email_hot_opens", 2, 20, 3) },
    docHot: { on: on("doc_hot"), views: n("doc_hot_views", 1, 20, 2) },
    signWon: { on: on("sign_won") },
    overdueNudge: { on: on("overdue_nudge"), days: n("overdue_days", 1, 30, 2) },
  };
  await sql`UPDATE automation_settings SET autopilot = ${sql.json(a as never)}`;
}

async function done(kind: string, ref: string, dealId: string | null, detail: string) {
  await sql`INSERT INTO autopilot_log (kind, ref, deal_id, detail) VALUES (${kind}, ${ref}, ${dealId}, ${detail.slice(0, 300)})`;
}
async function already(kind: string, ref: string, days: number) {
  const [r] = await sql`SELECT 1 FROM autopilot_log WHERE kind = ${kind} AND ref = ${ref} AND at > now() - make_interval(days => ${days})`;
  return Boolean(r);
}

/** Lo llama el ciclo de automatizaciones. Devuelve cuántas cosas ha hecho. */
export async function runAutopilot(): Promise<number> {
  const a = await getAutopilot();
  if (a.paused) return 0;
  let n = 0;

  // 1. Deals abiertos sin ninguna actividad pendiente: una tarea para decidir el siguiente paso.
  if (a.nextStep.on) {
    const deals = await sql<{ id: string; title: string; owner_id: string | null }[]>`
      SELECT d.id, d.title, d.owner_id FROM deals d
      WHERE d.status = 'open' AND d.deleted_at IS NULL AND d.owner_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = d.id AND NOT a.done)
        AND greatest(d.created_at, coalesce((SELECT max(coalesce(a.done_at, a.updated_at)) FROM activities a WHERE a.deal_id = d.id), d.created_at))
            < now() - make_interval(days => ${a.nextStep.days})
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l WHERE l.kind = 'next_step' AND l.ref = d.id::text AND l.at > now() - interval '14 days')
      ORDER BY d.value DESC NULLS LAST LIMIT 40`;
    for (const d of deals) {
      try {
        await createActivity(AI_ACTOR, { type: "task", subject: "Decidir el siguiente paso", deal_id: d.id, owner_id: d.owner_id,
          due_at: workdayAt(0, 10).getTime() < Date.now() ? workdayAt(1, 10).toISOString() : workdayAt(0, 10).toISOString(),
          note: "El deal se había quedado sin nada programado. Llama, escribe o cámbialo de fase; si ya no tiene recorrido, márcalo como perdido." });
        await done("next_step", d.id, d.id, `«${d.title}» no tenía nada programado: tarea para decidir el siguiente paso`);
        n++;
      } catch (err) { console.error("[piloto] siguiente paso", err); }
    }
  }

  // 2. Correos abiertos varias veces sin respuesta: llamada (es el mejor momento).
  if (a.emailHot.on) {
    const hot = await sql<{ id: string; subject: string; deal_id: string | null; person_id: string | null; who: string | null; owner: string | null; opens: number }[]>`
      SELECT e.id, e.subject, e.deal_id, e.person_id, coalesce(p.full_name, e.to_name, e.to_email) AS who, coalesce(d.owner_id, e.user_id) AS owner,
             count(o.id)::int AS opens
      FROM emails e JOIN email_opens o ON o.email_id = e.id AND NOT o.automatic
      LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id
      WHERE e.direction = 'out' AND e.status = 'sent' AND e.sent_at > now() - interval '21 days' AND e.sequence_step_id IS NULL
        AND (e.deal_id IS NULL OR d.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.sent_at > e.sent_at AND (r.person_id = e.person_id OR lower(r.from_email) = lower(e.to_email)))
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l WHERE l.kind = 'email_hot' AND l.ref = e.id::text)
      GROUP BY e.id, p.full_name, d.owner_id
      HAVING count(o.id) >= ${a.emailHot.opens} AND max(o.at) > now() - interval '48 hours'
      LIMIT 30`;
    for (const e of hot) {
      if (!e.owner || (!e.deal_id && !e.person_id)) continue;
      try {
        await createActivity(AI_ACTOR, { type: "call", subject: `Llamar a ${e.who ?? "el contacto"}: ha abierto «${e.subject}» ${e.opens} veces`,
          deal_id: e.deal_id ?? undefined, person_id: e.person_id ?? undefined, owner_id: e.owner, due_at: new Date(Date.now() + 30 * 60000).toISOString(),
          note: "Ha abierto tu correo varias veces sin contestar: hay interés. Llama ahora y retoma lo que le enviaste." });
        await done("email_hot", e.id, e.deal_id, `${e.who} abrió «${e.subject}» ${e.opens} veces: llamada programada`);
        n++;
      } catch (err) { console.error("[piloto] correo caliente", err); }
    }
  }

  // 3. Documentos compartidos que se abren una y otra vez: llamada.
  if (a.docHot.on) {
    const docs = await sql<{ id: string; name: string; deal_id: string | null; person_id: string | null; who: string | null; owner: string | null; views: number }[]>`
      SELECT l.id, coalesce(i.name, f.name) AS name, l.deal_id, l.person_id, p.full_name AS who, coalesce(d.owner_id, l.created_by) AS owner, l.view_count AS views
      FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
      LEFT JOIN persons p ON p.id = l.person_id LEFT JOIN deals d ON d.id = l.deal_id
      WHERE l.view_count >= ${a.docHot.views} AND l.last_viewed_at > now() - interval '48 hours' AND (l.deal_id IS NOT NULL OR l.person_id IS NOT NULL)
        AND (l.deal_id IS NULL OR d.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM autopilot_log x WHERE x.kind = 'doc_hot' AND x.ref = l.id::text AND x.at > now() - interval '7 days')
      LIMIT 30`;
    for (const d of docs) {
      if (!d.owner) continue;
      try {
        await createActivity(AI_ACTOR, { type: "call", subject: `Llamar a ${d.who ?? "el contacto"}: está mirando «${d.name}» (${d.views} veces)`,
          deal_id: d.deal_id ?? undefined, person_id: d.person_id ?? undefined, owner_id: d.owner, due_at: new Date(Date.now() + 30 * 60000).toISOString(),
          note: "Ha abierto varias veces el documento que le compartiste. Llama para resolver dudas y proponer el siguiente paso." });
        await done("doc_hot", d.id, d.deal_id, `${d.who ?? "Alguien"} abrió «${d.name}» ${d.views} veces: llamada programada`);
        n++;
      } catch (err) { console.error("[piloto] documento caliente", err); }
    }
  }

  // 4. Actividades que llevan días vencidas: un aviso al responsable (una vez por actividad).
  if (a.overdueNudge.on) {
    const late = await sql<{ id: string; subject: string; owner_id: string; deal_id: string | null; deal: string | null; days: number }[]>`
      SELECT a.id, a.subject, a.owner_id, a.deal_id, d.title AS deal, floor(extract(epoch FROM now() - a.due_at) / 86400)::int AS days
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id
      WHERE NOT a.done AND a.owner_id IS NOT NULL AND a.due_at < now() - make_interval(days => ${a.overdueNudge.days})
        AND (a.deal_id IS NULL OR d.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM autopilot_log l WHERE l.kind = 'overdue' AND l.ref = a.id::text)
      LIMIT 60`;
    for (const x of late) {
      await notify(sql, { userId: x.owner_id, kind: "assigned", title: `Lleva ${x.days} días vencida: «${x.subject}»`,
                          body: x.deal ? `Deal: ${x.deal}. Hazla, cámbiale la fecha o bórrala si ya no toca.` : "Hazla, cámbiale la fecha o bórrala si ya no toca.",
                          link: x.deal_id ? `/deals/${x.deal_id}` : "/activities?period=overdue" });
      await done("overdue", x.id, x.deal_id, `Aviso: «${x.subject}» lleva ${x.days} días vencida`);
      n++;
    }
  }
  return n;
}

/** Al firmar todos un contrato del deal: se gana el deal (si está activado). */
export async function onContractSigned(dealId: string | null, title: string) {
  if (!dealId) return;
  const a = await getAutopilot();
  if (a.paused || !a.signWon.on) return;
  const [d] = await sql<{ status: string; owner_id: string | null; title: string }[]>`SELECT status, owner_id, title FROM deals WHERE id = ${dealId} AND deleted_at IS NULL`;
  if (!d || d.status !== "open") return;
  await winDeal(AI_ACTOR, dealId);
  await done("sign_won", dealId, dealId, `«${d.title}» ganado al firmar todos «${title}»`);
  if (d.owner_id) await notify(sql, { userId: d.owner_id, kind: "sign.completed", title: `¡${d.title} ganado! Se ha firmado «${title}»`, body: "El piloto automático lo ha marcado como ganado.", link: `/deals/${dealId}` });
}

export type AutopilotLog = { id: number; kind: string; deal_id: string | null; deal: string | null; detail: string | null; at: Date };
export const listAutopilotLog = (limit = 50) => sql<AutopilotLog[]>`
  SELECT l.id, l.kind, l.deal_id, d.title AS deal, l.detail, l.at FROM autopilot_log l LEFT JOIN deals d ON d.id = l.deal_id
  ORDER BY l.at DESC LIMIT ${limit}`;

export async function autopilotStats() {
  const [r] = await sql<{ week: number; month: number }[]>`
    SELECT count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week, count(*) FILTER (WHERE at > now() - interval '30 days')::int AS month FROM autopilot_log`;
  return r;
}
