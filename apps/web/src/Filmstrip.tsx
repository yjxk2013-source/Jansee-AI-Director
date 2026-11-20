import { useEffect, useMemo, useRef, useState } from "react";
import {
  bgmLabel,
  buildScriptLines,
  filmstripPreviewUrl,
  motionLabel,
  revealFromProgress,
  revealFromTime,
} from "./filmstrip-logic";

/** 与主消息流共用同一套消息形状；这里只声明组件实际用到的字段。 */
type FilmstripMessage = {
  id: string;
  jobId?: string;
  jobStatus?: string;
  jobProgress?: number;
  jobDirectorPlan?: Record<string, unknown>;
  creationScene?: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  attachments?: Array<{ id?: string; assetId?: string; name?: string; kind?: "image" | "video"; url?: string; previewUrl?: string }>;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 逐字打字机。文本变化（方案刚返回）或 active 由假变真时从 0 重新打；
 * 系统开了“减少动态效果”则直接全显。按 Unicode 字符步进，中文不会切断。
 */
function useTypewriter(text: string, active: boolean, charMs: number): { shown: string; typing: boolean } {
  const chars = useMemo(() => Array.from(text), [text]);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!active || chars.length === 0) {
      setCount(chars.length);
      return;
    }
    if (prefersReducedMotion()) {
      setCount(chars.length);
      return;
    }
    setCount(0);
    let current = 0;
    const timer = window.setInterval(() => {
      current += 1;
      setCount(current);
      if (current >= chars.length) window.clearInterval(timer);
    }, charMs);
    return () => window.clearInterval(timer);
  }, [chars, active, charMs]);
  return { shown: chars.slice(0, count).join(""), typing: active && count < chars.length };
}

/**
 * 计算当前应揭示到第几个镜头。
 * 驱动源：真实渲染进度为主 + 缓慢定时兜底，取较大值。
 * - 方案未到（planning 前）→ 0 镜
 * - rendering 阶段 progress 70→89 → 逐镜铺开
 * - quality-check/completed → 一次性全部揭示
 * 定时兜底保证进度分阶段跳变、某几秒不涨时画面仍在推进，避免“卡住”错觉。
 */
