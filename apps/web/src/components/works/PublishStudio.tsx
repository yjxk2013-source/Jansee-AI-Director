import type { WorkItem } from "../../types/client.js";

export interface PublishKit {
  title?: string;
  caption?: string;
  cover_title?: string;
  pinned_comment?: string;
  post_time?: string;
}

interface PublishStudioProps {
  work: WorkItem;
  publishKit: PublishKit;
  copiedKey: string | null;
  copyText: (key: string, text: string, label: string) => void;
  coverDataUrl?: string | undefined;
  onPreviewCover: (url: string) => void;
  onDownloadCover: (work: WorkItem) => void;
}

export function PublishStudio({
  work,
  publishKit,
  copiedKey,
  copyText,
  coverDataUrl,
  onPreviewCover,
  onDownloadCover,
}: PublishStudioProps) {
  const coverUrl = coverDataUrl || work.coverUrl;

  return (
    <div className="work-publish-studio">
      <div className="work-publish-studio-top">
        <span className="work-publish-tag">短视频宣发套件</span>
        <button
          type="button"
          className="work-copy-btn work-copy-all-btn"
          onClick={() => {
            const blocks: string[] = [];
            if (publishKit.title) blocks.push(`【标题】\n${publishKit.title}`);
            if (publishKit.cover_title) blocks.push(`【建议封面标题】\n${publishKit.cover_title}`);
            if (publishKit.caption) blocks.push(`【发布文案与话题】\n${publishKit.caption}`);
            if (publishKit.pinned_comment) blocks.push(`【黄金置顶评论】\n${publishKit.pinned_comment}`);
            if (publishKit.post_time) blocks.push(`【建议发布时段】\n${publishKit.post_time}`);
            copyText(`all-${work.id}`, blocks.join("\n\n"), "完整宣发包");
          }}
        >
          {copiedKey === `all-${work.id}` ? "已复制全部" : "一键复制全部"}
        </button>
      </div>

      {publishKit.title && (
        <div className="work-publish-row">
          <div className="work-publish-label">标题</div>
          <div className="work-publish-content">
            <span className="work-publish-text">{publishKit.title}</span>
            <button
              type="button"
              className="work-copy-btn"
              onClick={() => copyText(`title-main-${work.id}`, publishKit.title!, "标题")}
            >
              {copiedKey === `title-main-${work.id}` ? "已复制" : "复制"}
            </button>
          </div>
        </div>
      )}

      <div className="work-publish-cover-card">
        <div
          className="work-publish-cover-preview"
          style={{ cursor: coverUrl ? "pointer" : "default" }}
          onClick={() => {
            if (coverUrl) onPreviewCover(coverUrl);
          }}
          title={coverUrl ? "点击查看大图" : undefined}
        >
          {coverUrl ? (
            <img
              src={coverUrl}
              alt="建议视频封面"
              className="work-cover-thumbnail"
            />
          ) : (
            <div className="work-cover-placeholder">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
              <span>视频封面</span>
            </div>
          )}
        </div>

        <div className="work-publish-cover-detail">
          <div className="work-publish-label">建议封面与标题</div>
          {publishKit.cover_title ? (
            <div className="work-publish-cover-headline">
              <span className="work-publish-cover-title-text">{publishKit.cover_title}</span>
              <button
                type="button"
                className="work-copy-btn"
                onClick={() => copyText(`title-${work.id}`, publishKit.cover_title!, "封面标题")}
              >
                {copiedKey === `title-${work.id}` ? "已复制" : "复制标题"}
              </button>
            </div>
          ) : (
            <div className="work-publish-cover-headline">
              <span className="work-publish-cover-title-text">高清视频海报封面</span>
            </div>
          )}

          <div className="work-cover-actions">
            <button
              type="button"
              className="work-cover-btn-action work-cover-btn-download"
              onClick={() => onDownloadCover(work)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
              </svg>
              下载封面图
            </button>
          </div>
        </div>
      </div>

      {publishKit.caption && (
        <div className="work-publish-row">
          <div className="work-publish-label">发布文案与话题标签</div>
          <div className="work-publish-content">
            <p className="work-publish-caption-text">{publishKit.caption}</p>
            <button
              type="button"
              className="work-copy-btn"
              onClick={() => copyText(`caption-${work.id}`, publishKit.caption!, "发布文案")}
            >
              {copiedKey === `caption-${work.id}` ? "已复制" : "复制"}
            </button>
          </div>
        </div>
      )}

      {publishKit.pinned_comment && (
        <div className="work-publish-row">
          <div className="work-publish-label">黄金置顶评论</div>
          <div className="work-publish-content">
            <span className="work-publish-text">{publishKit.pinned_comment}</span>
            <button
              type="button"
              className="work-copy-btn"
              onClick={() => copyText(`pinned-${work.id}`, publishKit.pinned_comment!, "置顶评论")}
            >
              {copiedKey === `pinned-${work.id}` ? "已复制" : "复制"}
            </button>
          </div>
        </div>
      )}

      {publishKit.post_time && (
        <div className="work-publish-time-hint">
          <span>建议发布时间：{publishKit.post_time}</span>
        </div>
      )}
    </div>
  );
}
