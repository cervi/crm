"use client";

import type { ComponentProps } from "react";

/** Desplegable que guarda al cambiar (sin botón aparte). */
export function AutoSubmitSelect(props: ComponentProps<"select">) {
  return <select {...props} onChange={(e) => { props.onChange?.(e); e.currentTarget.form?.requestSubmit(); }} />;
}