function useRevealCount(total: number, hasPlan: boolean, status: string | undefined, progress: number): number {
  const [revealed, setRevealed] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  const progressRef = useRef(progress);
  statusRef.current = status;
  progressRef.current = progress;

  useEffect(() => {
    if (!hasPlan) {
      setRevealed(0);
      startedAtRef.current = null;
      return;
    }
    if (status === "quality-check" || status === "completed") {
      setRevealed(total);
      return;
    }
    if (startedAtRef.current === null) startedAtRef.current = Date.now();

    const reduced = prefersReducedMotion();

    const tick = () => {
      const currentStatus = statusRef.current;
      if (currentStatus === "quality-check" || currentStatus === "completed") {
        setRevealed(total);
        return;
      }
      const elapsed = Date.now() - (startedAtRef.current ?? Date.now());
      const timeReveal = revealFromTime(total, elapsed, reduced);
      const progressReveal = revealFromProgress(total, hasPlan, currentStatus, progressRef.current);
      setRevealed(Math.min(total, Math.max(timeReveal, progressReveal)));
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [total, hasPlan, status]);

  return revealed;
}

/** 单镜台词：未揭示时保持“构思中”占位；揭示后逐字打出。独立组件以满足 hooks 规则。 */
function ScriptLine({ text, active }: { text: string; active: boolean }) {
  const { shown, typing } = useTypewriter(text, active, 26);
  if (!text) return <span className="filmstrip-script-placeholder">台词执笔构思中…</span>;
  if (!active) return <span className="filmstrip-script-placeholder">台词执笔构思中…</span>;
  return <span>“{shown}”{typing && <span className="typewriter-cursor" aria-hidden="true" />}</span>;
}

export type FilmstripProps = {
  message: FilmstripMessage;
  fallbackScene: FilmstripMessage["creationScene"];
};

export function Filmstrip({ message, fallbackScene }: FilmstripProps) {
  const plan = message.jobDirectorPlan;
  const hasPlan = Boolean(plan && Object.keys(plan).length > 0);
  const scenes = (plan?.scenes as Array<Record<string, unknown>>) || [];
  const attachments = message.attachments || [];

  // 镜头数优先用方案分镜，方案未到时用素材占位。
  const total = Math.max(1, scenes.length || attachments.length || 4);
  // 台词用与后端 renderer.ts 完全相同的分桶算法分配到每个镜头，保证工作台与成片逐镜一致。
  const narration = typeof plan?.narration === "string" ? plan.narration.trim() : "";
  const scriptLines = useMemo(() => buildScriptLines(narration, total), [narration, total]);

  const status = message.jobStatus;
  const progress = typeof message.jobProgress === "number" ? message.jobProgress : 0;
  const revealed = useRevealCount(total, hasPlan, status, progress);

  const concept = typeof plan?.concept === "string" ? plan.concept.trim() : "";
  const { shown: conceptShown, typing: conceptTyping } = useTypewriter(concept, hasPlan, 42);

  const bgmText = bgmLabel(plan?.bgm_emotion);
  const settled = status === "quality-check" || status === "completed";

  const scene = message.creationScene ?? fallbackScene;
  const sceneName = scene === "online-ecommerce" ? "带货视频"
    : scene === "physical-store" ? "门店获客"
    : scene === "personal-creation" ? "个人创作"
    : "一句话剪辑";

  const frameSource: Array<Record<string, unknown>> = attachments.length > 0
    ? attachments as Array<Record<string, unknown>>
    : Array.from({ length: total }, (_, i) => ({ id: `stub-${i}`, name: `镜头 0${i + 1}`, kind: "image" as const }));

  return (
    <div className={`director-filmstrip-panel${settled ? " is-settled" : ""}`} aria-label="片场分镜手稿与冲洗监视舱">
      <div className="filmstrip-header">
        <div className="filmstrip-live-badge">
          <span className="filmstrip-rec-dot" aria-hidden="true" />
          <span className="filmstrip-rec-text">REC 35MM · {settled ? "DELIVERED" : "DIRECTING"} · {sceneName}</span>
        </div>
        <div className="filmstrip-meta-status">
          {!status && "素材已就位 · 正在连接导演团队"}
          {status === "queued" && "排队调度中 · 准备算力"}
          {status === "inspecting" && "素材底片校验 · 构图分析"}
          {status === "planning" && "导演分镜执笔 · 台词显影"}
          {status === "rendering" && `多轨避让混音与转场压制 · ${Math.round(progress || 45)}%`}
          {status === "quality-check" && "画质与音频合规复验 · 即将成片"}
          {status === "completed" && "成片已交付 · 请到「我的作品」查看与下载"}
        </div>
      </div>

      {concept && (
        <div className="filmstrip-concept">
          <span className="filmstrip-concept-label">导演阐述</span>
          <span className="filmstrip-concept-text">
            {conceptShown}{conceptTyping && <span className="typewriter-cursor" aria-hidden="true" />}
          </span>
        </div>
      )}

      <div className="filmstrip-track-wrapper">
        <div className="filmstrip-track">
          {frameSource.map((att, idx) => {
            const planScene = scenes[idx];
            const speech = scriptLines[idx] || (typeof planScene?.line === "string" ? planScene.line : "");
            const motionText = motionLabel(planScene?.motion);
            const frameRevealed = hasPlan && idx < revealed;

            const frameKey = (att.id as string) || (att.assetId as string) || `frame-${idx}`;
            const previewUrl = filmstripPreviewUrl(att as { assetId?: string; previewUrl?: string; url?: string });

            return (
              <div className={`filmstrip-frame${frameRevealed ? " is-revealed" : ""}`} key={frameKey}>
                <div className="filmstrip-frame-perforations-top"><span /><span /><span /><span /></div>
                <div className="filmstrip-thumbnail-box">
                  {previewUrl ? (
                    <img src={previewUrl} alt={`第 ${idx + 1} 镜头素材`} className="filmstrip-img" />
                  ) : (
                    <div className="filmstrip-thumb-placeholder"><span className="frame-num">0{idx + 1}</span></div>
                  )}
                  <span className="filmstrip-frame-tag">SCENE 0{idx + 1}</span>
                </div>
                <div className="filmstrip-frame-perforations-bottom"><span /><span /><span /><span /></div>

                <div className="filmstrip-script-notes">
                  {motionText && (
                    <div className="filmstrip-motion-tag">
                      <span className="motion-icon" aria-hidden="true" />
                      {motionText}
                    </div>
                  )}
                  <div className="filmstrip-script-text">
                    <ScriptLine text={speech} active={frameRevealed} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="filmstrip-footer">
        <div className="filmstrip-sound-engine">
          <span className="sound-engine-dot" />
          <span className="sound-engine-label">
            VOICE: {String(plan?.voice_id || "403011")}
            {bgmText ? ` · BGM ${bgmText}` : " · 混音避让已就绪"}
          </span>
        </div>
        <div className="filmstrip-wave-bars" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
      </div>
    </div>
  );
}
