import { useState } from "react";
import type { ChatMessage } from "../../types/client";
import { JobDeliveryVideoPlayer } from "../video/JobDeliveryVideoPlayer";

interface JobDeliveryCardProps {
  message: ChatMessage;
  fallbackScene: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  activePlayingVideoId?: string | null | undefined;
  setActivePlayingVideoId?: ((id: string | null | ((curr: string | null) => string | null)) => void) | undefined;
  onRestoreDraft?: ((text: string) => void) | undefined;
  onRequestDownload?: ((workId: string, filename: string) => void) | undefined;
  onShowNotice?: ((notice: string) => void) | undefined;
}

export function JobDeliveryCard({
  message,
  fallbackScene,
  activePlayingVideoId = null,
  setActivePlayingVideoId,
  onRestoreDraft,
  onRequestDownload,
  onShowNotice,
}: JobDeliveryCardProps) {
  const failedScene = message.creationScene ?? fallbackScene;
  const isPaidFailed = failedScene === "online-ecommerce" || failedScene === "physical-store";
  const [localFeedback, setLocalFeedback] = useState<string>("");

  const triggerNotice = (text: string) => {
    if (onShowNotice) {
      onShowNotice(text);
    } else {
      setLocalFeedback(text);
      setTimeout(() => setLocalFeedback(""), 2500);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    if (!navigator.clipboard) {
      triggerNotice("当前浏览器不支持一键复制，请手动选中复制。");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      triggerNotice(`${label}已复制到剪贴板`);
    } catch {
      triggerNotice("复制失败，请手动选择复制。");
    }
  };

  const handleDownloadCover = async (workId: string) => {
    const coverUrl = `/api/v1/works/${workId}/cover`;
    triggerNotice("正在下载纯净封面…");
    try {
      const res = await fetch(coverUrl, { credentials: "include" });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `jansee-cover-${workId.slice(0, 8)}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      triggerNotice("纯净封面已保存到本地。");
    } catch {
      // 兜底直接导航下载
      const a = document.createElement("a");
      a.href = coverUrl;
      a.download = `jansee-cover-${workId.slice(0, 8)}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      triggerNotice("已发起封面下载。");
    }
  };

  return (
    <>
      {/* 任务失败：明确告知结果、不暴露内部错误、说明恢复方式与积分去向 */}
      {message.jobId && !message.jobWorkId && message.jobStatus === "failed" && (
        <div className="job-failure-notice" role="alert">
          <span className="job-failure-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5" />
              <path d="M12 16.5h.01" />
            </svg>
          </span>
          <div className="job-failure-body">
            <div className="job-failure-title">这次没能完成</div>
            <p className="job-failure-desc">{message.jobError || "制作过程中遇到了临时问题，你的素材和创作内容都已保留。"}</p>
            <p className="job-failure-hint">
              {isPaidFailed
                ? "本次消耗的积分已退回，可调整描述或素材后重试。"
                : "本次为免费创作，不消耗积分，可调整描述或素材后重试。"}
            </p>
            {onRestoreDraft && message.text && (
              <div style={{ marginTop: "10px" }}>
                <button
                  type="button"
                  className="composer-button"
                  style={{ padding: "6px 16px", fontSize: "13px", height: "auto" }}
                  onClick={() => onRestoreDraft(message.text)}
                >
                  恢复素材与文案重试
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {message.jobWorkId ? (
        <div className="job-delivery job-delivery-preview-only">
          <JobDeliveryVideoPlayer
            workId={message.jobWorkId}
            activeId={activePlayingVideoId ?? null}
            onPlay={(id) => setActivePlayingVideoId?.(id)}
            onPause={() => setActivePlayingVideoId?.((curr) => (curr === message.jobWorkId ? null : curr))}
          />

          <div className="job-delivery-archive-hint" role="note">
            <span>成片预览就绪 · 高清原片下载与宣发文案请至「我的作品」</span>
          </div>
        </div>
      ) : (
        message.jobId && message.jobStatus !== "failed" && message.jobStatus !== "cancelled" ? (
          <div className="job-delivery-notice-pending" role="status" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {message.jobStatus === "queued" ? (
              <span style={{ fontSize: "13px", color: "var(--jansee-text-secondary, #5f6368)" }}>
                排队等待中（当前位次：第 {message.jobQueuePosition || 1} 位，预计等待约 {message.jobEstimatedWaitSec || 35} 秒）…
              </span>
            ) : (
              <span style={{ fontSize: "13px", color: "var(--jansee-text-secondary, #5f6368)" }}>
                AI 导演正在压制合成中{typeof message.jobProgress === "number" ? ` (${message.jobProgress}%)` : "…"}，宣发方案已在后台就绪…
              </span>
            )}
            {typeof message.jobProgress === "number" && message.jobProgress > 0 && (
              <div style={{ width: "100%", height: "4px", background: "rgba(0, 0, 0, 0.08)", borderRadius: "2px", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.min(100, Math.max(5, message.jobProgress))}%`,
                    height: "100%",
                    background: "#18191b",
                    transition: "width 0.35s ease",
                  }}
                />
              </div>
            )}
          </div>
        ) : null
      )}
    </>
  );
}
