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
        <div className="job-delivery">
          <JobDeliveryVideoPlayer
            workId={message.jobWorkId}
            activeId={activePlayingVideoId ?? null}
            onPlay={(id) => setActivePlayingVideoId?.(id)}
            onPause={() => setActivePlayingVideoId?.((curr) => (curr === message.jobWorkId ? null : curr))}
          />

          {localFeedback && (
            <p className="works-copy-toast" role="status" style={{ margin: "8px 0" }}>
              {localFeedback}
            </p>
          )}

          {/* 一站式极速操作工具栏：下载原片与下载封面 */}
          <div className="job-delivery-actions">
            <button
              type="button"
              className="job-delivery-action-btn"
              onClick={() => {
                const workId = message.jobWorkId!;
                const filename = `jansee-${workId.slice(0, 8)}.mp4`;
                if (onRequestDownload) {
                  onRequestDownload(workId, filename);
                } else {
                  triggerNotice("正在启动成片下载…");
                  const a = document.createElement("a");
                  a.href = `/api/v1/works/${workId}/download`;
                  a.download = filename;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                }
              }}
              title="下载 1080P 高清成片原片"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              <span>下载原片 MP4</span>
            </button>

            <button
              type="button"
              className="job-delivery-action-btn"
              onClick={() => handleDownloadCover(message.jobWorkId!)}
              title="下载纯净宣发封面（无烧录字幕）"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              <span>下载封面</span>
            </button>
          </div>

          {(() => {
            const publish = (message.jobDirectorPlan?.publish ?? {}) as Record<string, unknown>;
            const caption = typeof publish.caption === "string" && publish.caption.trim() ? publish.caption.trim() : "";
            const coverTitle = typeof publish.cover_title === "string" && publish.cover_title.trim() ? publish.cover_title.trim() : "";
            const pinnedComment = typeof publish.pinned_comment === "string" && publish.pinned_comment.trim() ? publish.pinned_comment.trim() : "";
            const postTime = typeof publish.post_time === "string" && publish.post_time.trim() ? publish.post_time.trim() : "";
            if (!caption && !coverTitle) return null;
            return (
              <div className="job-publish">
                {coverTitle && (
                  <div className="job-publish-fields">
                    <p>
                      <span>发布标题：</span>
                      <strong>{coverTitle}</strong>
                    </p>
                  </div>
                )}
                {caption && (
                  <div className="job-publish-caption">
                    <span>{caption}</span>
                    <button
                      type="button"
                      className="job-publish-copy"
                      onClick={() => void copyToClipboard(caption, "宣发文案")}
                    >
                      复制文案
                    </button>
                  </div>
                )}
                {(pinnedComment || postTime) && (
                  <div className="job-publish-fields">
                    {pinnedComment && (
                      <p>
                        <span>置顶评论：</span>
                        {pinnedComment}
                      </p>
                    )}
                    {postTime && (
                      <p>
                        <span>建议发布：</span>
                        {postTime}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
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
