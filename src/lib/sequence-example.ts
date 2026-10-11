import { sql } from "./db";
import { UserError } from "./errors";
import type { Actor } from "./events";
import { STEP_KINDS, type StepKind } from "./step-kinds";

// ===========================================================================
// Secuencia de ejemplo: una prospección en frío a medio camino, con diez
// contactos ficticios en todos los estados posibles (respondió, interesado,
// rebotó, fuera de la oficina, llamada pendiente, se dio de baja…), correos
// enviados con aperturas y respuestas, y tareas en la cola.
//
// Nunca envía nada: las direcciones son del dominio reservado .example, la
// secuencia queda en pausa y el motor salta las secuencias de ejemplo.
// Se borra entera (contactos y empresas incluidos) con removeExample.
// ===========================================================================

type Step = { kind: StepKind; days: number; subject?: string; body: string; thread?: boolean; priority?: "high" | "medium" | "low" };

const STEPS: Step[] = [
  { kind: "email", days: 0, subject: "{{empresa}}: menos horas en tareas manuales",
    body: "Hola {{nombre}},\n\nHe visto que en {{empresa}} estáis creciendo el equipo comercial. Ayudamos a equipos como el vuestro a quitarse de encima el trabajo manual del CRM (apuntar llamadas, perseguir seguimientos, actualizar deals) para que vendan más horas a la semana.\n\n¿Es algo que tengáis en el radar este trimestre?\n\nUn saludo,\n{{remitente_nombre}}" },
  { kind: "linkedin_connect", days: 1, body: "Solicitud de conexión con una nota breve, sin vender: «Hola {{nombre}}, te escribí sobre el equipo comercial de {{empresa}}. Encantado de conectar»." },
  { kind: "email", days: 2, thread: true,
    body: "Hola {{nombre}},\n\nPor si se quedó abajo en la bandeja: ¿te encaja que lo veamos 15 minutos esta semana o la que viene?\n\n{{remitente_nombre}}" },
  { kind: "call", days: 2, priority: "high", body: "Objetivo: una reunión de 20 minutos. Si no contesta, deja un mensaje breve mencionando el correo." },
  { kind: "email", days: 3, thread: true,
    body: "Hola {{nombre}},\n\nUn caso parecido al vuestro: un equipo de 12 comerciales recuperó unas 6 horas por persona a la semana en el primer mes.\n\n¿Te cuento cómo lo hicieron?\n\n{{remitente_nombre}}" },
  { kind: "linkedin_message", days: 2, body: "Mensaje corto por LinkedIn retomando la conversación, con una pregunta abierta sobre cómo trabajan hoy los seguimientos." },
  { kind: "email", days: 4, subject: "¿Lo dejo aquí?",
    body: "Hola {{nombre}},\n\nNo quiero insistir más de la cuenta. Si ahora no es el momento, dímelo y te escribo más adelante.\n\nUn saludo,\n{{remitente_nombre}}" },
];

type Opened = number; // veces que lo abrió (0 = no lo abrió)
type Event =
  | { at: number; email: number; opens?: Opened; bounced?: boolean }        // correo del paso `email` (índice), enviado hace `at` días
  | { at: number; task: number; done: boolean; outcome?: "no_answer" | "answered" | "voicemail" }  // tarea del paso `task`
  | { at: number; reply: string; cls: "interesado" | "mas_adelante" | "ooo" | "baja" };
type Contact = {
  first: string; last: string; title: string; org: string; domain: string; industry: string; city: string;
  enrolledAgo: number; events: Event[];
  end: { status: "active"; next: number; at?: number; waitingTask?: boolean }   // `at`: días desde hoy (puede ser negativo)
     | { status: "paused"; next: number; reason: string; resumeIn: number }
     | { status: "stopped"; reason: string; ago: number }
     | { status: "completed"; ago: number };
};

