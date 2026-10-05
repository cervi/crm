import { sql } from "./db";

export type Pipeline = { id: string; name: string };

export type BoardDeal = {
  id: string;
  title: string;
  organization_name: string | null;
  value: string | null;
  currency: string;
  days_in_stage: number;
  is_rotten: boolean;
  has_upcoming_session: boolean;
};

export type BoardStage = {
  id: string;
  name: string;
  position: number;
  total_value: string;
  deals: BoardDeal[];
};

export async function listPipelines(): Promise<Pipeline[]> {
  return sql<Pipeline[]>`
    SELECT id, name FROM pipelines WHERE is_active ORDER BY position, name`;
}

// Tablero de un pipeline: fases en orden, cada una con sus deals abiertos.
export async function getBoard(pipelineId: string): Promise<BoardStage[]> {
  return sql<BoardStage[]>`
    SELECT s.id, s.name, s.position,
           coalesce(sum(o.value), 0)::text AS total_value,
           coalesce(
             json_agg(json_build_object(
               'id', o.id, 'title', o.title, 'organization_name', org.name,
               'value', o.value::text, 'currency', o.currency,
               'days_in_stage', o.days_in_stage, 'is_rotten', o.is_rotten,
               'has_upcoming_session', o.has_upcoming_session
             ) ORDER BY o.days_in_stage DESC) FILTER (WHERE o.id IS NOT NULL),
             '[]'
           ) AS deals
    FROM stages s
    LEFT JOIN open_deals_status o ON o.stage_id = s.id
    LEFT JOIN organizations org ON org.id = o.organization_id
    WHERE s.pipeline_id = ${pipelineId} AND s.is_active
    GROUP BY s.id
    ORDER BY s.position`;
}
