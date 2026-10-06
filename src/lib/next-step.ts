import { sql } from "./db";
import { effectiveAutonomy, getSettings, listPermissions, listRules, type Autonomy, type Rule } from "./automations";
import { hasActiveMailbox, senderFor } from "./mailbox";
import { PROVIDERS } from "./integrations";
import { activityLabel, isSessionType } from "./format";
import type { NextStep, Signals } from "./briefs";

// ===========================================================================
// Explicación del siguiente paso de un deal: cuándo toca, quién lo hará (tú,
// la IA sola o la IA pidiéndote permiso), cómo y por qué. Se calcula con la
// configuración real de las reglas y la autonomía.
// ===========================================================================

export type StepPlan = {
  whenShort: string;          // lo que se ve siempre («Hoy», «jue 8 oct, 10:00», «Pendiente de ti»)
  when: string;               // la explicación del cuándo
  who: "you" | "ai_auto" | "ai_ask";
  whoText: string;
  how: string[];
  why: string;
};

const TZ = () => process.env.TZ || "Europe/Madrid";

/** «Hoy, 16:00», «Mañana, 10:00» o «jue 8 oct, 10:00». */
export function shortDate(d: Date, withTime = true) {
  const tz = TZ();
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const time = new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const today = day(new Date()), tomorrow = day(new Date(Date.now() + 86400000)), yesterday = day(new Date(Date.now() - 86400000));
  const label = day(d) === today ? "Hoy" : day(d) === tomorrow ? "Mañana" : day(d) === yesterday ? "Ayer"
    : new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(d);
  return withTime ? `${label}, ${time}` : label;
}

const daysSince = (d: Date | null) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : 0);

type Ctx = { rules: Rule[]; level: (key: string) => Autonomy; paused: boolean; nextRun: string };

async function context(): Promise<Ctx> {
  const [rules, permissions, mailbox, settings] = await Promise.all([listRules(), listPermissions(), hasActiveMailbox(), getSettings()]);
  const minutes = Number(process.env.AUTOMATIONS_INTERVAL_MINUTES ?? 15);
  const next = settings.last_run_at && minutes > 0 ? new Date(new Date(settings.last_run_at).getTime() + minutes * 60000) : null;
  return {
    rules,
    paused: settings.paused,
    nextRun: next && next > new Date() ? `hacia las ${shortDate(next).split(", ")[1]}` : "en los próximos minutos",
    level(key) {
      const r = rules.find((x) => x.key === key);
      return r ? effectiveAutonomy(r, permissions, { mailbox }) : "off";
    },
  };
}

/** Qué hace la IA con una regla según su autonomía (o qué te toca a ti si está apagada). */
function byRule(ctx: Ctx, key: string, doing: string, yourself: string): Pick<StepPlan, "who" | "whoText" | "whenShort" | "when"> & { how: string } {
  const level = ctx.level(key);
  const name = ctx.rules.find((r) => r.key === key)?.name ?? key;
  if (level === "off" || ctx.paused) {
    return {
      who: "you", whoText: ctx.paused ? "Tú (la IA está en pausa)" : `Tú (la regla «${name}» está desactivada)`,
      whenShort: "Esta semana", when: "Cuando puedas, mejor en los próximos días.", how: yourself,
    };
  }
  if (level === "auto") {
    return {
      who: "ai_auto", whoText: "La IA, sola", whenShort: "Hoy · IA",
      when: `En la próxima revisión de la IA (${ctx.nextRun}).`, how: `${doing} Quedará en el registro, desde donde se puede deshacer.`,
    };
  }
  return {
    who: "ai_ask", whoText: "La IA, con tu visto bueno", whenShort: "Hoy · IA propone",
    when: `La IA lo propondrá en la próxima revisión (${ctx.nextRun}) y se hará cuando lo apruebes en la bandeja.`,
    how: `${doing} Te lo dejará en la bandeja para que lo revises (puedes editarlo) antes de que salga.`,
  };
}