const CONTACTS: Contact[] = [
  { first: "Laura", last: "Gómez", title: "Directora de Operaciones", org: "Logística Norte", domain: "logisticanorte.example", industry: "Logística", city: "Bilbao",
    enrolledAgo: 13, events: [{ at: 13, email: 0, opens: 4 }, { at: 12, task: 1, done: true }, { at: 11, email: 2, opens: 2 },
      { at: 10, reply: "Hola,\n\nSí, nos interesa: justo estamos revisando cómo trabaja el equipo. ¿Puedes el jueves a las 10?\n\nLaura", cls: "interesado" }],
    end: { status: "stopped", reason: "Respondió", ago: 10 } },
  { first: "Marcos", last: "Ruiz", title: "Director Financiero", org: "Grupo Alameda", domain: "grupoalameda.example", industry: "Distribución", city: "Sevilla",
    enrolledAgo: 13, events: [{ at: 13, email: 0, opens: 1 }, { at: 12, task: 1, done: true }, { at: 11, email: 2, opens: 1 },
      { at: 11, reply: "Gracias por escribir. Ahora estamos con el cierre del trimestre; escríbeme en enero y lo vemos.\n\nMarcos", cls: "mas_adelante" }],
    end: { status: "stopped", reason: "Respondió", ago: 11 } },
  { first: "Ana", last: "Torres", title: "Head of Sales", org: "Nubia Software", domain: "nubiasoftware.example", industry: "Software", city: "Madrid",
    enrolledAgo: 12, events: [{ at: 12, email: 0, opens: 3 }, { at: 11, task: 1, done: true }, { at: 9, email: 2, opens: 2 }],
    end: { status: "active", next: 3, waitingTask: true } },
  { first: "Javier", last: "Martín", title: "Gerente", org: "Talleres Ebro", domain: "talleresebro.example", industry: "Industria", city: "Zaragoza",
    enrolledAgo: 12, events: [{ at: 12, email: 0, bounced: true }],
    end: { status: "stopped", reason: "Rebotó", ago: 12 } },
  { first: "Elena", last: "Vidal", title: "Directora de Operaciones", org: "Clínicas Sanare", domain: "clinicassanare.example", industry: "Salud", city: "Valencia",
    enrolledAgo: 10, events: [{ at: 10, email: 0, opens: 1 }, { at: 9, task: 1, done: true }, { at: 8, email: 2 },
      { at: 8, reply: "Estoy fuera de la oficina hasta dentro de unos días, con acceso limitado al correo. Te respondo a la vuelta.\n\nElena Vidal", cls: "ooo" }],
    end: { status: "paused", next: 3, reason: "Fuera de la oficina", resumeIn: 3 } },
  { first: "Pablo", last: "Herrero", title: "Director Comercial", org: "Construcciones Duero", domain: "construccionesduero.example", industry: "Construcción", city: "Valladolid",
    enrolledAgo: 7, events: [{ at: 7, email: 0, opens: 1 }, { at: 6, task: 1, done: true }, { at: 4, email: 2, opens: 1 }, { at: 2, task: 3, done: true, outcome: "no_answer" }],
    end: { status: "active", next: 4, at: 1 } },
  { first: "Sofía", last: "Navarro", title: "CEO", org: "Estudio Brío", domain: "estudiobrio.example", industry: "Marketing", city: "Barcelona",
    enrolledAgo: 2, events: [{ at: 2, email: 0, opens: 2 }],
    end: { status: "active", next: 1, waitingTask: true } },
  { first: "Diego", last: "Castro", title: "Director de Compras", org: "Agroalimentaria Sur", domain: "agrosur.example", industry: "Alimentación", city: "Córdoba",
    enrolledAgo: 14, events: [{ at: 14, email: 0, opens: 1 }, { at: 13, task: 1, done: true }, { at: 11, email: 2 }, { at: 9, task: 3, done: true, outcome: "voicemail" },
      { at: 6, email: 4, opens: 1 }, { at: 4, task: 5, done: true }, { at: 1, email: 6 }],
    end: { status: "completed", ago: 1 } },
  { first: "Carmen", last: "López", title: "Responsable de Marketing", org: "Hotel Mirador", domain: "hotelmirador.example", industry: "Hostelería", city: "Málaga",
    enrolledAgo: 9, events: [{ at: 9, email: 0, opens: 1 }, { at: 9, reply: "Por favor, no me escribáis más. Gracias.", cls: "baja" }],
    end: { status: "stopped", reason: "Se dio de baja", ago: 9 } },
  { first: "Raúl", last: "Sanz", title: "Fundador", org: "Kibo Labs", domain: "kibolabs.example", industry: "Software", city: "Madrid",
    enrolledAgo: 0, events: [],
    end: { status: "active", next: 0, at: 1 } },
];

