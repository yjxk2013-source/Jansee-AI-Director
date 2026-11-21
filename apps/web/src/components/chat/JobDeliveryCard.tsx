import type { ChatMessage } from "../../types/client";
import { JobDeliveryVideoPlayer } from "../video/JobDeliveryVideoPlayer";

interface JobDeliveryCardProps {
  message: ChatMessage;
  fallbackScene: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  activePlayingVideoId?: string | null;
  setActivePlayingVideoId?: (id: string | null | ((curr: string | null) => string | null)) => void;
  onRestoreDraft?: (text: string) => void;
}

export function JobDeliveryCard({
  message,
  fallbackScene,
  activePlayingVideoId = null,
  setActivePlayingVideoId,
  onRestoreDraft,
}: JobDeliveryCardProps) {
  const failedScene = message.creationScene ?? fallbackScene;
  const isPaidFailed = failedScene === "online-ecommerce" || failedScene === "physical-store";

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
                      onClick={() => {
                        void navigator.clipboard.writeText(caption).then(() => {
                          alert("宣发文案已复制到剪贴板");
                        });
                      }}
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
        (() => {
          const publish = (message.jobDirectorPlan?.publish ?? {}) as Record<string, unknown>;
          const caption = typeof publish.caption === "string" && publish.caption.trim() ? publish.caption.trim() : "";
          if (!caption && !publish.cover_title) return null;
          if (message.jobStatus !== "failed" && message.jobStatus !== "cancelled") {
            return (
              <div className="job-delivery-notice-pending">
                <span>成片正在压制合成中，宣发方案已在后台生成…</span>
              </div>
            );
          }
          return null;
        })()
      )}
    </>
  );
}
