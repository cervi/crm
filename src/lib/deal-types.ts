// Tipo y origen de un deal (sin dependencias: lo usan servidor y cliente).

export const DEAL_TYPE_LABEL = {
  new: "Nuevo negocio", upsell: "Upsell", cross_sell: "Cross-sell", renewal: "Renovación", onboarding: "Onboarding",
} as const;
export const ORIGIN_LABEL = { sales: "Ventas", cs: "Customer Success" } as const;
