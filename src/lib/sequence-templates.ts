import { sql } from "./db";
import { UserError } from "./errors";
import { generate, parseJsonReply } from "./ai";
import type { Actor } from "./events";
import { STEP_KINDS, isEmailKind, type StepKind } from "./step-kinds";

// ===========================================================================
// Crear secuencias: en blanco, desde una plantilla lista para usar, con IA o
// duplicando otra. También archivar (como en Apollo: no se borra, se aparta).
// ===========================================================================

type TStep = { kind: StepKind; days: number; subject?: string; body: string; thread?: boolean; priority?: "high" | "medium" | "low" };
export type SequenceTemplate = { key: string; name: string; description: string; steps: TStep[] };

export const SEQUENCE_TEMPLATES: SequenceTemplate[] = [
  {
    key: "frio",
    name: "Prospección en frío (3 semanas)",
    description: "8 pasos: correos en el mismo hilo, LinkedIn y dos llamadas. Para contactos que no te conocen.",
    steps: [
      { kind: "linkedin_view", days: 0, body: "Mira su perfil y su empresa: busca algo concreto para personalizar el primer correo." },
      { kind: "email", days: 0, subject: "{{empresa}} y {{remitente_nombre}}", body: "Hola {{nombre}},\n\nTe escribo porque ayudamos a equipos como el de {{empresa}} a [resultado concreto] sin [problema habitual].\n\n¿Es algo que tengáis en el radar este trimestre?\n\nUn saludo,\n{{remitente_nombre}}" },
      { kind: "linkedin_connect", days: 2, body: "Solicitud de conexión con una nota breve (sin vender): «Hola {{nombre}}, te escribí sobre … Encantado de conectar»." },
      { kind: "email", days: 1, thread: true, body: "Hola {{nombre}},\n\nPor si se quedó abajo en la bandeja: ¿te encaja que lo veamos 15 minutos?\n\n{{remitente_nombre}}" },
      { kind: "call", days: 3, priority: "high", body: "Objetivo: conseguir una reunión de 20 minutos. Si no contesta, deja un mensaje breve y menciona el correo." },
      { kind: "email", days: 3, thread: true, body: "Hola {{nombre}},\n\nUn caso parecido al vuestro: [cliente] consiguió [resultado] en [plazo].\n\n¿Lo hablamos?\n\n{{remitente_nombre}}" },
      { kind: "linkedin_message", days: 3, body: "Mensaje corto por LinkedIn retomando la conversación, con una pregunta abierta." },
      { kind: "email", days: 4, subject: "¿Lo dejo aquí?", body: "Hola {{nombre}},\n\nNo quiero insistir más de la cuenta. Si ahora no es el momento, dímelo y te escribo más adelante.\n\nUn saludo,\n{{remitente_nombre}}" },
    ],
  },
  {
    key: "inbound",
    name: "Respuesta a un lead entrante",
    description: "Respuesta rápida a quien pide información: correo al momento, llamada en una hora y dos seguimientos.",
    steps: [
      { kind: "email", days: 0, subject: "Tu solicitud en {{empresa}}", body: "Hola {{nombre}},\n\nGracias por escribirnos. Para ayudarte mejor, ¿qué te gustaría conseguir y para cuándo?\n\nSi te va mejor, lo vemos en una llamada de 15 minutos.\n\n{{remitente_nombre}}" },
      { kind: "call", days: 0, priority: "high", body: "Llamar en la primera hora: es cuando más probable es que conteste." },
      { kind: "email", days: 2, thread: true, body: "Hola {{nombre}},\n\n¿Pudiste ver mi correo? Te dejo mis huecos para que elijas: {{huecos}}\n\n{{remitente_nombre}}" },
      { kind: "call", days: 2, body: "Segundo intento de llamada." },
      { kind: "email", days: 4, subject: "¿Seguimos?", body: "Hola {{nombre}},\n\n¿Sigue en pie lo que nos pediste? Si ha cambiado algo, dímelo y lo adapto.\n\n{{remitente_nombre}}" },
    ],
  },
  {
    key: "demo",
    name: "Seguimiento tras la demo",
    description: "Resumen, materiales, llamada de dudas y un último empujón para decidir.",
    steps: [
      { kind: "email", days: 0, subject: "Resumen de la demo", body: "Hola {{nombre}},\n\nGracias por tu tiempo hoy. Te resumo lo que vimos y los próximos pasos:\n\n- …\n- …\n\n¿Lo comentas con tu equipo y lo vemos el [día]?\n\n{{remitente_nombre}}" },
      { kind: "action_item", days: 1, body: "Enviar la propuesta o los materiales que se comprometieron en la demo." },
      { kind: "call", days: 3, body: "Llamada para resolver dudas y confirmar quién decide y cuándo." },
      { kind: "email", days: 4, thread: true, body: "Hola {{nombre}},\n\n¿Habéis podido verlo? Si hay alguna duda o falta algo para decidir, dímelo.\n\n{{remitente_nombre}}" },
    ],
  },
  {
    key: "reactivar",
    name: "Reactivar leads fríos",
    description: "Para contactos que no respondieron hace meses: novedad, caso de éxito y despedida.",
    steps: [
      { kind: "email", days: 0, subject: "Novedades para {{empresa}}", body: "Hola {{nombre}},\n\nHace tiempo que hablamos. Desde entonces hemos [novedad relevante para ellos].\n\n¿Te encaja que te lo enseñe en 15 minutos?\n\n{{remitente_nombre}}" },
      { kind: "linkedin_interact", days: 3, body: "Reacciona o comenta algo de valor en una publicación reciente suya o de su empresa." },
      { kind: "email", days: 4, thread: true, body: "Hola {{nombre}},\n\nTe comparto cómo [cliente parecido] consiguió [resultado]. ¿Te cuento cómo lo hicieron?\n\n{{remitente_nombre}}" },
      { kind: "email", days: 7, subject: "Cierro el tema", body: "Hola {{nombre}},\n\nNo te escribo más sobre esto. Si en algún momento te encaja, aquí estoy.\n\nUn saludo,\n{{remitente_nombre}}" },
    ],
  },
];

