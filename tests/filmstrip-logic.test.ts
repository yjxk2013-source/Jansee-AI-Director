import test from "node:test";
import assert from "node:assert/strict";
import {
  bgmLabel,
  buildScriptLines,
  filmstripPreviewUrl,
  motionLabel,
  revealFromProgress,
  revealFromTime,
  revealStepMs,
  splitNarration,
} from "../apps/web/src/filmstrip-logic.ts";

test("narration splits on Chinese punctuation, keeping the mark", () => {
  const narration = "这款面料透气又亲肤。上身立刻显瘦。通勤约会都合适！";
  assert.deepEqual(splitNarration(narration), [
    "这款面料透气又亲肤。",
    "上身立刻显瘦。",
    "通勤约会都合适！",
  ]);
  // 逗号也拆，和后端 renderer.ts 的规则一致
  assert.deepEqual(splitNarration("第一句，第二句。第三句"), ["第一句，", "第二句。", "第三句"]);
  assert.deepEqual(splitNarration(""), []);
});

test("buildScriptLines matches backend renderer: exactly one line per scene, all narration preserved", () => {
  // 句数 == 镜头数：一句一镜
  const even = buildScriptLines("第一句。第二句。第三句。", 3);
  assert.deepEqual(even, ["第一句。", "第二句。", "第三句。"]);

  // 句数 < 镜头数：最长句被对半拆，直到够数（与 renderer.ts 180-185 行一致）
  const few = buildScriptLines("这是一段很长很长的旁白台词需要拆分。短句。", 3);
  assert.equal(few.length, 3, "one line per scene");
  assert.ok(few.every((line) => line.length > 0), "no empty line");

  // 句数 > 镜头数：等比分桶，多句合并到同一镜，台词不丢失（与 renderer.ts 186-190 行一致）
  const many = buildScriptLines("一。二。三。四。五。六。", 3);
  assert.equal(many.length, 3);
  assert.equal(many.join(""), "一。二。三。四。五。六。", "no narration dropped");

  // 单镜头吞下全部台词
  assert.deepEqual(buildScriptLines("甲。乙。丙。", 1), ["甲。乙。丙。"]);

  // 空台词 / 非法镜头数
  assert.deepEqual(buildScriptLines("", 3), []);
  assert.deepEqual(buildScriptLines("有台词。", 0), []);
});

test("motion ids map to human Chinese; unknown values pass through", () => {
  assert.equal(motionLabel("sweep_lr"), "左→右横移");
  assert.equal(motionLabel("sweep_rl"), "右→左横移");
  assert.equal(motionLabel("rise_up"), "缓缓抬升");
  assert.equal(motionLabel("diagonal"), "斜向推进");
  assert.equal(motionLabel("0.7s叠化转场"), "0.7s叠化转场"); // 历史中文文案兼容
  assert.equal(motionLabel(undefined), "");
});

test("bgm emotions map to Chinese; all 10 candidate emotions covered", () => {
  const expected: Record<string, string> = {
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
  for (const [id, zh] of Object.entries(expected)) assert.equal(bgmLabel(id), zh, id);
  assert.equal(bgmLabel("custom_mood"), "custom_mood");
  assert.equal(bgmLabel(undefined), "");
});

test("reveal follows real render progress across the whole FFMPEG window", () => {
  const total = 4;
  assert.equal(revealFromProgress(total, false, "planning", 40), 0, "no plan -> nothing revealed");
  assert.equal(revealFromProgress(total, true, "planning", 40), 0, "plan just returned -> reveal concept first");
  assert.equal(revealFromProgress(total, true, "rendering", 50), 1);
  assert.equal(revealFromProgress(total, true, "rendering", 65), 3);
  assert.equal(revealFromProgress(total, true, "rendering", 89), 4);
  assert.equal(revealFromProgress(total, true, "quality-check", 90), total, "QC reveals all at once");
  assert.equal(revealFromProgress(total, true, "completed", 100), total);
  assert.ok(revealFromProgress(total, true, "rendering", 70) >= revealFromProgress(total, true, "rendering", 55), "monotonic");
});

test("time fallback paces one scene at a time over ~50s and honors reduced motion", () => {
  const total = 5;
  const step = revealStepMs(total, false);
  assert.ok(step >= 4000 && step <= 9000);
  assert.equal(revealFromTime(total, 0, false), 1, "first scene appears immediately");
  assert.equal(revealFromTime(total, step * 2, false), 3);
  assert.equal(revealFromTime(total, step * 10, false), total, "never exceeds total");
  assert.equal(revealFromTime(total, 0, true), total, "reduced motion reveals all instantly");
});

test("filmstrip thumbnail prefers the durable server preview over stale blob URLs", () => {
  const assetId = "a0ce38ff-99f2-4cc7-a523-7be25f3a684e";
  const staleBlob = "blob:https://jansee.cn/5110c92a-e713-4ddb-ae0f-a56d1eb19348";
  assert.equal(filmstripPreviewUrl({ assetId, previewUrl: staleBlob }), `/api/v1/assets/${assetId}/preview`);
  assert.equal(filmstripPreviewUrl({ previewUrl: staleBlob }), staleBlob);
  assert.equal(filmstripPreviewUrl({ url: "https://example.com/a.jpg" }), "https://example.com/a.jpg");
  assert.equal(filmstripPreviewUrl({}), "");
});

test("each scene gets exactly one script line, so per-frame mapping never overruns", () => {
  const scenes = 2;
  const lines = buildScriptLines("一。二。三。四。五。", scenes);
  assert.equal(lines.length, scenes, "line count equals scene count");
  assert.equal(lines[0], "一。二。");
  assert.equal(lines[1], "三。四。五。");
});
