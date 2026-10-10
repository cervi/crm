import { json, sql } from "./db";
import { NAV_ITEMS, type NavPrefs } from "./nav-items";

export async function getNavPrefs(userId: string): Promise<NavPrefs> {
  const [u] = await sql<{ nav_prefs: NavPrefs | null }[]>`SELECT nav_prefs FROM users WHERE id = ${userId}`.catch(() => []);
  return u?.nav_prefs ?? {};
}

export async function saveNavPrefs(userId: string, prefs: NavPrefs | null) {
  const valid = new Set(NAV_ITEMS.filter((i) => !i.fixed).map((i) => i.href));
  const clean = prefs
    ? { order: (prefs.order ?? []).filter((h) => valid.has(h)), hidden: (prefs.hidden ?? []).filter((h) => valid.has(h)) }
    : {};
  await sql`UPDATE users SET nav_prefs = ${json(clean)} WHERE id = ${userId}`;
}