async function defaultScheduleId() {
  const [s] = await sql<{ id: string }[]>`SELECT id FROM send_schedules WHERE is_default LIMIT 1`;
  return s?.id ?? null;
}

async function insertSequence(actor: Actor, name: string, description: string | null, steps: TStep[], folder?: string | null): Promise<string> {
  const schedule = await defaultScheduleId();
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO sequences (name, description, created_by, owner_id, schedule_id, folder, is_active)
      VALUES (${name.slice(0, 120)}, ${description}, ${actor.id}, ${actor.id}, ${schedule}, ${folder ?? null}, false) RETURNING id`;
    let pos = 0;
    for (const st of steps) {
      pos++;
      const email = isEmailKind(st.kind);
      const subject = email ? (st.thread && pos > 1 ? "" : st.subject ?? "") : (st.subject || STEP_KINDS[st.kind].title || STEP_KINDS[st.kind].label);
      await tx`
        INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, subject, body, task_type, format, thread_reply, priority)
        VALUES (${row.id}, ${pos}, ${Math.max(0, Math.min(90, Math.round(st.days)))}, ${st.kind}, ${subject.slice(0, 300)}, ${st.body},
                ${email ? null : STEP_KINDS[st.kind].activity}, 'text', ${email && Boolean(st.thread) && pos > 1}, ${st.priority ?? "medium"})`;
    }
    return row.id;
  }) as Promise<string>;
}

export async function createBlankSequence(actor: Actor, name: string, folder?: string | null): Promise<string> {
  return insertSequence(actor, name.trim() || "Nueva secuencia", null, [], folder);
}

export async function createFromTemplate(actor: Actor, key: string, name?: string | null, folder?: string | null): Promise<string> {
  const t = SEQUENCE_TEMPLATES.find((x) => x.key === key);
  if (!t) throw new UserError("Esa plantilla no existe.");
  return insertSequence(actor, name?.trim() || t.name, t.description, t.steps, folder);
}

/** La IA propone la secuencia completa; si no hay IA o no responde bien, se avisa. */
export async function createWithAi(actor: Actor, brief: string, name?: string | null, folder?: string | null): Promise<string> {
  if (brief.trim().length < 15) throw new UserError("Cuéntale a la IA un poco más: a quién te diriges, qué vendes y qué quieres conseguir.");
  const reply = parseJsonReply<{ nombre?: string; pasos?: { tipo?: string; dias?: number; asunto?: string; texto?: string; hilo?: boolean }[] }>(
    await generate("write_sequence", { objetivo: brief.slice(0, 2000) }, { maxTokens: 2500 }));
  const steps: TStep[] = (reply?.pasos ?? [])
    .filter((p) => p && typeof p.texto === "string" && p.texto.trim() && p.tipo && p.tipo in STEP_KINDS)
    .slice(0, 12)
    .map((p) => ({ kind: p.tipo as StepKind, days: Number(p.dias) || 0, subject: p.asunto?.trim() || "", body: p.texto!.trim(), thread: Boolean(p.hilo) }));
  if (steps.length < 2) throw new UserError("La IA no ha devuelto una secuencia válida. Prueba otra vez o empieza con una plantilla.");
  if (isEmailKind(steps[0].kind) && !steps[0].subject) steps[0].subject = "{{empresa}}";
  return insertSequence(actor, name?.trim() || reply?.nombre?.trim() || "Secuencia creada con IA", `Creada con IA: ${brief.slice(0, 200)}`, steps, folder);
}

/** Duplica una secuencia con sus pasos, variantes y reglas (sin contactos). */
export async function duplicateSequence(actor: Actor, id: string): Promise<string> {
  return sql.begin(async (tx) => {
    const [s] = await tx<{ id: string }[]>`
      INSERT INTO sequences (name, description, created_by, owner_id, is_active, stop_on_reply, stop_on_meeting, send_days, send_from, send_to, track,
                             add_signature, unsubscribe_link, schedule_id, folder, daily_limit, pause_on_ooo, finish_on_click, same_account,
                             same_account_days, call_after_opens, cc, bcc)
      SELECT CASE WHEN example IS NOT NULL THEN 'Prospección en frío' ELSE left(name || ' (copia)', 120) END,
             CASE WHEN example IS NOT NULL THEN NULL ELSE description END, ${actor.id}, ${actor.id}, false, stop_on_reply, stop_on_meeting, send_days, send_from, send_to, track,
             add_signature, unsubscribe_link, schedule_id, CASE WHEN example IS NOT NULL THEN NULL ELSE folder END, daily_limit, pause_on_ooo, finish_on_click, same_account,
             same_account_days, call_after_opens, cc, bcc
      FROM sequences WHERE id = ${id} RETURNING id`;
    if (!s) throw new UserError("La secuencia no existe.");
    const steps = await tx<{ id: string }[]>`SELECT id FROM sequence_steps WHERE sequence_id = ${id} ORDER BY position`;
    for (const st of steps) {
      const [n] = await tx<{ id: string }[]>`
        INSERT INTO sequence_steps (sequence_id, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply, priority, is_active)
        SELECT ${s.id}, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply, priority, is_active
        FROM sequence_steps WHERE id = ${st.id} RETURNING id`;
      await tx`INSERT INTO sequence_step_variants (step_id, label, subject, body, is_active)
               SELECT ${n.id}, label, subject, body, is_active FROM sequence_step_variants WHERE step_id = ${st.id}`;
    }
    return s.id;
  }) as Promise<string>;
}

/** Archivar: deja de enviar y sale de la lista principal; los contactos en marcha se terminan. */
export async function archiveSequence(id: string, archived: boolean) {
  if (archived) {
    await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = 'Secuencia archivada', finished_at = now(), next_run_at = NULL
              WHERE sequence_id = ${id} AND status IN ('active', 'paused')`;
  }
  await sql`UPDATE sequences SET archived_at = ${archived ? new Date() : null}, is_active = ${archived ? false : sql`is_active`} WHERE id = ${id}`;
}
