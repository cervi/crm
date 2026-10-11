import type { IconName } from "@/components/Icon";

/** Tipos de paso de una secuencia (como en Apollo): correos automáticos o manuales, llamadas, LinkedIn y tareas. */
export const STEP_KINDS = {
  email: { label: "Correo automático", short: "Correo", icon: "mail", channel: "email", activity: "email", title: "" },
  manual_email: { label: "Correo manual", short: "Correo manual", icon: "pencil", channel: "email", activity: "email", title: "" },
  call: { label: "Llamada", short: "Llamada", icon: "phone", channel: "call", activity: "call", title: "Llamar a {{nombre_completo}}" },
  linkedin_connect: { label: "LinkedIn: solicitud de conexión", short: "LinkedIn · conectar", icon: "users", channel: "linkedin", activity: "linkedin", title: "Enviar solicitud de conexión a {{nombre_completo}}" },
  linkedin_message: { label: "LinkedIn: mensaje", short: "LinkedIn · mensaje", icon: "send", channel: "linkedin", activity: "linkedin", title: "Escribir por LinkedIn a {{nombre_completo}}" },
  linkedin_view: { label: "LinkedIn: ver su perfil", short: "LinkedIn · ver perfil", icon: "user", channel: "linkedin", activity: "linkedin", title: "Ver el perfil de LinkedIn de {{nombre_completo}}" },
  linkedin_interact: { label: "LinkedIn: interactuar con una publicación", short: "LinkedIn · interactuar", icon: "spark", channel: "linkedin", activity: "linkedin", title: "Comentar o reaccionar a una publicación de {{nombre_completo}}" },
  action_item: { label: "Tarea", short: "Tarea", icon: "check", channel: "task", activity: "task", title: "" },
  task: { label: "Tarea (otro tipo)", short: "Tarea", icon: "check", channel: "task", activity: "task", title: "" },
} as const satisfies Record<string, { label: string; short: string; icon: IconName; channel: string; activity: string; title: string }>;

export type StepKind = keyof typeof STEP_KINDS;
export const isEmailKind = (k: string) => k === "email" || k === "manual_email";
/** Pasos que crean una tarea y esperan a que se haga (o se salte). */
export const isTaskKind = (k: string) => !isEmailKind(k);
export const stepLabel = (k: string) => (STEP_KINDS as Record<string, { label: string }>)[k]?.label ?? k;
export const stepIcon = (k: string): IconName => (STEP_KINDS as Record<string, { icon: IconName }>)[k]?.icon ?? "check";

export const PRIORITIES = { high: "Alta", medium: "Media", low: "Baja" } as const;
export type Priority = keyof typeof PRIORITIES;
