import type { Pool } from "pg";
import type { AdminOverviewStats, DirectorJobInsight } from "../admin.js";

function numeric(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function maskAdminContact(phone: unknown, email: unknown): string {
  const cleanPhone = String(phone ?? "").trim();
  if (cleanPhone) return cleanPhone.length >= 7 ? `${cleanPhone.slice(0, 3)}****${cleanPhone.slice(-4)}` : cleanPhone;
  const cleanEmail = String(email ?? "").trim();
  if (!cleanEmail.includes("@")) return "";
  const [local, domain] = cleanEmail.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? ""}`;
}

export async function fetchAdminOverviewStats(pool: Pool, emptyStats: AdminOverviewStats): Promise<AdminOverviewStats> {
  const result = await pool.query<{
    total_users: string | number;
    today_new_users: string | number;
    today_revenue_yuan: string | number;
    today_completed_jobs: string | number;
    today_failed_jobs: string | number;
    terminal_jobs: string | number;
    completed_jobs: string | number;
    total_jobs: string | number;
    failed_jobs: string | number;
    avg_e2e_ms: string | number | null;
    p50_e2e_ms: string | number | null;
    p90_e2e_ms: string | number | null;
    p99_e2e_ms: string | number | null;
    avg_llm_ms: string | number | null;
    avg_tts_ms: string | number | null;
    avg_ffmpeg_ms: string | number | null;
    avg_renderer_ms: string | number | null;
    avg_scene_score: string | number | null;
    scene_score_records: string | number;
    today_cost_estimate_yuan: string | number;
    today_cost_records: string | number;
    variant_hit_rate: string | number | null;
    director_calls: string | number;
    primary_model_successes: string | number;
    fallback_model_successes: string | number;
    heuristic_fallbacks: string | number;
    total_tokens_used: string | number;
    token_usage_records: string | number;
    total_tts_chars: string | number;
    quality_checked_jobs: string | number;
    quality_passed_jobs: string | number;
  }>(`
    SELECT
      (SELECT count(*) FROM users WHERE deleted_at IS NULL)::int AS total_users,
      (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_new_users,
      coalesce((SELECT sum(provider_price_yuan) FROM billing_orders
        WHERE payment_provider = 'opcpay' AND provider_payment_status IN ('PAID', 'REFUNDED')
          AND provider_paid_checked_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0)
      - coalesce((SELECT sum(amount_yuan) FROM billing_order_refund_records
        WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0) AS today_revenue_yuan,
      count(*) FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_completed_jobs,
      count(*) FILTER (WHERE status = 'failed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_failed_jobs,
      count(*) FILTER (WHERE status IN ('completed', 'failed'))::int AS terminal_jobs,
      count(*)::int AS total_jobs,
      count(*) FILTER (WHERE status = 'failed')::int AS failed_jobs,
      count(*) FILTER (WHERE status = 'completed')::int AS completed_jobs,
      avg(extract(epoch FROM (finished_at - COALESCE(started_at, queued_at))) * 1000) FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS avg_e2e_ms,
      percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - COALESCE(started_at, queued_at))) * 1000)
        FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p50_e2e_ms,
      percentile_cont(0.90) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - COALESCE(started_at, queued_at))) * 1000)
        FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p90_e2e_ms,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (finished_at - COALESCE(started_at, queued_at))) * 1000)
        FILTER (WHERE status = 'completed' AND finished_at IS NOT NULL) AS p99_e2e_ms,
      avg(CASE WHEN director_plan->'_telemetry'->>'llmDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
        THEN NULLIF((director_plan->'_telemetry'->>'llmDurationMs')::numeric, 0) END)
        FILTER (WHERE status = 'completed') AS avg_llm_ms,
      avg(CASE WHEN director_plan->'_telemetry'->>'ttsDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
        THEN NULLIF((director_plan->'_telemetry'->>'ttsDurationMs')::numeric, 0) END)
        FILTER (WHERE status = 'completed') AS avg_tts_ms,
      avg(CASE WHEN director_plan->'_telemetry'->>'ffmpegDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
        THEN NULLIF((director_plan->'_telemetry'->>'ffmpegDurationMs')::numeric, 0) END)
        FILTER (WHERE status = 'completed') AS avg_ffmpeg_ms,
      avg(CASE WHEN director_plan->'_telemetry'->>'rendererDurationMs' ~ '^[0-9]+([.][0-9]+)?$'
        THEN NULLIF((director_plan->'_telemetry'->>'rendererDurationMs')::numeric, 0) END)
        FILTER (WHERE status = 'completed') AS avg_renderer_ms,
      avg(CASE WHEN director_plan->>'scene_score' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (director_plan->>'scene_score')::numeric END) FILTER (WHERE status = 'completed') AS avg_scene_score,
      count(*) FILTER (WHERE status = 'completed' AND director_plan->>'scene_score' ~ '^[0-9]+([.][0-9]+)?$')::int AS scene_score_records,
      coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'costEstimateYuan' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (director_plan->'_telemetry'->>'costEstimateYuan')::numeric ELSE 0 END)
        FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')), 0) AS today_cost_estimate_yuan,
      count(*) FILTER (WHERE status = 'completed' AND finished_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
        AND director_plan->'_telemetry'->>'costSource' = 'director_model_pricing')::int AS today_cost_records,
      (count(*) FILTER (WHERE director_plan ? 'variant_type')::numeric / NULLIF(count(*), 0) * 100) AS variant_hit_rate,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' IN ('primary','fallback','heuristic'))::int AS director_calls,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'primary')::int AS primary_model_successes,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'fallback')::int AS fallback_model_successes,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'providerMode' = 'heuristic')::int AS heuristic_fallbacks,
      coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'tokensUsed' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (director_plan->'_telemetry'->>'tokensUsed')::numeric ELSE 0 END), 0) AS total_tokens_used,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'tokenUsageAvailable' = 'true')::int AS token_usage_records,
      coalesce(sum(CASE WHEN director_plan->'_telemetry'->>'ttsChars' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (director_plan->'_telemetry'->>'ttsChars')::numeric ELSE 0 END), 0) AS total_tts_chars,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'qualityCheckCount' ~ '^[1-9][0-9]*$')::int AS quality_checked_jobs,
      count(*) FILTER (WHERE director_plan->'_telemetry'->>'qualityPassed' = 'true')::int AS quality_passed_jobs
    FROM generation_jobs
  `);

  const row = result.rows[0];
  if (!row) return emptyStats;
  const terminal = numeric(row.terminal_jobs);

  return {
    ...emptyStats,
    databaseDataAvailable: true,
    totalUsers: numeric(row.total_users),
    todayNewUsers: numeric(row.today_new_users),
    todayRevenueYuan: numeric(row.today_revenue_yuan),
    revenueDataAvailable: true,
    todayCompletedJobs: numeric(row.today_completed_jobs),
    todayFailedJobs: numeric(row.today_failed_jobs),
    totalJobs: numeric(row.total_jobs),
    failedJobs: numeric(row.failed_jobs),
    directorCalls: numeric(row.director_calls),
    directorTelemetryAvailable: numeric(row.director_calls) > 0,
    primaryModelSuccessRate: numeric(row.director_calls) > 0 ? Number((numeric(row.primary_model_successes) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
    fallbackModelRate: numeric(row.director_calls) > 0 ? Number((numeric(row.fallback_model_successes) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
    heuristicFallbackRate: numeric(row.director_calls) > 0 ? Number((numeric(row.heuristic_fallbacks) / numeric(row.director_calls) * 100).toFixed(1)) : 0,
    totalTokensUsed: numeric(row.total_tokens_used),
    tokenUsageRecords: numeric(row.token_usage_records),
    totalTtsChars: numeric(row.total_tts_chars),
    qualityCheckedJobs: numeric(row.quality_checked_jobs),
    qualityPassedJobs: numeric(row.quality_passed_jobs),
    qualityPassRate: numeric(row.quality_checked_jobs) > 0 ? Number((numeric(row.quality_passed_jobs) / numeric(row.quality_checked_jobs) * 100).toFixed(1)) : 0,
    jobSuccessRate: terminal > 0 ? Number((numeric(row.completed_jobs) / terminal * 100).toFixed(1)) : 0,
    avgE2eDurationSec: Number((numeric(row.avg_e2e_ms) / 1000).toFixed(2)),
    p50E2eDurationSec: Number((numeric(row.p50_e2e_ms) / 1000).toFixed(2)),
    p90E2eDurationSec: Number((numeric(row.p90_e2e_ms) / 1000).toFixed(2)),
    p99E2eDurationSec: Number((numeric(row.p99_e2e_ms) / 1000).toFixed(2)),
    avgLlmDurationSec: Number((numeric(row.avg_llm_ms) / 1000).toFixed(2)),
    avgTtsDurationSec: Number((numeric(row.avg_tts_ms) / 1000).toFixed(2)),
    avgFfmpegDurationSec: Number((numeric(row.avg_ffmpeg_ms) / 1000).toFixed(2)),
    avgRendererDurationSec: Number((numeric(row.avg_renderer_ms) / 1000).toFixed(2)),
    avgSceneScore: Number(numeric(row.avg_scene_score).toFixed(1)),
    sceneScoreDataAvailable: numeric(row.scene_score_records) > 0,
    totalCostEstimateYuan: numeric(row.today_cost_estimate_yuan),
    costDataAvailable: numeric(row.today_cost_records) > 0,
    variantHitRate: Number(numeric(row.variant_hit_rate).toFixed(1)),
  };
}

export async function fetchAdminUsersData(pool: Pool, limit: number, offset: number, keyword: string) {
  const [summary, trend, regions, users] = await Promise.all([
    pool.query(`
      SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS total_users,
        count(*) FILTER (WHERE deleted_at IS NULL AND status = 'active')::int AS active_users,
        count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'))::int AS today_new_users,
        count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= now() - interval '7 days')::int AS last_7_days,
        count(*) FILTER (WHERE deleted_at IS NULL AND created_at >= now() - interval '30 days')::int AS last_30_days,
        count(*) FILTER (WHERE deleted_at IS NULL AND (register_province IS NOT NULL OR register_city IS NOT NULL))::int AS geo_users
      FROM users
    `),
    pool.query(`
      SELECT to_char(day, 'MM-DD') AS day,
        (SELECT count(*)::int FROM users u WHERE u.deleted_at IS NULL
          AND u.created_at >= (day AT TIME ZONE 'Asia/Shanghai')
          AND u.created_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS registrations,
        (SELECT count(*)::int FROM generation_jobs j WHERE j.status = 'completed'
          AND j.finished_at >= (day AT TIME ZONE 'Asia/Shanghai')
          AND j.finished_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS completed_jobs,
        (SELECT coalesce(sum(o.provider_price_yuan), 0) FROM billing_orders o
          WHERE o.payment_provider = 'opcpay' AND o.provider_payment_status IN ('PAID', 'REFUNDED')
            AND o.provider_paid_checked_at >= (day AT TIME ZONE 'Asia/Shanghai')
            AND o.provider_paid_checked_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai'))
        - (SELECT coalesce(sum(r.amount_yuan), 0) FROM billing_order_refund_records r
          WHERE r.created_at >= (day AT TIME ZONE 'Asia/Shanghai')
            AND r.created_at < ((day + interval '1 day') AT TIME ZONE 'Asia/Shanghai')) AS revenue_yuan
      FROM generate_series(
        date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') - interval '29 days',
        date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai'), interval '1 day'
      ) day
      ORDER BY day
    `),
    pool.query(`
      SELECT coalesce(register_province, '地区待识别') AS province,
        sum(city_count)::int AS users,
        json_agg(json_build_object('city', coalesce(register_city, '未知城市'), 'users', city_count) ORDER BY city_count DESC) AS cities
      FROM (
        SELECT register_province, register_city, count(*)::int AS city_count
        FROM users WHERE deleted_at IS NULL AND (register_province IS NOT NULL OR register_city IS NOT NULL)
        GROUP BY register_province, register_city
      ) grouped
      GROUP BY register_province ORDER BY sum(city_count) DESC LIMIT 20
    `),
    pool.query(`
      SELECT u.id, u.display_name, u.email, u.phone, u.status, u.created_at, u.register_province, u.register_city, u.register_region,
        coalesce(w.available_credits, 0) AS credits,
        coalesce(j.completed_jobs, 0) AS completed_jobs,
        coalesce(o.download_total, 0) AS download_total
      FROM users u
        LEFT JOIN wallets w ON w.user_id = u.id
        LEFT JOIN (
          SELECT user_id, count(*)::int AS completed_jobs
          FROM generation_jobs WHERE status = 'completed' GROUP BY user_id
        ) j ON j.user_id = u.id
        LEFT JOIN (
          SELECT user_id, sum(download_count)::int AS download_total
          FROM generated_outputs WHERE deleted_at IS NULL GROUP BY user_id
        ) o ON o.user_id = u.id
      WHERE u.deleted_at IS NULL
        AND (coalesce(u.phone, '') <> '' OR coalesce(u.email, '') <> '')
        AND ($3 = '' OR u.id::text ILIKE '%' || $3 || '%' OR coalesce(u.display_name,'') ILIKE '%' || $3 || '%' OR coalesce(u.email,'') ILIKE '%' || $3 || '%' OR coalesce(u.phone,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_region,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_province,'') ILIKE '%' || $3 || '%' OR coalesce(u.register_city,'') ILIKE '%' || $3 || '%')
      ORDER BY u.created_at DESC LIMIT $1 OFFSET $2
    `, [limit, offset, keyword]),
  ]);

  const totals = summary.rows[0] ?? {};
  const countResult = await pool.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM users WHERE deleted_at IS NULL AND (coalesce(phone, '') <> '' OR coalesce(email, '') <> '') AND ($1 = '' OR id::text ILIKE '%' || $1 || '%' OR coalesce(display_name,'') ILIKE '%' || $1 || '%' OR coalesce(email,'') ILIKE '%' || $1 || '%' OR coalesce(phone,'') ILIKE '%' || $1 || '%' OR coalesce(register_region,'') ILIKE '%' || $1 || '%' OR coalesce(register_province,'') ILIKE '%' || $1 || '%' OR coalesce(register_city,'') ILIKE '%' || $1 || '%')",
    [keyword],
  );

  return {
    summary: {
      totalUsers: numeric(totals.total_users),
      activeUsers: numeric(totals.active_users),
      todayNewUsers: numeric(totals.today_new_users),
      last7Days: numeric(totals.last_7_days),
      last30Days: numeric(totals.last_30_days),
      geoUsers: numeric(totals.geo_users),
      unknownRegionUsers: numeric(totals.total_users) - numeric(totals.geo_users),
    },
    trend: trend.rows.map((row) => ({
      day: row.day,
      registrations: numeric(row.registrations),
      completedJobs: numeric(row.completed_jobs),
      revenueYuan: numeric(row.revenue_yuan),
    })),
    regions: regions.rows.map((row) => ({
      province: row.province,
      users: numeric(row.users),
      cities: row.cities ?? [],
    })),
    users: users.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name ?? "简兮用户",
      contact: maskAdminContact(row.phone, row.email),
      status: row.status,
      createdAt: row.created_at.toISOString(),
      province: row.register_province,
      city: row.register_city,
      region: row.register_region ?? "地区待识别",
      credits: numeric(row.credits),
      completedJobs: numeric(row.completed_jobs),
      downloads: numeric(row.download_total),
    })),
    total: numeric(countResult.rows[0]?.total),
    limit,
    offset,
    regionDataAvailable: numeric(totals.geo_users) > 0,
  };
}

export async function fetchDirectorJobsData(pool: Pool, status: string | null, limit: number, page: number): Promise<{ jobs: DirectorJobInsight[]; total: number }> {
  const result = await pool.query<{
    id: string;
    user_id: string;
    status: DirectorJobInsight["status"];
    aspect_ratio: string;
    created_at: Date;
    updated_at: Date;
    finished_at: Date | null;
    queued_at: Date;
    started_at: Date | null;
    director_plan: Record<string, unknown> | null;
    request_payload: Record<string, unknown> | null;
    credits_charged: string | number;
    error_code: string | null;
    error_message: string | null;
    total: string | number;
  }>(`
    SELECT j.id, j.user_id, j.status, j.aspect_ratio,
           j.created_at, j.updated_at, j.finished_at, j.queued_at, j.started_at, j.director_plan,
           j.request_payload,
           coalesce((SELECT amount FROM billing_ledger l WHERE l.job_id = j.id AND l.type = 'settle' LIMIT 1), 0) AS credits_charged,
           j.error_code, j.error_message, count(*) OVER() AS total
    FROM generation_jobs j
    WHERE j.status <> 'cancelled' AND ($1::text IS NULL OR j.status = $1)
    ORDER BY j.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status, limit, (page - 1) * limit]);

  const jobs: DirectorJobInsight[] = result.rows.map((row) => {
    const plan = row.director_plan ?? {};
    const telemetry = (plan._telemetry as Record<string, unknown> | undefined) ?? {};
    const payload = (row.request_payload as Record<string, unknown> | undefined) ?? {};
    const rawCreationScene = typeof payload.creationScene === "string" ? payload.creationScene : null;
    const rawTelemetryScene = typeof telemetry.scene === "string" ? telemetry.scene : "";
    const effectiveScene = rawCreationScene || rawTelemetryScene || "";
    const effectiveSceneSource = rawCreationScene ? "user-selected" : (typeof telemetry.sceneSource === "string" ? telemetry.sceneSource : "");

    const variantType = typeof plan.variant_type === "string" ? plan.variant_type : "";
    const e2eEndAt = row.finished_at
      ?? (["queued", "inspecting", "planning", "rendering", "quality-check"].includes(row.status) ? new Date() : row.updated_at);
    const e2eStartAt = row.started_at ?? row.queued_at;
    const e2eDurationMs = Math.max(0, e2eEndAt.getTime() - e2eStartAt.getTime());

    return {
      jobId: row.id,
      userId: row.user_id,
      status: row.status,
      aspectRatio: row.aspect_ratio,
      e2eDurationMs,
      llmDurationMs: numeric(telemetry.llmDurationMs),
      ffmpegDurationMs: numeric(telemetry.ffmpegDurationMs),
      rendererDurationMs: numeric(telemetry.rendererDurationMs),
      ttsDurationMs: numeric(telemetry.ttsDurationMs),
      variantDirectorHit: Boolean(variantType),
      variantType: variantType || "未记录",
      variantTemplate: typeof plan.variant_template === "string" ? plan.variant_template : "未记录",
      lockedVariant: typeof telemetry.lockedVariant === "string" ? telemetry.lockedVariant : "",
      variantMatched: typeof telemetry.variantMatched === "boolean" ? telemetry.variantMatched : null,
      voiceId: typeof plan.voice_id === "string" ? plan.voice_id : "未记录",
      scene: effectiveScene,
      sceneSource: effectiveSceneSource,
      sceneType: effectiveScene || "未分类",
      sceneScore: numeric(plan.scene_score),
      sceneAlignmentReason: typeof plan.scene_alignment_reason === "string" ? plan.scene_alignment_reason : "尚未采集场景契合度数据",
      tokensUsed: numeric(telemetry.tokensUsed),
      ttsChars: numeric(telemetry.ttsChars),
      costEstimateYuan: numeric(telemetry.costEstimateYuan),
      tokenUsageAvailable: telemetry.tokenUsageAvailable === true,
      providerMode: typeof telemetry.providerMode === "string" ? telemetry.providerMode : "unreported",
      requestedModel: typeof telemetry.requestedModel === "string" ? telemetry.requestedModel : "",
      selectedModel: typeof telemetry.selectedModel === "string" ? telemetry.selectedModel : "",
      modelsAttempted: Array.isArray(telemetry.modelsAttempted) ? telemetry.modelsAttempted.filter((item): item is string => typeof item === "string") : [],
      modelAttempts: Array.isArray(telemetry.modelAttempts)
        ? telemetry.modelAttempts
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => {
            const attempt: { model: string; durationMs: number; ok: boolean; error?: string } = {
              model: typeof item.model === "string" ? item.model : "",
              durationMs: numeric(item.durationMs),
              ok: item.ok === true,
            };
            if (typeof item.error === "string") attempt.error = item.error;
            return attempt;
          })
        : [],
      costSource: typeof telemetry.costSource === "string" ? telemetry.costSource : "unconfigured",
      qualityPassed: telemetry.qualityPassed === true,
      failureStage: typeof telemetry.failureStage === "string" ? telemetry.failureStage : "",
      creditsCharged: numeric(row.credits_charged),
      errorCode: row.error_code,
      errorMessage: row.error_message,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  });

  return {
    jobs,
    total: numeric(result.rows[0]?.total),
  };
}