export async function planNextStep(dealId: string, s: Signals, step: NextStep, contact: { name: string | null; email: string | null }): Promise<StepPlan> {
  const ctx = await context();
  const sender = await senderFor(s.owner_id);
  const mail = sender ? PROVIDERS[sender.provider].mail : null;
  const who = contact.name ?? "tu contacto";

  switch (step.kind) {
    case "unanswered":
      return {
        who: "you", whoText: "Tú", whenShort: "Hoy",
        when: `Cuanto antes: te escribió ${daysSince(step.at) === 0 ? "hoy" : `hace ${daysSince(step.at)} días`}.`,
        how: [mail ? `Respóndele desde la pestaña «Correo» de este deal: sale desde tu ${mail} y queda en la historia.`
                   : "Respóndele desde tu correo. Si conectas tu cuenta en Ajustes, podrás hacerlo desde aquí y quedará registrado."],
        why: step.why,
      };

    case "unmarked": {
      const how = ["En «Enfoque», pulsa «Marcar como hecha» y elige el resultado (puedes pegar tus notas o la transcripción)."];
      if (ctx.level("meeting_recap") !== "off") how.push(`Si fue «Realizada», la IA ${ctx.level("meeting_recap") === "auto" ? "enviará sola" : "te preparará"} el correo de resumen para ${who} con los próximos pasos y tus huecos.`);
      if (ctx.level("advance_after_session") !== "off" && s.unmarked_type === s.required_activity_type) how.push("Como es la sesión que pide la fase, también propondrá pasar el deal a la siguiente.");
      if (ctx.level("no_show_rebook") !== "off") how.push(`Si ${who} no se presentó, la IA preparará el correo para reagendar.`);
      return { who: "you", whoText: "Tú", whenShort: "Hoy", when: `Ya pasó (${step.at ? shortDate(new Date(step.at)) : "—"}): márcala hoy.`, how, why: step.why };
    }

    case "overdue":
      return {
        who: "you", whoText: "Tú", whenShort: `Vencida · ${step.at ? shortDate(new Date(step.at), false) : ""}`,
        when: `Era para ${step.at ? shortDate(new Date(step.at)).toLowerCase() : "antes"}: hazla hoy o cámbiale la fecha.`,
        how: ["Complétala en «Enfoque» (o cambia su fecha si ya no aplica)."], why: step.why,
      };

    case "pending_ai": {
      const pending = await sql<{ title: string; action_type: string; mode: string }[]>`
        SELECT title, action_type, mode FROM automation_actions WHERE deal_id = ${dealId} AND status = 'pending' ORDER BY created_at LIMIT 5`;
      return {
        who: "ai_ask", whoText: "La IA, cuando lo apruebes", whenShort: "Pendiente de ti",
        when: "En cuanto lo apruebes (aquí abajo, en «Propuestas de la IA», o en la bandeja).",
        how: pending.map((p) => p.title), why: step.why,
      };
    }

    case "missing_session": {
      const session = activityLabel(s.required_activity_type).toLowerCase();
      const offer = Boolean(sender && contact.email) && ctx.level("offer_session_slots") !== "off";
      const plan = offer
        ? byRule(ctx, "offer_session_slots", `Escribirá a ${who} desde tu ${mail} con tus próximos huecos libres para la ${session}.`,
                 `Programa la ${session} en la pestaña «Actividad» (puedes invitar desde tu calendario) o escribe a ${who} con «Insertar mis huecos».`)
        : byRule(ctx, "missing_stage_session", `Creará una tarea «Agendar ${session}» para hoy, asignada a ${s.owner_name ?? "el responsable"}.`,
                 `Programa la ${session} en la pestaña «Actividad».`);
      const how = [plan.how];
      if (offer) how.push(`Cuando ${who} elija hueco, crea la ${session} con «Invitar desde mi calendario»: así cuenta como la sesión de la fase.`);
      return { ...plan, how, why: step.why };
    }

    case "rotten": {
      const factor = Number((ctx.rules.find((r) => r.key === "stale_deal_escalate")?.params.factor as number) ?? 2);
      if (s.rotten_after_days !== null && s.days_in_stage >= s.rotten_after_days * factor && ctx.level("stale_deal_escalate") !== "off") {
        return {
          who: "ai_ask", whoText: "Tú decides; la IA te lo pide", whenShort: "Hoy · decide",
          when: `La IA te pedirá una decisión en la próxima revisión (${ctx.nextRun}).`,
          how: ["Elige: insistir (programa una llamada o un correo), cambiar de enfoque (otro contacto) o darlo por perdido con su motivo."],
          why: step.why,
        };
      }
      const plan = contact.email
        ? byRule(ctx, "stale_deal_followup", `Escribirá a ${who} para retomar la conversación (con la plantilla de la regla).`,
                 `Escribe a ${who} desde la pestaña «Correo» o programa una llamada.`)
        : { who: "you" as const, whoText: "Tú", whenShort: "Esta semana", when: "En los próximos días.", how: "Busca el email del contacto o programa una llamada." };
      return { ...plan, how: [plan.how], why: step.why };
    }

    case "nothing":
      return {
        who: "you", whoText: "Tú", whenShort: "Esta semana", when: "En los próximos días, antes de que el deal se quede parado.",
        how: ["Programa la siguiente actividad en la pestaña «Actividad»."], why: step.why,
      };

    case "prepare": {
      const how = ["Repasa el resumen, la historia y los documentos del deal antes de la sesión."];
      if (isSessionType(s.next_type) && ctx.level("meeting_recap") !== "off") how.push(`Al marcarla como hecha, la IA preparará el resumen para ${who}.`);
      return {
        who: "you", whoText: "Tú", whenShort: step.at ? shortDate(new Date(step.at)) : "Próximamente",
        when: step.at ? `${activityLabel(s.next_type)} el ${shortDate(new Date(step.at)).toLowerCase()}.` : "Próximamente.",
        how, why: step.why,
      };
    }
  }
}
