import { useEffect, useRef, useState } from "react";
import type { JobDeliveryVideoPlayerProps } from "../../types/client";

export function JobDeliveryVideoPlayer({ workId, activeId, onPlay, onPause }: JobDeliveryVideoPlayerProps) {
  const isPlaying = activeId === workId;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);

  // 滑走（移出视口可见比例 < 25%）自动停止播放，杜绝后台继续发声
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

  const coverUrl = `/api/v1/works/${workId}/cover`;
  const streamUrl = `/api/v1/works/${workId}/stream`;

  return (
    <div ref={containerRef} className="job-delivery-player-box">
      {isPlaying ? (
        <video
          ref={videoRef}
          className="job-delivery-video"
          src={streamUrl}
          poster={coverFailed ? undefined : coverUrl}
          controls
          autoPlay
          playsInline
          preload="auto"
          onPause={onPause}
          onEnded={onPause}
          aria-label="简兮成片视频播放器"
        />
      ) : (
        <div
          className="job-delivery-cover-wrap"
          onClick={() => onPlay(workId)}
          role="button"
          tabIndex={0}
          aria-label="点击播放视频"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPlay(workId);
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
      )}
    </div>
  );
}

