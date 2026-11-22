import {
  useState,
  useRef,
  useEffect,
  type Dispatch,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  type TouchEvent,
} from "react";
import { ScenePicker } from "./ScenePicker.js";
import { fileKey, mediaKind } from "../../utils/clientPlatform.js";

interface ComposerDockProps {
  creationScene: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  setCreationScene: Dispatch<SetStateAction<"online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut">>;
  guestTip: string;
  isGuestViewer: boolean;
  guideGuestToRegister: (sceneName: string) => void;
  onSceneChange: () => void;
  submitMessage: (event?: FormEvent) => void | Promise<void>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  videoInputRef: RefObject<HTMLInputElement | null>;
  cameraCaptureInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  addFiles: (files: FileList | File[]) => void;
  files: File[];
  previewUrls: string[];
  uploadProgresses: Record<string, number>;
  reorderFile: (fromIndex: number, toIndex: number) => void;
  startTouchAttachmentDrag: (event: TouchEvent<HTMLElement>, index: number) => void;
  moveTouchAttachmentDrag: (event: TouchEvent<HTMLElement>) => void;
  endTouchAttachmentDrag: (event: TouchEvent<HTMLElement>) => void;
  removeFile: (index: number) => void;
  fileError: string;
  isUploadMenuOpen: boolean;
  setIsUploadMenuOpen: Dispatch<SetStateAction<boolean>>;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  activePlaceholder: string;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  isDirectorThinking: boolean;
  isAnyFileUploading: boolean;
}

