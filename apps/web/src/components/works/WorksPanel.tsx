import { useEffect, useRef, useState } from "react";
import type { AuthUser, SavedConversation, WorkItem } from "../../types/client.js";
import { NOTICE_DURATION_MS, useTimedNotice } from "../../utils/clientPlatform.js";
import { getLocalCache, getWorksCacheKey, setLocalCache } from "../../utils/offlineCache.js";
import { getOrCacheMediaUrl, preloadMediaUrls, useCachedMediaUrl } from "../../utils/mediaCache.js";
import { PublishStudio, type PublishKit } from "./PublishStudio.js";

function resolvePublishForWork(work: WorkItem, conversations: SavedConversation[]): PublishKit | null {
  let base: NonNullable<WorkItem["publish"]> | null = null;
  if (work.publish && (work.publish.title || work.publish.caption || work.publish.cover_title || work.publish.pinned_comment)) {
    base = work.publish;
  } else {
    for (const conversation of conversations) {
      const match = conversation.messages.find((m) => m.jobWorkId === work.id || m.jobId === work.jobId);
      const plan = match?.jobDirectorPlan as Record<string, unknown> | undefined;
      const pub = plan?.publish as NonNullable<WorkItem["publish"]> | undefined;
      if (pub && (pub.title || pub.caption || pub.cover_title || pub.pinned_comment)) {
        base = pub;
        break;
      }
    }
  }

  // 短视频宣发套件发布标题：优先选用 LLM 导演生成的爆款社媒发布标题（publish.title > publish.cover_title），
  // 杜绝误把设计卡4~6字视觉短标题作为社交媒体发布标题
  let publishTitle = "";
  if (typeof base?.title === "string" && base.title.trim()) {
    publishTitle = base.title.trim();
  } else if (typeof base?.cover_title === "string" && base.cover_title.trim()) {
    publishTitle = base.cover_title.trim();
  } else {
    const workPlan = work.directorPlan as Record<string, unknown> | undefined;
    if (typeof workPlan?.title === "string" && workPlan.title.trim()) publishTitle = workPlan.title.trim();
    if (!publishTitle && typeof work.title === "string" && work.title.trim()) publishTitle = work.title.trim();
    if (!publishTitle) {
      for (const conversation of conversations) {
        const match = conversation.messages.find((m) => m.jobWorkId === work.id || m.jobId === work.jobId);
        const plan = match?.jobDirectorPlan as Record<string, unknown> | undefined;
        if (typeof plan?.title === "string" && plan.title.trim()) {
          publishTitle = plan.title.trim();
          break;
        }
      }
    }
  }

  if (!base && !publishTitle) return null;
  return { ...(base ?? {}), ...(publishTitle ? { title: publishTitle } : {}) };
}

interface WorkDeliveryCardItemProps {
  work: WorkItem;
  isHighlighted: boolean;
  titleLabel: string;
  filename: string;
  publishKit: PublishKit | null;
  activePlayWorkId: string | null;
  setActivePlayWorkId: (id: string | null) => void;
  videoRefs: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  cardContainerRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  coverDataUrls: Record<string, string>;
  setCoverDataUrls: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onRequestDownload?: ((workId: string, filename: string) => void) | undefined;
  setCopyFeedback: (msg: string) => void;
  copiedKey: string | null;
  copyText: (key: string, text: string, label: string) => void;
  setPreviewingCoverUrl: (url: string | null) => void;
  downloadCover: (work: WorkItem) => void;
}

