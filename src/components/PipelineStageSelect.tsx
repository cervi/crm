"use client";

import { useState } from "react";

type Props = {
  pipelines: { id: string; name: string }[];
  stages: { id: string; pipeline_id: string; name: string }[];
  pipelineId?: string | null;
  stageId?: string | null;
};

/** Pipeline y fase: la lista de fases depende del pipeline elegido. */
export function PipelineStageSelect({ pipelines, stages, pipelineId, stageId }: Props) {
  const [pipeline, setPipeline] = useState(pipelineId ?? pipelines[0]?.id ?? "");
  const options = stages.filter((s) => s.pipeline_id === pipeline);
  const [stage, setStage] = useState(
    stageId && options.some((s) => s.id === stageId) ? stageId : options[0]?.id ?? "",
  );

  return (
    <>
      <label className="field"><span className="label">Pipeline *</span>
        <select name="pipeline_id" value={pipeline} required onChange={(e) => {
          setPipeline(e.target.value);
          setStage(stages.find((s) => s.pipeline_id === e.target.value)?.id ?? "");
        }}>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="field"><span className="label">Fase *</span>
        <select name="stage_id" value={stage} required onChange={(e) => setStage(e.target.value)}>
          {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
    </>
  );
}