const DAY = 86_400_000;
/** Hace `days` días (o dentro de, si es negativo), a una hora de oficina. */
function when(days: number, hour = 9, minute = 30): Date {
  const d = new Date(Date.now() - days * DAY);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function fill(text: string, v: { nombre: string; nombre_completo: string; empresa: string; remitente_nombre: string }) {
  return text.replace(/\{\{\s*(nombre_completo|nombre|empresa|remitente_nombre)\s*\}\}/g, (_, k: keyof typeof v) => v[k]);
}

/** El ejemplo, si ya existe (no archivado). */
export async function existingExample(): Promise<string | null> {
  const [s] = await sql<{ id: string }[]>`SELECT id FROM sequences WHERE example IS NOT NULL AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  return s?.id ?? null;
}

export async function isExample(sequenceId: string): Promise<boolean> {
  const [s] = await sql<{ ex: boolean }[]>`SELECT example IS NOT NULL AS ex FROM sequences WHERE id = ${sequenceId}`;
  return Boolean(s?.ex);
}

export async function createExample(actor: Actor): Promise<string> {
  const existing = await existingExample();
  if (existing) return existing;
  const [me] = await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${actor.id}`;
  const sender = me?.name?.split(" ")[0] || "Tu nombre";
  const fromEmail = me?.email ?? null;
  const [sched] = await sql<{ id: string }[]>`SELECT id FROM send_schedules WHERE is_default LIMIT 1`;

  return sql.begin(async (tx) => {
    const [seq] = await tx<{ id: string }[]>`
      INSERT INTO sequences (name, description, created_by, owner_id, schedule_id, folder, is_active, created_at, example)
      VALUES ('Ejemplo · Prospección en frío', 'Secuencia de muestra con contactos ficticios para ver cómo funciona. No envía nada.',
              ${actor.id}, ${actor.id}, ${sched?.id ?? null}, 'Ejemplos', false, ${when(15)}, '{}'::jsonb)
      RETURNING id`;
    const stepIds: string[] = [];
    let pos = 0;
    for (const st of STEPS) {
      pos++;
      const email = st.kind === "email";
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, subject, body, task_type, format, thread_reply, priority)
        VALUES (${seq.id}, ${pos}, ${st.days}, ${st.kind}, ${email ? (st.thread ? "" : st.subject ?? "") : STEP_KINDS[st.kind].title},
                ${st.body}, ${email ? null : STEP_KINDS[st.kind].activity}, 'text', ${Boolean(st.thread)}, ${st.priority ?? "medium"})
        RETURNING id`;
      stepIds.push(row.id);
    }

    const persons: string[] = [], orgs: string[] = [];
    for (const c of CONTACTS) {
      const [o] = await tx<{ id: string }[]>`
        INSERT INTO organizations (name, domain, industry, country, city, owner_id)
        VALUES (${`${c.org} (ejemplo)`}, ${c.domain}, ${c.industry}, 'España', ${c.city}, ${actor.id}) RETURNING id`;
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO persons (first_name, last_name, owner_id, linkedin_url, unsubscribed_at)
        VALUES (${c.first}, ${`${c.last} (ejemplo)`}, ${actor.id}, ${`https://www.linkedin.com/in/${c.first.toLowerCase()}-ejemplo`},
                ${c.end.status === "stopped" && c.end.reason === "Se dio de baja" ? when(c.end.ago, 11) : null})
        RETURNING id`;
      orgs.push(o.id); persons.push(p.id);
      const address = `${c.first.normalize("NFD").replace(/[^a-zA-Z]/g, "").toLowerCase()}@${c.domain}`;
      const bounced = c.events.some((e) => "bounced" in e && e.bounced);
      await tx`INSERT INTO person_emails (person_id, email, is_primary, bounced_at) VALUES (${p.id}, ${address}, true, ${bounced ? when(c.enrolledAgo, 9, 35) : null})`;
      await tx`INSERT INTO person_organizations (person_id, organization_id, job_title) VALUES (${p.id}, ${o.id}, ${c.title})`;

      const e = c.end;
      const [en] = await tx<{ id: string }[]>`
        INSERT INTO sequence_enrollments (sequence_id, person_id, user_id, status, next_step, next_run_at, stopped_reason, enrolled_by, created_at, finished_at,
                                          paused_reason, resume_at, timezone)
        VALUES (${seq.id}, ${p.id}, ${actor.id}, ${e.status},
                ${e.status === "active" || e.status === "paused" ? e.next : e.status === "completed" ? STEPS.length : 0},
                ${e.status === "active" && !e.waitingTask ? when(-(e.at ?? 1), 9, 15) : null},
                ${e.status === "stopped" ? e.reason : null}, ${actor.id}, ${when(c.enrolledAgo, 9, 0)},
                ${e.status === "stopped" || e.status === "completed" ? when(e.ago, 12) : null},
                ${e.status === "paused" ? e.reason : null}, ${e.status === "paused" ? when(-e.resumeIn, 8) : null}, 'Europe/Madrid')
        RETURNING id`;

      const vars = { nombre: c.first, nombre_completo: `${c.first} ${c.last}`, empresa: c.org, remitente_nombre: sender };
      const firstSubject = fill(STEPS[0].subject ?? "", vars);
      let lastOut: string | null = null;
      for (const ev of c.events) {
        if ("email" in ev) {
          const st = STEPS[ev.email];
          const sent = when(ev.at, 9, 30 + ev.email);
          const opens = ev.opens ?? 0;
          const outRows: { id: string }[] = await tx<{ id: string }[]>`
            INSERT INTO emails (direction, status, person_id, organization_id, user_id, from_email, to_email, to_name, subject, body, sent_at, track,
                                open_count, first_opened_at, last_opened_at, open_alert_at, created_by, created_at, enrollment_id, sequence_step_id, bounced, reply_to_email)
            VALUES ('out', 'sent', ${p.id}, ${o.id}, ${actor.id}, ${fromEmail}, ${address}, ${vars.nombre_completo},
                    ${st.thread ? `Re: ${firstSubject}` : fill(st.subject ?? "", vars)}, ${fill(st.body, vars)}, ${sent}, true,
                    ${opens}, ${opens ? new Date(sent.getTime() + 3_600_000) : null}, ${opens ? new Date(sent.getTime() + opens * 5_400_000) : null},
                    ${opens ? sent : null}, ${actor.id}, ${sent}, ${en.id}, ${stepIds[ev.email]}, ${Boolean(ev.bounced)}, ${st.thread ? lastOut : null})
            RETURNING id`;
          lastOut = outRows[0].id;
        } else if ("task" in ev) {
          const st = STEPS[ev.task];
          const at = when(ev.at, 10, 0);
          await tx`
            INSERT INTO activities (type, subject, note, due_at, done, done_at, person_id, organization_id, owner_id, created_by_id, enrollment_id, step_kind, priority, call_outcome, created_at)
            VALUES (${STEP_KINDS[st.kind].activity}, ${fill(STEP_KINDS[st.kind].title, vars)}, ${fill(st.body, vars)}, ${at}, ${ev.done}, ${ev.done ? new Date(at.getTime() + 1_800_000) : null},
                    ${p.id}, ${o.id}, ${actor.id}, ${actor.id}, ${en.id}, ${st.kind}, ${st.priority ?? "medium"}, ${ev.outcome ?? null}, ${at})`;
        } else {
          const at = when(ev.at, 16, 10);
          await tx`
            INSERT INTO emails (direction, status, person_id, organization_id, user_id, from_email, to_email, subject, body, sent_at, created_at, reply_class, reply_to_email)
            VALUES ('in', 'sent', ${p.id}, ${o.id}, ${actor.id}, ${address}, ${fromEmail}, ${`Re: ${firstSubject}`}, ${ev.reply}, ${at}, ${at}, ${ev.cls}, ${lastOut})`;
        }
      }
      // La tarea en la que espera (llamada o LinkedIn): pendiente para hoy, en tu cola de tareas.
      if (e.status === "active" && e.waitingTask) {
        const st = STEPS[e.next];
        const [a] = await tx<{ id: string }[]>`
          INSERT INTO activities (type, subject, note, due_at, done, person_id, organization_id, owner_id, created_by_id, enrollment_id, step_kind, priority)
          VALUES (${STEP_KINDS[st.kind].activity}, ${fill(STEP_KINDS[st.kind].title, vars)}, ${fill(st.body, vars)}, ${when(0, 10, 0)}, false,
                  ${p.id}, ${o.id}, ${actor.id}, ${actor.id}, ${en.id}, ${st.kind}, ${st.priority ?? "medium"})
          RETURNING id`;
        await tx`UPDATE sequence_enrollments SET waiting_activity_id = ${a.id} WHERE id = ${en.id}`;
      }
    }
    await tx`UPDATE sequences SET example = ${tx.json({ persons, orgs })} WHERE id = ${seq.id}`;
    return seq.id;
  }) as Promise<string>;
}

/** Borra el ejemplo entero: secuencia, contactos, empresas, correos y tareas de muestra. */
export async function removeExample(sequenceId: string) {
  const [s] = await sql<{ example: { persons?: string[]; orgs?: string[] } | null }[]>`SELECT example FROM sequences WHERE id = ${sequenceId}`;
  if (!s) throw new UserError("La secuencia no existe.");
  if (!s.example) throw new UserError("Esta secuencia no es un ejemplo: bórrala desde sus ajustes.");
  const persons = (s.example.persons ?? []).filter(Boolean), orgs = (s.example.orgs ?? []).filter(Boolean);
  await sql.begin(async (tx) => {
    const enr = (await tx<{ id: string }[]>`SELECT id FROM sequence_enrollments WHERE sequence_id = ${sequenceId}`).map((r) => r.id);
    await tx`UPDATE sequence_enrollments SET waiting_activity_id = NULL WHERE sequence_id = ${sequenceId}`;
    await tx`DELETE FROM activities WHERE enrollment_id = ANY(${enr}::uuid[]) OR person_id = ANY(${persons}::uuid[])`;
    await tx`DELETE FROM emails WHERE enrollment_id = ANY(${enr}::uuid[]) OR person_id = ANY(${persons}::uuid[])`;
    await tx`DELETE FROM sequences WHERE id = ${sequenceId}`;
    if (persons.length) await tx`DELETE FROM persons WHERE id = ANY(${persons}::uuid[])`;
    if (orgs.length) await tx`DELETE FROM organizations WHERE id = ANY(${orgs}::uuid[])`;
  });
}