function WorkDeliveryCardItem({
  work,
  isHighlighted,
  titleLabel,
  filename,
  publishKit,
  activePlayWorkId,
  setActivePlayWorkId,
  videoRefs,
  cardContainerRefs,
  coverDataUrls,
  setCoverDataUrls,
  onRequestDownload,
  setCopyFeedback,
  copiedKey,
  copyText,
  setPreviewingCoverUrl,
  downloadCover,
}: WorkDeliveryCardItemProps) {
  const cachedCover = useCachedMediaUrl(work.coverUrl);
  const effectiveCover = cachedCover || work.coverUrl || coverDataUrls[work.id];

  return (
    <article
      id={`work-card-${work.id}`}
      className={`work-delivery-card${isHighlighted ? " is-highlighted" : ""}`}
    >
      <div className="work-card-header">
        <div className="work-card-header-left">
          <span className="work-card-title">{titleLabel}</span>
          <span className="work-card-badge">1080P</span>
          <span className="work-card-size">{(work.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
        </div>
        <div className="work-card-header-right">
          <span className="work-card-time">{new Date(work.createdAt).toLocaleDateString()}</span>
        </div>
      </div>

      <div
        className="work-card-player"
        ref={(el) => { cardContainerRefs.current[work.id] = el; }}
        style={{ position: "relative" }}
      >
        <video
          ref={(el) => { videoRefs.current[work.id] = el; }}
          src={`/api/v1/works/${work.id}/stream`}
          controls={activePlayWorkId === work.id}
          playsInline
          preload="metadata"
          poster={effectiveCover || undefined}
          aria-label={titleLabel}
          onLoadedData={() => {
            if (!work.coverUrl && !coverDataUrls[work.id]) {
              const video = videoRefs.current[work.id];
              if (video && video.videoWidth > 0) {
                try {
                  const canvas = document.createElement("canvas");
                  canvas.width = Math.min(video.videoWidth, 640);
                  canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
                  const ctx = canvas.getContext("2d");
                  if (ctx) {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const generatedUrl = canvas.toDataURL("image/jpeg", 0.85);
                    setCoverDataUrls((prev) => ({ ...prev, [work.id]: generatedUrl }));
                  }
                } catch (_) { }
              }
            }
          }}
          onEnded={() => setActivePlayWorkId(null)}
          onPause={() => {
            if (activePlayWorkId === work.id) setActivePlayWorkId(null);
          }}
        />
        <div
          className="work-card-cover-container"
          onClick={() => {
            setActivePlayWorkId(work.id);
            const video = videoRefs.current[work.id];
            if (video) void video.play().catch(() => { });
          }}
          role="button"
          tabIndex={0}
          aria-label={`播放 ${titleLabel}`}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: activePlayWorkId === work.id ? 0 : 1,
            pointerEvents: activePlayWorkId === work.id ? "none" : "auto",
            transition: "opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActivePlayWorkId(work.id);
              const video = videoRefs.current[work.id];
              if (video) void video.play().catch(() => { });
            }
          }}
        >
          {effectiveCover ? (
            <img
              src={effectiveCover}
              alt={titleLabel}
              loading="lazy"
              className="work-card-cover-img"
              onError={(e) => {
                if (coverDataUrls[work.id] && e.currentTarget.src !== coverDataUrls[work.id]) {
                  e.currentTarget.src = coverDataUrls[work.id]!;
                  return;
                }
                const video = videoRefs.current[work.id];
                if (video && video.videoWidth > 0) {
                  try {
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.min(video.videoWidth, 640);
                    canvas.height = Math.round(canvas.width * (video.videoHeight / video.videoWidth));
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                      setCoverDataUrls((prev) => ({ ...prev, [work.id]: canvas.toDataURL("image/jpeg", 0.85) }));
                    }
                  } catch (_) { }
                }
              }}
            />
          ) : (
            <div className="work-card-cover-fallback">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
          <div className="work-card-play-overlay">
            <div className="work-card-play-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <div className="work-card-actions">
        <button
          type="button"
          className="work-btn-download"
          onClick={() => {
            setCopyFeedback("正在启动原片下载…");
            setTimeout(() => setCopyFeedback(""), 2500);
            if (onRequestDownload) onRequestDownload(work.id, filename);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
          </svg>
          下载原片 MP4
        </button>
      </div>

      {publishKit && (publishKit.title || publishKit.cover_title || publishKit.caption || publishKit.pinned_comment) && (
        <PublishStudio
          work={work}
          publishKit={publishKit}
          copiedKey={copiedKey}
          copyText={copyText}
          coverDataUrl={effectiveCover}
          onPreviewCover={(url) => setPreviewingCoverUrl(url)}
          onDownloadCover={downloadCover}
        />
      )}
    </article>
  );
}

export function WorksPanel({
  user,
  onNew,
  conversations = [],
  highlightWorkId,
  onRequestDownload,
}: {
  user: AuthUser | null;
  onNew: () => void;
  conversations?: SavedConversation[];
  highlightWorkId?: string | null;
  onClearHighlight?: () => void;
  onRequestDownload?: (workId: string, filename: string) => void;
}) {
  const [works, setWorks] = useState<WorkItem[]>(() => {
    if (!user) return [];
    return getLocalCache<WorkItem[]>(getWorksCacheKey(user.id)) ?? [];
  });
  const [loading, setLoading] = useState(() => {
    if (!user) return false;
    const cached = getLocalCache<WorkItem[]>(getWorksCacheKey(user.id));
    return !cached || cached.length === 0;
  });
  const [error, setError] = useTimedNotice();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const [activePlayWorkId, setActivePlayWorkId] = useState<string | null>(null);
  const [previewingCoverUrl, setPreviewingCoverUrl] = useState<string | null>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const cardContainerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [coverDataUrls, setCoverDataUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!activePlayWorkId) return;
    const el = cardContainerRefs.current[activePlayWorkId];
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry || !entry.isIntersecting || entry.intersectionRatio < 0.25) {
          const video = videoRefs.current[activePlayWorkId];
          if (video && !video.paused) {
            video.pause();
          }
          setActivePlayWorkId(null);
        }
      },
      { threshold: [0, 0.25, 0.5] }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [activePlayWorkId]);

  const downloadCover = async (work: WorkItem) => {
    const workId = work.id;
    if (!user || user.isGuest) {
      if (onRequestDownload) {
        onRequestDownload(workId, `jansee-cover-${workId}.png`);
      }
      return;
    }
    if (work.coverUrl) {
      setCopyFeedback("封面图片已开始下载");
      setTimeout(() => setCopyFeedback(""), NOTICE_DURATION_MS);
      try {
        const cachedUrl = await getOrCacheMediaUrl(work.coverUrl);
        const a = document.createElement("a");
        a.href = cachedUrl;
        a.download = `jansee-cover-${workId}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } catch {
        const a = document.createElement("a");
        a.href = work.coverUrl;
        a.download = `jansee-cover-${workId}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
      return;
    }

    let dataUrl = coverDataUrls[workId];
    const video = videoRefs.current[workId];
    if (!dataUrl && video && video.videoWidth > 0 && video.videoHeight > 0) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const generatedUrl = canvas.toDataURL("image/png");
          dataUrl = generatedUrl;
          setCoverDataUrls((prev) => ({ ...prev, [workId]: generatedUrl }));
        }
      } catch {
        // ignore
      }
    }
    if (!dataUrl) {
      setCopyFeedback("成片画面正在加载，请稍候再试");
      return;
    }
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `jansee-cover-${workId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setCopyFeedback("封面图片已开始下载");
    setTimeout(() => setCopyFeedback(""), NOTICE_DURATION_MS);
  };

  useEffect(() => {
    if (!user) return;
    const cacheKey = getWorksCacheKey(user.id);
    const cached = getLocalCache<WorkItem[]>(cacheKey);
    if (!cached || cached.length === 0) {
      setLoading(true);
    }
    let active = true;
    fetch("/api/v1/works", { credentials: "include" })
      .then((res) => res.json() as Promise<{ works?: WorkItem[]; error?: { message?: string } }>)
      .then((data) => {
        if (!active) return;
        if (data.works) {
          setWorks(data.works);
          setLocalCache(cacheKey, data.works);
          preloadMediaUrls(data.works.map((w) => w.coverUrl));
        } else if (data.error?.message && (!cached || cached.length === 0)) {
          setError(data.error.message);
        }
      })
      .catch(() => {
        if (!active) return;
        if (!cached || cached.length === 0) {
          setError("无法获取成片列表");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user, setError]);

  useEffect(() => {
    if (!highlightWorkId || works.length === 0) return;
    const targetEl = document.getElementById(`work-card-${highlightWorkId}`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlightWorkId, works]);

  const copyText = (key: string, text: string, label: string) => {
    if (!navigator.clipboard) {
      setCopyFeedback("当前浏览器不支持一键复制，请手动选中文案复制。");
      return;
    }
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setCopyFeedback(`${label}已复制到剪贴板`);
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
        setCopyFeedback("");
      }, 2500);
    }).catch(() => {
      setCopyFeedback("复制失败，请手动选择复制。");
    });
  };

  if (!user) {
    return (
      <div className="works-panel">
        <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v4m4-4v4m4-4v4M8 15h8" /></svg></div>
        <h2 id="header-panel-title">我的成片</h2>
        <p className="header-panel-copy">请先登录，即可查看你生成的所有商业短视频成片与宣发方案。</p>
        <button className="panel-primary-action" type="button" onClick={onNew}>开始创作</button>
      </div>
    );
  }

  return (
    <div className="works-panel">
      <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v4m4-4v4m4-4v4M8 15h8" /></svg></div>
      <h2 id="header-panel-title">我的成片</h2>
      <p className="header-panel-copy">已制作完成的商业成片与配套宣发套件集中保存在这里（文件保留 24 小时）。</p>
      {error && <p className="composer-error" role="alert">{error}</p>}
      {copyFeedback && <p className="works-copy-toast" role="status">{copyFeedback}</p>}
      {loading ? (
        <p style={{ textAlign: "center", color: "#666", padding: "24px 0" }}>正在加载作品库…</p>
      ) : works.length > 0 ? (
        <div className="works-list">
          {works.map((work) => {
            const isHighlighted = work.id === highlightWorkId;
            const isMultiSlice = works.filter((item) => item.jobId === work.jobId).length > 1;
            const sliceIndex = works.filter((item) => item.jobId === work.jobId).findIndex((item) => item.id === work.id) + 1;
            const totalSlices = works.filter((item) => item.jobId === work.jobId).length;
            const titleLabel = isMultiSlice ? `分镜切片 ${sliceIndex}/${totalSlices}` : "商业视频成片 (MP4)";
            const filename = isMultiSlice
              ? `jansee-slice-${String(sliceIndex).padStart(2, "0")}-of-${totalSlices}.mp4`
              : `jansee-${work.id}.mp4`;
            const publishKit = resolvePublishForWork(work, conversations);

            return (
              <WorkDeliveryCardItem
                key={work.id}
                work={work}
                isHighlighted={isHighlighted}
                titleLabel={titleLabel}
                filename={filename}
                publishKit={publishKit}
                activePlayWorkId={activePlayWorkId}
                setActivePlayWorkId={setActivePlayWorkId}
                videoRefs={videoRefs}
                cardContainerRefs={cardContainerRefs}
                coverDataUrls={coverDataUrls}
                setCoverDataUrls={setCoverDataUrls}
                onRequestDownload={onRequestDownload}
                setCopyFeedback={setCopyFeedback}
                copiedKey={copiedKey}
                copyText={copyText}
                setPreviewingCoverUrl={setPreviewingCoverUrl}
                downloadCover={downloadCover}
              />
            );
          })}
        </div>
      ) : (
        <div className="panel-empty-state">
          <span className="panel-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 10 6-10 6z" /></svg></span>
          <strong>暂无成片</strong>
          <span>你还没有制作成片，快去让简兮导演为你制作第一支商业视频吧！</span>
        </div>
      )}
      {previewingCoverUrl && (
        <div
          className="payment-dialog-overlay"
          onClick={() => setPreviewingCoverUrl(null)}
          role="dialog"
          aria-modal="true"
          aria-label="查看封面大图"
        >
          <div
            style={{
              position: "relative",
              maxWidth: "min(90vw, 420px)",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              background: "#141517",
              borderRadius: "14px",
              padding: "16px",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.4)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="关闭预览"
              onClick={() => setPreviewingCoverUrl(null)}
              style={{
                position: "absolute",
                top: "22px",
                right: "22px",
                width: "28px",
                height: "28px",
                padding: 0,
                display: "grid",
                placeItems: "center",
                background: "transparent",
                color: "#ffffff",
                border: "none",
                fontSize: "24px",
                lineHeight: 1,
                cursor: "pointer",
                zIndex: 10,
                textShadow: "0 1px 4px rgba(0,0,0,0.8)",
              }}
            >
              ×
            </button>
            <img
              src={previewingCoverUrl}
              alt="封面预览大图"
              style={{
                maxWidth: "100%",
                maxHeight: "75vh",
                objectFit: "contain",
                borderRadius: "8px",
              }}
            />
          </div>
        </div>
      )}
      <button className="panel-primary-action" type="button" onClick={onNew}>开始新创作</button>
    </div>
  );
}
