import { useEffect, useRef, useState } from "react";
import type { JobDeliveryVideoPlayerProps } from "../../types/client";

export function JobDeliveryVideoPlayer({ workId, activeId, onPlay, onPause }: JobDeliveryVideoPlayerProps) {
  const isPlaying = activeId === workId;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);
  const [isActuallyPlaying, setIsActuallyPlaying] = useState(false);

  // 滑走（移出视口可见比例 < 25%）自动停止播放，杜绝后台继续发声，节省系统资源
  useEffect(() => {
    if (!isPlaying) return;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry || !entry.isIntersecting || entry.intersectionRatio < 0.25) {
          if (videoRef.current && !videoRef.current.paused) {
            videoRef.current.pause();
          }
          onPause();
        }
      },
      { threshold: [0, 0.25, 0.5] }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [isPlaying, onPause]);

  // 同步外部 activeId 变化：当其他视频被激活或被外部重置时，同步暂停当前视频
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      void video.play().then(() => {
        setIsActuallyPlaying(true);
      }).catch(() => {
        // 自动播放可能受浏览器安全策略限制，捕获异常不崩溃
      });
    } else {
      if (!video.paused) {
        video.pause();
      }
      setIsActuallyPlaying(false);
    }
  }, [isPlaying]);

  const coverUrl = `/api/v1/works/${workId}/cover`;
  const streamUrl = `/api/v1/works/${workId}/stream`;

  const handleTriggerPlay = () => {
    onPlay(workId);
    if (videoRef.current) {
      void videoRef.current.play().then(() => {
        setIsActuallyPlaying(true);
      }).catch(() => {});
    }
  };

  const handleVideoEnded = () => {
    setIsActuallyPlaying(false);
    onPause();
  };

  const handleVideoPause = () => {
    setIsActuallyPlaying(false);
    onPause();
  };

  return (
    <div ref={containerRef} className="job-delivery-player-box">
      {/* 预加载元数据，保持在 DOM 中，实现秒开无黑屏缓冲 */}
      <video
        ref={videoRef}
        className="job-delivery-video"
        src={streamUrl}
        poster={coverFailed ? undefined : coverUrl}
        controls={isPlaying && isActuallyPlaying}
        playsInline
        preload="metadata"
        onPause={handleVideoPause}
        onEnded={handleVideoEnded}
        onPlaying={() => setIsActuallyPlaying(true)}
        aria-label="简兮成片视频播放器"
      />

      {/* 封面浮层：点击即播，播起后淡出无缝透传，完播后平滑淡入重置 */}
      <div
        className="job-delivery-cover-wrap"
        onClick={handleTriggerPlay}
        role="button"
        tabIndex={0}
        aria-label="点击播放成片"
        style={{
          opacity: isPlaying && isActuallyPlaying ? 0 : 1,
          pointerEvents: isPlaying && isActuallyPlaying ? "none" : "auto",
          transition: "opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleTriggerPlay();
          }
        }}
      >
        {coverFailed ? (
          <div className="job-delivery-cover-placeholder">
            <span>视频成片 (点击播放)</span>
          </div>
        ) : (
          <img
            src={coverUrl}
            alt="成片封面"
            loading="lazy"
            decoding="async"
            className="job-delivery-cover-img"
            onError={() => setCoverFailed(true)}
          />
        )}
        <div className="job-delivery-play-overlay">
          <span className="job-delivery-play-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  );
}
