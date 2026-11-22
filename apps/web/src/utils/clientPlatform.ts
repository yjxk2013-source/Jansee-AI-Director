import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment, ClientPlatform } from "../types/client";

/** 一行字轻提示统一 2.5 秒自动消失；重复设置会重置计时，传空串立即清空。 */
export const NOTICE_DURATION_MS = 2500;

export function useTimedNotice(): [string, (next: string) => void] {
  const [value, setValue] = useState("");
  const timerRef = useRef<number | undefined>(undefined);
  const set = useCallback((next: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setValue(next);
    timerRef.current = next
      ? window.setTimeout(() => {
        setValue("");
        timerRef.current = undefined;
      }, NOTICE_DURATION_MS)
      : undefined;
  }, []);
  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);
  return [value, set];
}

// APK 发布地址：替换为正式下载地址后即可生效，面板与二维码共用此值。
export const ANDROID_APK_URL = "https://jansee.cn/download/jansee.apk";

export function detectClientPlatform(): ClientPlatform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (/iPad|iPhone|iPod/i.test(ua) || (isMobile && /Macintosh/i.test(ua))) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

export function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function mediaKind(file: File): Attachment["kind"] | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

// 废弃硬编码关键词匹配：意图由 LLM 导演大脑全权判定输出 operation
export function isSpeechCutIntent(_prompt: string) {
  return false;
}

export const JOB_PROGRESS_LOGS: Record<string, Array<{ speaker: string; text: string }>> = {
  queued: [{ speaker: "简兮导演", text: "收到你的创作意图啦，正在为你调配算力与分镜资源，马上开始构思～" }],
  inspecting: [{ speaker: "简兮美术师", text: "画面素材全部收齐、画质校验无损，色调与构图很棒，准备为你设计视觉节奏！" }],
  planning: [{ speaker: "简兮导演", text: "分镜脚本与台词方案已经打磨完毕，这就正式交付制作流水线全面推进。" }],
  rendering: [
    { speaker: "简兮剪辑师", text: "正在顺着分镜细细编排运镜与柔和叠画，让每一帧画面的转换都自然流动。" },
    { speaker: "简兮音效师", text: "正在渲染超自然人声配音与多轨避让混音，给画面铺上最有感染力的听觉氛围。" },
    { speaker: "简兮包装师", text: "发丝级字幕、呼吸感版面与专属片尾正在细致压制，成片很快就能和你见面啦！" },
  ],
  "quality-check": [{ speaker: "简兮质检师", text: "全片合成完毕，正在做最后的画质平衡、音频平滑与合规细节核验，确保最佳呈现。" }],
  completed: [{ speaker: "简兮导演", text: "成片已制作完成！每个镜头的节奏与质感都已就绪，快点击播放看看效果吧～" }],
};

export const withdrawalStatusLabel: Record<string, string> = {
  pending: "待审核",
  approved: "已通过 · 待打款",
  paid: "已打款",
  rejected: "已驳回",
  failed: "打款失败",
};

