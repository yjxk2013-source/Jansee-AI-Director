import {
  useRef,
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
  isListening: boolean;
  listeningRemainingSeconds: number;
  toggleVoiceInput: () => void;
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
  isListening,
  listeningRemainingSeconds,
  toggleVoiceInput,
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
              className="action-btn upload-btn"
              type="button"
              onClick={() => setIsUploadMenuOpen((prev) => !prev)}
              aria-label="添加制作素材"
              aria-expanded={isUploadMenuOpen}
              aria-haspopup="menu"
            >
              ＋
            </button>
            {isUploadMenuOpen && (
              <div className="upload-menu" role="menu">
                <button
                  type="button"
                  className="upload-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsUploadMenuOpen(false);
                    imageInputRef.current?.click();
                  }}
                >
                  图片素材
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
                  视频素材
                </button>
                <button
                  type="button"
                  className="upload-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setIsUploadMenuOpen(false);
                    cameraCaptureInputRef.current?.click();
                  }}
                >
                  拍照或拍摄
                </button>
              </div>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="composer-textarea"
            placeholder={activePlaceholder}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${event.target.scrollHeight}px`;
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            aria-label="输入创作指令或需求"
          />
          <div className="composer-actions">
            <button
              type="button"
              className={`action-btn voice-btn ${isListening ? "is-listening" : ""}`}
              onClick={toggleVoiceInput}
              aria-label={
                isListening
                  ? `正在录音，剩余 ${listeningRemainingSeconds} 秒，点击完成录音`
                  : "语音输入，将说话转为文字"
              }
              aria-pressed={isListening}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
            <button
              className="action-btn send-btn"
              type="submit"
              disabled={isDirectorThinking || isAnyFileUploading}
              aria-label={isDirectorThinking ? "导演构思中" : "发送"}
            >
              {isDirectorThinking ? (
                <span className="director-pulse-icon" aria-hidden="true" />
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </form>
    </footer>
  );
}