export function ComposerDock({
  creationScene,
  setCreationScene,
  guestTip,
  isGuestViewer,
  guideGuestToRegister,
  onSceneChange,
  submitMessage,
  imageInputRef,
  videoInputRef,
  cameraCaptureInputRef,
  textareaRef,
  addFiles,
  files,
  previewUrls,
  uploadProgresses,
  reorderFile,
  startTouchAttachmentDrag,
  moveTouchAttachmentDrag,
  endTouchAttachmentDrag,
  removeFile,
  fileError,
  isUploadMenuOpen,
  setIsUploadMenuOpen,
  draft,
  setDraft,
  activePlaceholder,
  handleKeyDown,
  isDirectorThinking,
  isAnyFileUploading,
}: ComposerDockProps) {
  const draggedFileIndexRef = useRef<number | null>(null);
  const dragCommittedRef = useRef(false);

  const clearAttachmentDragVisuals = () => {
    document.querySelectorAll(".pending-attachment.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
  };

  return (
    <footer className="composer-dock">
      <ScenePicker
        creationScene={creationScene}
        setCreationScene={setCreationScene}
        guestTip={guestTip}
        isGuestViewer={isGuestViewer}
        guideGuestToRegister={guideGuestToRegister}
        onSceneChange={onSceneChange}
      />
      <form className="composer" onSubmit={(e) => { e.preventDefault(); void submitMessage(e); }}>
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => addFiles(event.currentTarget.files ?? [])}
          aria-label="上传图片素材"
        />
        <input
          ref={videoInputRef}
          className="visually-hidden"
          type="file"
          accept="video/*"
          multiple
          onChange={(event) => addFiles(event.currentTarget.files ?? [])}
          aria-label="选择视频素材"
        />
        <input
          ref={cameraCaptureInputRef}
          className="visually-hidden"
          type="file"
          accept="image/*,video/*"
          capture="environment"
          onChange={(event) => addFiles(event.currentTarget.files ?? [])}
          aria-label="现场拍摄，可拍照或录制视频"
        />
        {files.length > 0 && (
          <div className="pending-attachments" aria-label="待发送素材">
            {files.map((file, index) => (
              <article
                className="pending-attachment"
                key={`${file.name}:${file.size}:${file.lastModified}`}
                data-file-index={index}
                draggable
                onDragStart={(event: DragEvent<HTMLElement>) => {
                  event.stopPropagation();
                  draggedFileIndexRef.current = index;
                  dragCommittedRef.current = false;
                  event.currentTarget.classList.add("is-dragging");
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-jansee-attachment", String(index));
                  event.dataTransfer.setData("text/plain", String(index));
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.dataTransfer.setDragImage(event.currentTarget, rect.width / 2, rect.height / 2);
                }}
                onDragOver={(event: DragEvent<HTMLElement>) => {
                  if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  document
                    .querySelectorAll(".pending-attachment.is-drop-target")
                    .forEach((element) => element.classList.remove("is-drop-target"));
                  if (event.currentTarget.dataset.fileIndex !== String(draggedFileIndexRef.current)) {
                    event.currentTarget.classList.add("is-drop-target");
                  }
                }}
                onDragLeave={(event: DragEvent<HTMLElement>) => {
                  event.currentTarget.classList.remove("is-drop-target");
                }}
                onDrop={(event: DragEvent<HTMLElement>) => {
                  if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!dragCommittedRef.current) {
                    dragCommittedRef.current = true;
                    const from =
                      draggedFileIndexRef.current ?? Number(event.dataTransfer.getData("application/x-jansee-attachment"));
                    if (Number.isInteger(from)) reorderFile(from, index);
                  }
                  draggedFileIndexRef.current = null;
                }}
                onDragEnd={(event: DragEvent<HTMLElement>) => {
                  event.currentTarget.classList.remove("is-dragging");
                  draggedFileIndexRef.current = null;
                  dragCommittedRef.current = false;
                  clearAttachmentDragVisuals();
                }}
                aria-label={`第 ${index + 1} 个素材，可拖拽调整顺序`}
                onTouchStart={(event: TouchEvent<HTMLElement>) => startTouchAttachmentDrag(event, index)}
                onTouchMove={moveTouchAttachmentDrag}
                onTouchEnd={endTouchAttachmentDrag}
                onTouchCancel={() => {
                  draggedFileIndexRef.current = null;
                  clearAttachmentDragVisuals();
                }}
              >
                <div className="pending-preview">
                  {mediaKind(file) === "image" ? (
                    <img
                      src={previewUrls[index]}
                      alt={`素材预览：${file.name}`}
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <video
                      src={previewUrls[index]}
                      muted
                      playsInline
                      preload="metadata"
                      aria-label={`视频预览：${file.name}`}
                      draggable={false}
                    />
                  )}
                  <span className="pending-order">{index + 1}</span>
                  {(() => {
                    const progress = uploadProgresses[fileKey(file)];
                    if (typeof progress !== "number" || progress >= 100) return null;
                    return (
                      <div className="attachment-upload-ring-layer" aria-label={`素材上传中 ${progress}%`}>
                        <svg className="attachment-upload-ring-svg" viewBox="0 0 40 40">
                          <circle className="attachment-upload-ring-bg" cx="20" cy="20" r="16" />
                          <circle
                            className="attachment-upload-ring-progress"
                            cx="20"
                            cy="20"
                            r="16"
                            strokeDasharray="100.53"
                            strokeDashoffset={100.53 * (1 - progress / 100)}
                          />
                        </svg>
                      </div>
                    );
                  })()}
                </div>

                <div className="pending-controls">
                  <button
                    type="button"
                    className="pending-remove"
                    aria-label={`移除 ${file.name}`}
                    onClick={() => removeFile(index)}
                  >
                    ×
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        {fileError && (
          <p className="composer-error" role="alert">
            {fileError}
          </p>
        )}
        <div className="composer-main">
          <div className="upload-menu-anchor">
            <button
              className={`attach-button ${isUploadMenuOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => setIsUploadMenuOpen((prev) => !prev)}
              aria-label="添加素材"
              aria-expanded={isUploadMenuOpen}
              aria-haspopup="menu"
              title="添加素材"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
            {isUploadMenuOpen && (
              <div className="upload-menu" role="menu" aria-label="拍摄或选择素材">
                <button
                  type="button"
                  className="upload-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsUploadMenuOpen(false);
                    cameraCaptureInputRef.current?.click();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11H3V8a1 1 0 0 1 1-1Z" />
                    <circle cx="12" cy="13" r="3.5" />
                  </svg>
                  <span><strong>现场拍摄</strong><small>拍摄照片或录制视频</small></span>
                </button>
                <button
                  type="button"
                  className="upload-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsUploadMenuOpen(false);
                    imageInputRef.current?.click();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="4" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                  <span><strong>选择照片</strong><small>从手机相册或电脑选择图片</small></span>
                </button>
                <button
                  type="button"
                  className="upload-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsUploadMenuOpen(false);
                    videoInputRef.current?.click();
                  }}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="3" y="5" width="13" height="14" rx="3" />
                    <path d="m16 10 5-3v10l-5-3z" />
                  </svg>
                  <span><strong>选择视频</strong><small>从手机相册或电脑选择视频</small></span>
                </button>
              </div>
            )}
          </div>

          <textarea
            ref={textareaRef}
            id="director-message"
            className="composer-textarea"
            placeholder={activePlaceholder}
            value={draft}
            maxLength={2000}
            onChange={(event) => {
              setDraft(event.target.value);
              event.currentTarget.style.height = "auto";
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            aria-label="输入创作指令或需求"
          />

          <div className="composer-actions">
            <button
              className={`send-button ${isAnyFileUploading ? "is-uploading" : ""}`}
              type="submit"
              disabled={isDirectorThinking || isAnyFileUploading || (!draft.trim() && files.length === 0)}
              aria-label={isDirectorThinking ? "导演正在构思" : isAnyFileUploading ? "素材上传中" : "发送消息"}
              title={isDirectorThinking ? "导演正在构思" : isAnyFileUploading ? "素材上传中，上传完成后可发送" : "发送"}
            >
              {isDirectorThinking ? (
                <span className="send-loading" aria-hidden="true">···</span>
              ) : isAnyFileUploading ? (
                <div className="send-button-uploading-indicator" aria-hidden="true">
                  <svg className="send-upload-ring-svg" viewBox="0 0 24 24">
                    <circle className="send-upload-ring-bg" cx="12" cy="12" r="9" />
                    <circle className="send-upload-ring-spin" cx="12" cy="12" r="9" />
                  </svg>
                </div>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 19V5m-6 6 6-6 6 6" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </form>
    </footer>
  );
}
