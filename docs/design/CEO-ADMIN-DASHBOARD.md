# JANSEE V4 CEO Admin Dashboard

## Dashboard data definitions

- **Today / cumulative business metrics**: daily revenue, daily completed jobs, total jobs, failed jobs, and job success rate come from PostgreSQL records. Revenue is paid orders only.
- **End-to-end latency**: queue timestamp to successful completion timestamp. Average, P50, P90 and P99 are calculated from completed jobs; percentiles expose slow-tail behavior.
- **Stage latency**: LLM planning, TTS synthesis, renderer-stage total and separately reported FFmpeg rendering durations are stored in the job's `director_plan._telemetry`. FFmpeg duration is left unavailable when an engine does not report an independent FFmpeg measurement; renderer-stage total is shown separately and may include internal substeps. Zero or unreported stages are excluded from stage averages.
- **Model route**:
  - `primary`: the configured primary model returned a schema-valid director plan.
  - `fallback`: a configured secondary model returned a schema-valid plan after earlier model attempts failed.
  - `heuristic`: the configured model chain did not return a valid plan, so the deterministic director fallback took over.
  - These are routing outcomes, not semantic accuracy scores.
- **Token usage**: only reported when the upstream provider returns token usage. A missing usage object is displayed as unavailable, not zero.
- **TTS characters**: Unicode character count of the director narration submitted for voice generation. This is a workload indicator, not a billing statement.
- **Auto-QC**: pass rate uses jobs for which an actual quality-check result was recorded. Jobs without a configured quality checker are excluded.
- **Director model cost**: calculated only when the provider returns both prompt and completion token counts and `DIRECTOR_MODEL_PRICING_JSON` contains the matching model price in CNY per million tokens. TTS, storage, bandwidth and infrastructure costs are not included; do not infer gross margin from this figure.
- **Strategy / anchor record rates**: indicate whether the plan contains the respective configuration fields. They do not indicate recommendation accuracy or user satisfaction.

## Deliberately unavailable metrics

- **Cache hit rate**: no production cache-hit event source is currently wired to the V4 job pipeline. Do not display a fabricated percentage.
- **Scene fit score / semantic accuracy**: no independently evaluated score is currently persisted. Keep the metric unavailable until a real evaluator and feedback loop are implemented.
- **Full unit economics / gross margin**: requires actual TTS provider billing, storage, bandwidth and infrastructure cost records in addition to director-model token costs.

## Optional model pricing configuration

Set `DIRECTOR_MODEL_PRICING_JSON` in the private server environment. Example shape (replace the zero placeholders with the current contract price for each exact provider model ID):

```json
{
  "zai-org/GLM-5.3-Flash": {
    "inputPerMillionYuan": 0,
    "outputPerMillionYuan": 0
  }
}
```

Do not commit real secrets or assume pricing for unlisted fallback models.
