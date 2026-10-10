import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { drillDown, SEGMENTS, type DrillMetric, type Grain, type Segment } from "@/lib/sales-analytics";
import { isId } from "@/lib/validation";
import { activityLabel } from "@/lib/format";
import { activityTypes } from "@/lib/activity-types";

export const dynamic = "force-dynamic";

const METRICS: DrillMetric[] = ["won", "created", "lost", "closed", "activities"];
const GRAINS: Grain[] = ["day", "week", "month", "quarter"];

/** Qué deals (o actividades) hay detrás de una barra o un punto de los informes. */
export async function GET(req: Request) {
  if (!(await currentUser())) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const q = new URL(req.url).searchParams;
  const metric = q.get("m") as DrillMetric, grain = q.get("g") as Grain, seg = (q.get("seg") ?? "none") as Segment;
  if (!METRICS.includes(metric) || !GRAINS.includes(grain) || !(seg in SEGMENTS)) return NextResponse.json({ error: "Petición no válida." }, { status: 400 });
  const rows = await drillDown({
    metric, grain, key: q.get("p") ?? "", segment: seg, segKey: q.get("sk"), type: q.get("type"),
    pipelineId: isId(q.get("pipeline")) ? q.get("pipeline") : null, ownerId: isId(q.get("owner")) ? q.get("owner") : null,
  });
  if (metric === "activities") {
    await activityTypes();
    for (const r of rows) r.detail = r.detail ? activityLabel(r.detail) : null;
  }
  return NextResponse.json({ rows });
}
