import { useState, useRef, useEffect, useCallback, type TouchEvent } from "react";
import type { AuthUser } from "../types/client.js";
import { fileKey, mediaKind } from "../utils/clientPlatform.js";

/** 快速截取本地视频第一帧，生成轻量级 DataURL 缩略图 */
export function extractVideoFrame(file: File): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve("");
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    video.src = url;

    let resolved = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    };

    const capture = () => {
      if (resolved) return;
      try {
        const canvas = document.createElement("canvas");
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        canvas.width = Math.min(vw, 480);
        canvas.height = Math.round(canvas.width * (vh / vw));
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          resolved = true;
          cleanup();
          resolve(dataUrl);
          return;
        }
      } catch (_) { }
      resolved = true;
      cleanup();
      resolve("");
    };

    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
      } catch (_) {
        capture();
      }
    };
    video.onseeked = () => capture();
    video.onerror = () => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve("");
      }
    };
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve("");
      }
    }, 2500);
  });
}

interface UseComposerMediaOptions {
  authUser: AuthUser | null;
  onError: (msg: string) => void;
}

export function useComposerMedia({ authUser, onError }: UseComposerMediaOptions) {
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const uploadPromisesRef = useRef<Map<string, Promise<string>>>(new Map());
  const videoFramesRef = useRef<Map<string, string>>(new Map());
  const [uploadProgresses, setUploadProgresses] = useState<Record<string, number>>({});

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const cameraCaptureInputRef = useRef<HTMLInputElement>(null);

  const draggedFileIndexRef = useRef<number | null>(null);
  const touchDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDragGhostRef = useRef<HTMLElement | null>(null);
  const touchDragSourceRef = useRef<HTMLElement | null>(null);
  const touchDragTargetIndexRef = useRef<number | null>(null);
  const dragCommittedRef = useRef(false);
  const touchDragStartedRef = useRef(false);

  // 同步本地预览 blob URL 并异步秒级提取视频首帧 DataURL
  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);

    files.forEach((file) => {
      if (mediaKind(file) === "video") {
        const key = fileKey(file);
        if (!videoFramesRef.current.has(key)) {
          extractVideoFrame(file).then((frame) => {
            if (frame) {
              videoFramesRef.current.set(key, frame);
            }
          }).catch(() => undefined);
        }
      }
    });

    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [files]);

  const isAnyFileUploading = files.some((file) => {
    const p = uploadProgresses[fileKey(file)];
    return typeof p === "number" && p < 100;
  });

  const startUploads = useCallback((batch: File[]) => {
    if (!batch.length) return;
    const formData = new FormData();
    batch.forEach((file) => formData.append("files", file));

    setUploadProgresses((prev) => {
      const next = { ...prev };
      batch.forEach((f) => { next[fileKey(f)] = 5; });
      return next;
    });

    const request = new Promise<Array<{ assetId: string }>>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/assets");
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.min(96, Math.max(8, Math.round((event.loaded / event.total) * 100)));
          setUploadProgresses((prev) => {
            const next = { ...prev };
            batch.forEach((f) => { next[fileKey(f)] = percent; });
            return next;
          });
        }
      };

      xhr.onload = () => {
        try {
          const payload = JSON.parse(xhr.responseText || "{}") as { assets?: Array<{ assetId: string }>; error?: { message?: string } };
          if (xhr.status >= 200 && xhr.status < 300 && payload.assets && payload.assets.length === batch.length) {
            setUploadProgresses((prev) => {
              const next = { ...prev };
              batch.forEach((f) => { next[fileKey(f)] = 100; });
              return next;
            });
            window.setTimeout(() => {
              setUploadProgresses((prev) => {
                const next = { ...prev };
                batch.forEach((f) => { delete next[fileKey(f)]; });
                return next;
              });
            }, 300);
            resolve(payload.assets);
          } else {
            reject(new Error(payload.error?.message || "素材上传失败，请检查登录状态或稍后重试。"));
          }
        } catch (e) {
          reject(e);
        }
      };

      xhr.onerror = () => {
        reject(new Error("网络异常，素材上传失败，请重试。"));
      };

      xhr.onabort = () => {
        reject(new Error("素材上传已中断，请重试。"));
      };

      xhr.send(formData);
    });

    batch.forEach((file, index) => {
      const key = fileKey(file);
      uploadPromisesRef.current.set(key, request.then((assets) => {
        const asset = assets[index];
        if (!asset) throw new Error("素材上传结果不完整，请重试。");
        return asset.assetId;
      }).catch((error) => {
        uploadPromisesRef.current.delete(key);
        setUploadProgresses((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        onError(error instanceof Error ? error.message : "素材上传失败，请重试。");
        throw error;
      }));
    });
  }, [onError]);

  const addFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;

    const firstCurrent = files.at(0);
    const currentKind = firstCurrent ? mediaKind(firstCurrent) : null;
    const incomingKinds = new Set(incoming.map(mediaKind).filter(Boolean));
    if (incomingKinds.size > 1 || (currentKind && incomingKinds.size && !incomingKinds.has(currentKind))) {
      onError("一次创作请上传同一类素材：图片或视频。");
      return;
    }

    const valid = incoming.filter((file) => {
      const kind = mediaKind(file);
      if (!kind) {
        onError("目前只支持图片和视频文件，请移除其他类型的文件。");
        return false;
      }
      const limit = kind === "image" ? 20 : 200;
      if (file.size > limit * 1024 * 1024) {
        onError(`${file.name} 超过 ${limit} MB 限制，未添加该文件。`);
        return false;
      }
      return true;
    });
    if (valid.length === incoming.length) onError("");

    const merged = [...files, ...valid];
    const unique = Array.from(new Map(
      merged.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]),
    ).values());

    const totalBytes = unique.reduce((total, file) => total + file.size, 0);
    if (totalBytes > 500 * 1024 * 1024) {
      onError("单轮素材总量不能超过 500 MB，请移除部分文件。");
      return;
    }

    if (unique.length > 9) {
      onError("一轮创作最多添加 9 个素材，超出的文件未添加。");
    }
    const accepted = unique.slice(0, 9);
    setFiles(accepted);
    if (authUser && authUser.id !== "local-preview-user") {
      const known = new Set(files.map(fileKey));
      const newlyAdded = accepted.filter((file) => !known.has(fileKey(file)) && !uploadPromisesRef.current.has(fileKey(file)));
      startUploads(newlyAdded);
    }
    if (imageInputRef.current) imageInputRef.current.value = "";
    if (videoInputRef.current) videoInputRef.current.value = "";
    if (cameraCaptureInputRef.current) cameraCaptureInputRef.current.value = "";
  }, [files, authUser, onError, startUploads]);

  const removeFile = useCallback((index: number) => {
    const file = files[index];
    if (file) {
      const key = fileKey(file);
      uploadPromisesRef.current.delete(key);
      setUploadProgresses((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    onError("");
  }, [files, onError]);

  const moveFile = useCallback((index: number, direction: -1 | 1) => {
    setFiles((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const reordered = [...current];
      const currentFile = reordered[index];
      const targetFile = reordered[target];
      if (!currentFile || !targetFile) return current;
      reordered[index] = targetFile;
      reordered[target] = currentFile;
      return reordered;
    });
  }, []);

  const reorderFile = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    setFiles((current) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(fromIndex, 1);
      if (!moved) return current;
      reordered.splice(toIndex, 0, moved);
      return reordered;
    });
  }, []);

  const clearAttachmentDragVisuals = useCallback(() => {
    touchDragGhostRef.current?.remove();
    touchDragGhostRef.current = null;
    touchDragSourceRef.current?.classList.remove("is-dragging");
    touchDragSourceRef.current = null;
    touchDragTargetIndexRef.current = null;
    touchDragStartRef.current = null;
    touchDragStartedRef.current = false;
    document.querySelectorAll(".pending-attachment.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
  }, []);

  const startTouchAttachmentDrag = useCallback((event: TouchEvent<HTMLElement>, index: number) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const touch = event.touches[0];
    if (!touch) return;
    draggedFileIndexRef.current = index;
    dragCommittedRef.current = false;
    touchDragStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchDragSourceRef.current = event.currentTarget;
    touchDragTargetIndexRef.current = index;
    touchDragStartedRef.current = false;
  }, []);

  const moveTouchAttachmentDrag = useCallback((event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    const start = touchDragStartRef.current;
    const source = touchDragSourceRef.current;
    if (!touch || !start || !source || draggedFileIndexRef.current === null) return;
    if (!touchDragStartedRef.current && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) < 7) return;
    if (!touchDragStartedRef.current) {
      touchDragStartedRef.current = true;
      source.classList.add("is-dragging");
      const ghost = source.cloneNode(true) as HTMLElement;
      ghost.classList.remove("is-dragging", "is-drop-target");
      ghost.classList.add("pending-drag-ghost");
      ghost.removeAttribute("data-file-index");
      ghost.querySelectorAll("button").forEach((button) => button.remove());
      const rect = source.getBoundingClientRect();
      ghost.style.width = rect.width + "px";
      ghost.style.height = rect.height + "px";
      document.body.appendChild(ghost);
      touchDragGhostRef.current = ghost;
    }
    event.preventDefault();
    const ghost = touchDragGhostRef.current;
    if (ghost) {
      const rect = ghost.getBoundingClientRect();
      ghost.style.left = (touch.clientX - rect.width / 2) + "px";
      ghost.style.top = (touch.clientY - rect.height / 2) + "px";
    }
    const target = document.elementFromPoint(touch.clientX, touch.clientY)?.closest<HTMLElement>(".pending-attachment[data-file-index]");
    document.querySelectorAll(".pending-attachment.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
    if (target) {
      const targetIndex = Number(target.dataset.fileIndex);
      if (Number.isInteger(targetIndex)) {
        touchDragTargetIndexRef.current = targetIndex;
        target.classList.add("is-drop-target");
      }
    }
  }, []);

  const endTouchAttachmentDrag = useCallback((_event: TouchEvent<HTMLElement>) => {
    const from = draggedFileIndexRef.current;
    const to = touchDragTargetIndexRef.current;
    if (touchDragStartedRef.current && !dragCommittedRef.current && from !== null && to !== null && Number.isInteger(to) && to >= 0) {
      dragCommittedRef.current = true;
      reorderFile(from, to);
    }
    draggedFileIndexRef.current = null;
    dragCommittedRef.current = false;
    clearAttachmentDragVisuals();
  }, [reorderFile, clearAttachmentDragVisuals]);

  return {
    files,
    setFiles,
    previewUrls,
    uploadProgresses,
    isAnyFileUploading,
    uploadPromisesRef,
    videoFramesRef,
    imageInputRef,
    videoInputRef,
    cameraCaptureInputRef,
    addFiles,
    removeFile,
    moveFile,
    reorderFile,
    startUploads,
    startTouchAttachmentDrag,
    moveTouchAttachmentDrag,
    endTouchAttachmentDrag,
  };
}

