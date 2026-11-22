/**
 * 工作台「片场手稿」面板的纯逻辑：台词拆句、运镜/情绪中文映射、逐镜揭示计算。
 * 单独成文件（无 JSX / 无 React 依赖）以便用 node:test 直接验证。
 */

/** 后端运镜 ID 清单（director.ts DIRECTOR_MOTION_IDS）→ 用户能懂的中文。 */
export const MOTION_LABELS: Record<string, string> = {
  sweep_lr: "左→右横移",
  sweep_rl: "右→左横移",
  rise_up: "缓缓抬升",
  diagonal: "斜向推进",
};

/** 后端 BGM 情绪池（10 种）→ 中文情绪词。未命中回退为原文。 */
export const BGM_EMOTION_LABELS: Record<string, string> = {
  warm: "温暖",
  relaxed: "放松",
  fresh: "清新",
  cozy: "温馨",
  playful: "轻快",
  energetic: "有活力",
  calm_narrative: "平静叙述",
  inspirational: "励志",
  tech_future: "科技感",
  luxury: "高级质感",
};

/**
 * 与后端 renderer.ts 完全一致的拆句规则：按中文标点切分并把标点留在句尾。
 * 台词是全片 narration 一个字段。
 */
export function splitNarration(narration: string): string[] {
  return narration.split(/(?<=[。！？；，、])/).map((part) => part.trim()).filter(Boolean);
}

/**
 * 把全片台词分配给每个镜头——与后端 renderer.ts（179–190 行）完全相同的算法。
 * 后端逻辑：先拆句；句数不足镜头数时反复对半拆最长句补齐；再按等比分桶，
 * 一个镜头可能对应多句（join 成一段）。工作台必须用同一算法，用户看到的台词
 * 才会和成片里每个镜头的配音一一对应。
 */
export function buildScriptLines(narration: string, sceneCount: number): string[] {
  if (!narration.trim() || sceneCount <= 0) return [];
  const sentences = splitNarration(narration.trim());
  while (sentences.length < sceneCount) {
    let longestIndex = 0;
    for (let index = 1; index < sentences.length; index += 1) {
      if ((sentences[index] || "").length > (sentences[longestIndex] || "").length) longestIndex = index;
    }
    const longest = sentences[longestIndex] || narration;
    const splitAt = Math.max(1, Math.floor(longest.length / 2));
    sentences.splice(longestIndex, 1, longest.slice(0, splitAt), longest.slice(splitAt));
  }
  return Array.from({ length: sceneCount }, (_, index) => {
    const start = Math.floor(index * sentences.length / sceneCount);
    const end = Math.floor((index + 1) * sentences.length / sceneCount);
    return sentences.slice(start, Math.max(start + 1, end)).join("");
  });
}

/** 素材缩略图地址：服务端素材是长期来源，blob 只用于上传后、assetId 尚未回填的短暂窗口。 */
export function filmstripPreviewUrl(attachment: {
  assetId?: string;
  previewUrl?: string;
  url?: string;
}): string {
  if (typeof attachment.assetId === "string" && attachment.assetId.trim()) {
    return `/api/v1/assets/${encodeURIComponent(attachment.assetId)}/preview`;
  }
  if (typeof attachment.previewUrl === "string" && attachment.previewUrl) return attachment.previewUrl;
  if (typeof attachment.url === "string" && attachment.url) return attachment.url;
  return "";
}

/** 把运镜 ID 翻译成中文；未知 ID 原样返回（兼容历史方案里的中文文案），无值返回空串。 */
export function motionLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  return MOTION_LABELS[raw] || raw;
}

/** 把 BGM 情绪翻译成中文；未收录的情绪原样返回。 */
export function bgmLabel(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  return BGM_EMOTION_LABELS[raw] || raw;
}

/**
 * 根据真实进度计算应揭示到第几个镜头（1-based 数量，范围 0..total）。
 * - 无方案 → 0
 * - quality-check / completed → 全部
 * - planning 阶段 progress<=40 → 0（先把导演阐述打完）
 * - rendering 阶段 progress 40→90 线性铺开
 */
export function revealFromProgress(total: number, hasPlan: boolean, status: string | undefined, progress: number): number {
  if (!hasPlan) return 0;
  if (status === "quality-check" || status === "completed") return total;
  if (!Number.isFinite(progress) || progress <= 40) return 0;
  if (progress >= 90) return total;
  return Math.min(total, Math.floor(((progress - 40) / 50) * total) + 1);
}

/** 定时兜底：渲染期约 50 秒按镜头数均摊，单镜 4~9 秒；开启减少动态效果时立即全显。 */
export function revealStepMs(total: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  return Math.max(4000, Math.min(9000, Math.floor(50000 / Math.max(total, 1))));
}

/** 定时兜底在给定经过时间下应揭示的镜头数。 */
export function revealFromTime(total: number, elapsedMs: number, reducedMotion: boolean): number {
  if (reducedMotion) return total;
  const step = revealStepMs(total, reducedMotion);
  return Math.min(total, Math.floor(elapsedMs / step) + 1);
}

/**
 * 暗房 35 秒平滑显影引擎：
 * - 0 ~ 5s: 轮廓微光显影 (5% -> 25%)
 * - 5 ~ 28s: 细节平顺显影 (25% -> 88%)
 * - 28 ~ 35s: 渐近饱和定影态 (88% -> 95%)
 * - > 35s: 平稳等待成片 (95%)，提示质检定影中
 * - 若 settled 或 status 为 completed: 瞬时拉满至 100% 亮屏定影
 */
export function calculateDarkroomDeveloping(
  elapsedMs: number,
  realProgress: number,
  settled: boolean,
  status?: string,
): {
  progress: number;
  opacity: number;
  label: string;
} {
  if (settled || status === "completed") {
    return {
      progress: 100,
      opacity: 1.0,
      label: "成片已定影交付 · 支持在线沉浸预览",
    };
  }

  let timeProgress = 5;
  if (elapsedMs <= 5000) {
    timeProgress = 5 + (elapsedMs / 5000) * 20;
  } else if (elapsedMs <= 28000) {
    timeProgress = 25 + ((elapsedMs - 5000) / 23000) * 63;
  } else if (elapsedMs <= 35000) {
    timeProgress = 88 + ((elapsedMs - 28000) / 7000) * 7;
  } else {
    timeProgress = 95;
  }

  const boundedReal = Math.min(95, Math.max(0, realProgress));
  const effectiveProgress = Math.min(95, Math.max(timeProgress, boundedReal));
  const opacity = Math.max(0.06, Math.min(0.96, effectiveProgress / 100));

  let label = `暗房多轨显影中 (${Math.round(effectiveProgress)}%)`;
  if (status === "queued") {
    label = "排队调度中…";
  } else if (status === "inspecting") {
    label = "素材底片校验中…";
  } else if (status === "planning") {
    label = "导演分镜执笔中…";
  } else if (status === "quality-check" || elapsedMs >= 35000 || effectiveProgress >= 93) {
    label = "底片显影完成 · 画质质检定影中…";
  }

  return {
    progress: Math.round(effectiveProgress),
    opacity,
    label,
  };
}
