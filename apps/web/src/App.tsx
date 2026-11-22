import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type {
  Attachment,
  AuthUser,
  ChatMessage,
  SavedConversation,
  WorkItem,
} from "./types/client.js";
import {
  useTimedNotice,
} from "./utils/clientPlatform.js";
import {
  clearPendingConversationIfMatches,
  loadActiveConversationId,
  loadPendingConversations,
  loadSavedConversations,
  persistSavedConversations,
  resolveActiveConversationId,
  saveActiveConversationId,
  saveConversationToServer,
  savePendingConversation,
} from "./utils/conversationStorage.js";
import { StandaloneAdminApp, isAdminHostRequested } from "./components/admin/StandaloneAdminApp.js";
import { ChatHeader } from "./components/chat/ChatHeader.js";
import { ComposerDock } from "./components/composer/ComposerDock.js";
import { WorkbenchStage } from "./components/chat/WorkbenchStage.js";
import { SidebarDrawer } from "./components/chat/SidebarDrawer.js";
import { HeaderModalContainer } from "./components/modals/HeaderModalContainer.js";
import { useJobPolling } from "./hooks/useJobPolling.js";
import { useComposerMedia } from "./hooks/useComposerMedia.js";
import { useDirectorWorkflow } from "./hooks/useDirectorWorkflow.js";

type HeaderPanelType = "works" | "login" | "recharge" | "orders" | "ledger" | "inbox" | "install" | "admin" | "admin-login" | null;

export default function App() {
  const [isStandaloneAdmin] = useState(() => isAdminHostRequested());
  if (isStandaloneAdmin) {
    return <StandaloneAdminApp />;
  }
  return <ClientApp />;
}

function ClientApp() {
  const [conversations, setConversations] = useState<SavedConversation[]>(() => loadSavedConversations());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => loadActiveConversationId());
  const [activePlayingVideoId, setActivePlayingVideoId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creationScene, setCreationScene] = useState<"online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut">("online-ecommerce");
  const activePlaceholder = "输入创作需求或想法...";

  const [guestTip, setGuestTip] = useTimedNotice();
  const [fileError, setFileError] = useTimedNotice();
  const [notice, showNotice] = useTimedNotice();
  const [isDragging, setIsDragging] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [activeHeaderPanel, setActiveHeaderPanel] = useState<HeaderPanelType>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("admin") === "1" || window.location.hash === "#admin" || window.location.pathname.replace(/\/+$/, "") === "/admin") {
        return "admin-login";
      }
    }
    return null;
  });
  const [highlightWorkId, setHighlightWorkId] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [pendingDownloadWork, setPendingDownloadWork] = useState<{ id: string; filename: string } | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [walletCredits, setWalletCredits] = useState<number | null>(null);
  const [membership, setMembership] = useState<{ tierId: string; expiresAt: string; active: boolean } | null>(null);
  const [recentWorks, setRecentWorks] = useState<WorkItem[]>([]);
  const [recentWorksLoading, setRecentWorksLoading] = useState(false);
  const [recentWorksExpanded, setRecentWorksExpanded] = useState(false);
  const [conversationsOwnerId, setConversationsOwnerId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatStageRef = useRef<HTMLElement>(null);
  const conversationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const saveAccountConversation = useCallback((conversation: SavedConversation) => {
    const operation = conversationSaveQueueRef.current.catch(() => undefined).then(async () => {
      savePendingConversation(authUser?.id ?? "unknown", conversation);
      const response = await saveConversationToServer(conversation);
      if (response && response.ok) {
        try {
          const payload = await response.json() as { conversation?: SavedConversation };
          if (payload?.conversation) {
            clearPendingConversationIfMatches(authUser?.id ?? "unknown", payload.conversation);
          }
        } catch {
          // ignore json parse error
        }
      }
    });
    conversationSaveQueueRef.current = operation;
    return operation;
  }, [authUser?.id]);

  const refreshWallet = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/billing/wallet", { credentials: "include" });
      if (!res.ok) return;
      const payload = await res.json() as { wallet?: { availableCredits: number }; membership?: { tierId: string; expiresAt: string; active: boolean } };
      if (typeof payload.wallet?.availableCredits === "number") setWalletCredits(payload.wallet.availableCredits);
      if (payload.membership) setMembership(payload.membership);
    } catch {
      // ignore network errors
    }
  }, []);

  const isGuestViewer = !authUser || authUser.isGuest === true;

  // 1. 素材选择与上传 Hook
  const {
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
    reorderFile,
    startUploads,
    startTouchAttachmentDrag,
    moveTouchAttachmentDrag,
    endTouchAttachmentDrag,
  } = useComposerMedia({
    authUser,
    onError: useCallback((msg: string) => setFileError(msg), []),
  });

  const guideGuestToRegister = useCallback((sceneName: string) => {
    setGuestTip(`请先登录后再体验${sceneName}，新用户注册即赠送免费额度`);
    setActiveHeaderPanel("login");
  }, []);

  // 3. 任务轮询 Hook
  useJobPolling({
    conversations,
    setConversations,
    saveAccountConversation,
  });

  // 4. 导演任务流与语音粗剪 Hook
  const {
    isDirectorThinking,
    submitMessage,
    toggleSpeechCutSuggestion,
    confirmSpeechCut,
  } = useDirectorWorkflow({
    draft,
    setDraft,
    files,
    setFiles,
    creationScene,
    isAnyFileUploading,
    isGuestViewer,
    authUser,
    setAuthUser,
    conversations,
    setConversations,
    activeConversationId,
    setActiveConversationId,
    conversationsOwnerId,
    uploadPromisesRef,
    videoFramesRef,
    startUploads,
    saveAccountConversation,
    refreshWallet,
    guideGuestToRegister,
    setFileError,
    textareaRef,
  });

  // 真实访客上报
  useEffect(() => {
    const storageKey = "jansee_verified_visitor_id";
    let visitorId = "";
    try {
      visitorId = window.localStorage.getItem(storageKey) || "";
      if (!visitorId) {
        visitorId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        window.localStorage.setItem(storageKey, visitorId);
      }
    } catch {
      visitorId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    let sent = false;
    const sendOnce = (verifiedBy: string) => {
      if (sent) return;
      sent = true;
      fetch("/api/v1/site-analytics/track", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: window.location.pathname,
          referrer: document.referrer || null,
          visitorId,
          verifiedBy,
        }),
      }).catch(() => undefined);
    };
    const listeners: Array<[string, (event: Event) => void]> = [
      ["mousemove", () => sendOnce("mousemove")],
      ["scroll", () => sendOnce("scroll")],
      ["touchstart", () => sendOnce("touch")],
      ["click", () => sendOnce("click")],
      ["keydown", () => sendOnce("keydown")],
    ];
    for (const [name, handler] of listeners) window.addEventListener(name, handler, { once: true, passive: true });
    return () => {
      for (const [name, handler] of listeners) window.removeEventListener(name, handler);
    };
  }, []);

  // 用户认证初始化
  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("mock=1")) {
      setAuthUser({
        id: "local-preview-user",
        email: "preview@jansee.local",
        phone: "13800000000",
        displayName: "本地测试用户",
        isGuest: false,
        createdAt: new Date().toISOString(),
      });
      setWalletCredits(1280);
      setMembership(null);
      setAuthResolved(true);
      return;
    }

    let active = true;
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { user?: AuthUser } | null) => {
        if (!active) return;
        if (payload?.user) {
          setAuthUser(payload.user);
          if (!payload.user.isGuest) void refreshWallet();
        } else {
          setAuthUser(null);
          setWalletCredits(null);
        }
      })
      .catch(() => {
        if (active) {
          setAuthUser(null);
          setWalletCredits(null);
        }
      })
      .finally(() => {
        if (active) setAuthResolved(true);
      });
    return () => {
      active = false;
    };
  }, [refreshWallet]);

  // 登录后拉取对话历史，并支持跨端（PC与移动端APP）实时多端同步对齐
  useEffect(() => {
    if (!authResolved || !authUser || authUser.isGuest) return;
    const currentUserId = authUser.id;
    let active = true;

    const syncConversations = async () => {
      try {
        const res = await fetch("/api/v1/conversations", { credentials: "include" });
        if (!res.ok) return;
        const payload = (await res.json()) as { conversations?: SavedConversation[] };
        if (!active || !payload?.conversations) return;
        const serverConversations = payload.conversations;
        const pendingConversations = loadPendingConversations(currentUserId);
        const map = new Map<string, SavedConversation>();
        serverConversations.forEach((c) => map.set(c.id, c));
        pendingConversations.forEach((c) => {
          const existing = map.get(c.id);
          if (!existing || c.updatedAt > existing.updatedAt) map.set(c.id, c);
        });
        const localSaved = loadSavedConversations();
        localSaved.forEach((localConv) => {
          const serverConv = map.get(localConv.id);
          if (!serverConv) {
            map.set(localConv.id, localConv);
            void saveAccountConversation(localConv);
          } else {
            const localHasJobs = localConv.messages.some((m) => m.jobId || m.jobWorkId);
            const serverHasJobs = serverConv.messages.some((m) => m.jobId || m.jobWorkId);
            if ((localHasJobs && !serverHasJobs) || localConv.messages.length > serverConv.messages.length || localConv.updatedAt > serverConv.updatedAt) {
              map.set(localConv.id, localConv);
              void saveAccountConversation(localConv);
            }
          }
        });
        const merged = Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);

        // 自动自愈与素材补齐：检查是否有已完成且有效的作品在当前工作台会话中遗漏挂载或素材不全
        try {
          const worksRes = await fetch("/api/v1/works", { credentials: "include" });
          if (worksRes.ok) {
            const worksData = await worksRes.json() as { works?: WorkItem[] };
            const readyWorks = (worksData.works ?? []).filter((w) => !w.expiresAt || Date.parse(w.expiresAt) > Date.now());
            if (readyWorks.length > 0) {
              const workMap = new Map<string, WorkItem>();
              readyWorks.forEach((w) => {
                workMap.set(w.id, w);
                if (w.jobId) workMap.set(w.jobId, w);
              });

              // 补齐已有消息中丢失的多素材列表（如历史恢复时仅存了单张封面）
              let hasEnriched = false;
              merged.forEach((conv) => {
                conv.messages = conv.messages.map((m) => {
                  const matchedWork = (m.jobWorkId ? workMap.get(m.jobWorkId) : null)
                    || (m.jobId ? workMap.get(m.jobId) : null);
                  if (matchedWork && matchedWork.assets && matchedWork.assets.length > 1) {
                    const currentAtts = m.attachments ?? [];
                    if (currentAtts.length <= 1) {
                      hasEnriched = true;
                      return {
                        ...m,
                        attachments: matchedWork.assets.map((a, i): Attachment => ({
                          id: `att-${matchedWork.id}-${a.assetId || i}`,
                          assetId: a.assetId,
                          name: a.name || `素材 0${i + 1}`,
                          kind: (a.kind || "image") as "image" | "video",
                          size: a.size || 0,
                          ...(a.assetId ? { previewUrl: `/api/v1/assets/${encodeURIComponent(a.assetId)}/preview` } : {}),
                        })),
                      };
                    }
                  }
                  return m;
                });
              });

              const allMessageWorkIds = new Set(merged.flatMap((c) => c.messages.map((m) => m.jobWorkId)).filter(Boolean));
              const allMessageJobIds = new Set(merged.flatMap((c) => c.messages.map((m) => m.jobId)).filter(Boolean));
              const unattachedWorks = readyWorks.filter((w) => !allMessageWorkIds.has(w.id) && !allMessageJobIds.has(w.jobId));
              if (unattachedWorks.length > 0 && merged.length > 0) {
                const targetConv = merged[0]!;
                const restoredMessages: ChatMessage[] = unattachedWorks.map((work) => {
                  const materials: Attachment[] = (work.assets && work.assets.length > 0)
                    ? work.assets.map((a, i): Attachment => ({
                      id: `att-${work.id}-${a.assetId || i}`,
                      assetId: a.assetId,
                      name: a.name || `素材 0${i + 1}`,
                      kind: (a.kind || "image") as "image" | "video",
                      size: a.size || 0,
                      ...(a.assetId ? { previewUrl: `/api/v1/assets/${encodeURIComponent(a.assetId)}/preview` } : {}),
                    }))
                    : (work.coverUrl ? [{ name: "cover.jpg", size: 0, id: `cover-${work.id}`, url: work.coverUrl, previewUrl: work.coverUrl, kind: "image" as const }] : []);

                  return {
                    id: `restored-${work.id}`,
                    role: "director",
                    text: `《${work.title || "商业成片"}》已定影交付，欢迎沉浸预览～`,
                    createdAt: Date.parse(work.createdAt) || Date.now(),
                    jobId: work.jobId,
                    jobWorkId: work.id,
                    jobStatus: "completed",
                    jobProgress: 100,
                    jobDirectorPlan: (work.directorPlan as Record<string, unknown>) ?? {
                      title: work.title || "商业成片",
                      publish: work.publish ?? {},
                    },
                    attachments: materials,
                  };
                });
                targetConv.messages = [...targetConv.messages, ...restoredMessages];
                targetConv.updatedAt = Date.now();
                hasEnriched = true;
              }

              if (hasEnriched && merged.length > 0) {
                void saveAccountConversation(merged[0]!);
              }
            }
          }
        } catch {
          // 自愈网络容错
        }

        setConversations(merged);
        persistSavedConversations(merged);
        setActiveConversationId((currentActiveId) => {
          if (currentActiveId && merged.some((c) => c.id === currentActiveId && c.messages.length > 0)) {
            return currentActiveId;
          }
          const resolved = resolveActiveConversationId(merged);
          if (resolved) return resolved;
          return merged.length > 0 && merged[0]!.messages.length > 0 ? merged[0]!.id : null;
        });
        setConversationsOwnerId(currentUserId);
      } catch {
        // 网络抖动静默重试
      }
    };

    void syncConversations();

    // 1. 移动端/桌面端窗口激活或切换回前台时，立即同步云端对话
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void syncConversations();
      }
    };
    window.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);

    // 2. 双端保活轻量同步心跳（每 4 秒静默对齐最新会话）
    const intervalTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void syncConversations();
      }
    }, 4000);

    return () => {
      active = false;
      window.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
      window.clearInterval(intervalTimer);
    };
  }, [authResolved, authUser, saveAccountConversation]);

  // 对话本地持久化
  useEffect(() => {
    persistSavedConversations(conversations);
  }, [conversations]);

  // 侧边栏打开时拉取作品
  useEffect(() => {
    if (!isSidebarOpen || !authUser) return;
    let active = true;
    setRecentWorksLoading(true);
    fetch("/api/v1/works", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { works?: WorkItem[] } | null) => {
        if (!active) return;
        const validWorks = (payload?.works ?? [])
          .filter((work) => !work.expiresAt || Date.parse(work.expiresAt) > Date.now())
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setRecentWorks(validWorks);
      })
      .catch(() => {
        if (active) setRecentWorks([]);
      })
      .finally(() => {
        if (active) setRecentWorksLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isSidebarOpen, authUser]);

  // Escape 键关闭浮层
  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSidebarOpen(false);
        setActiveHeaderPanel(null);
        setIsUploadMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, []);

  const triggerDownloadFile = useCallback((url: string, filename: string) => {
    showNotice("正在启动高清成片下载…");
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
      }, 1000);
      showNotice("高清成片已开始下载，请查看浏览器下载列表。");
    } catch {
      window.location.href = url;
    }
  }, [showNotice]);

  const handleWorkDownload = useCallback((workId: string, filename: string) => {
    if (!authUser || authUser.isGuest) {
      setPendingDownloadWork({ id: workId, filename });
      setGuestTip("视频制作完成！请登录或注册账号后保存并下载高清原片。");
      setActiveHeaderPanel("login");
      return;
    }
    void triggerDownloadFile(`/api/v1/works/${workId}/download`, filename);
  }, [authUser, triggerDownloadFile]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!isAnyFileUploading) {
        void submitMessage();
      }
    }
  }, [isAnyFileUploading, submitMessage]);

  const handleDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      return;
    }
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  }, [addFiles]);

  const startNewConversation = useCallback(() => {
    saveActiveConversationId(null);
    setActiveConversationId(null);
    setDraft("");
    setFiles([]);
    setFileError("");
    setIsSidebarOpen(false);
  }, [setFiles]);

  const activeMessages = conversations.find((c) => c.id === activeConversationId)?.messages ?? [];
  const isEmpty = activeMessages.length === 0;

  // 手机端与PC通用：每次打开或切换对话/产生新消息时，确保视图稳稳停留在最新的位置（最底部）
  useEffect(() => {
    const stage = chatStageRef.current;
    if (!stage || isEmpty) return;

    const scrollToBottomInstant = () => {
      if (!stage) return;
      stage.scrollTop = stage.scrollHeight;
    };

    // 1. 立即瞬时触底
    scrollToBottomInstant();

    // 2. 下一渲染帧触底
    const rafId = requestAnimationFrame(scrollToBottomInstant);

    // 3. 异步定时触底（等待卡片、字体与海报尺寸计算完成）
    const t1 = setTimeout(scrollToBottomInstant, 120);
    const t2 = setTimeout(scrollToBottomInstant, 380);
    const t3 = setTimeout(scrollToBottomInstant, 800);

    // 4. 利用 ResizeObserver 在首屏加载的 2.5 秒内，内容高度每撑大一次就自动稳在最新位置
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      let isInitialPeriod = true;
      const initialTimer = setTimeout(() => { isInitialPeriod = false; }, 2500);
      ro = new ResizeObserver(() => {
        if (isInitialPeriod && stage) {
          stage.scrollTop = stage.scrollHeight;
        }
      });
      ro.observe(stage);
      return () => {
        cancelAnimationFrame(rafId);
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        clearTimeout(initialTimer);
        ro?.disconnect();
      };
    }

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [activeConversationId, activeMessages.length, isEmpty]);

  return (
    <main
      className={`app-shell ${isDragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) {
          setIsDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) {
          event.preventDefault();
          setIsDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      <ChatHeader
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        authUser={authUser}
        setActiveHeaderPanel={setActiveHeaderPanel}
      />

      {notice && (
        <aside className="toast-notice" role="status" aria-live="polite">
          {notice}
        </aside>
      )}

      <WorkbenchStage
        chatStageRef={chatStageRef}
        isEmpty={isEmpty}
        messages={activeMessages}
        creationScene={creationScene}
        activePlayingVideoId={activePlayingVideoId}
        setActivePlayingVideoId={setActivePlayingVideoId}
        onRestoreDraft={(text) => setDraft(text)}
        toggleSpeechCutSuggestion={toggleSpeechCutSuggestion}
        confirmSpeechCut={confirmSpeechCut}
        onRequestDownload={handleWorkDownload}
        onShowNotice={showNotice}
      />

      <ComposerDock
        creationScene={creationScene}
        setCreationScene={setCreationScene}
        guestTip={guestTip}
        isGuestViewer={isGuestViewer}
        guideGuestToRegister={guideGuestToRegister}
        onSceneChange={() => setFileError("")}
        submitMessage={submitMessage}
        imageInputRef={imageInputRef}
        videoInputRef={videoInputRef}
        cameraCaptureInputRef={cameraCaptureInputRef}
        textareaRef={textareaRef}
        addFiles={addFiles}
        files={files}
        previewUrls={previewUrls}
        uploadProgresses={uploadProgresses}
        reorderFile={reorderFile}
        startTouchAttachmentDrag={startTouchAttachmentDrag}
        moveTouchAttachmentDrag={moveTouchAttachmentDrag}
        endTouchAttachmentDrag={endTouchAttachmentDrag}
        removeFile={removeFile}
        fileError={fileError}
        isUploadMenuOpen={isUploadMenuOpen}
        setIsUploadMenuOpen={setIsUploadMenuOpen}
        draft={draft}
        setDraft={setDraft}
        activePlaceholder={activePlaceholder}
        handleKeyDown={handleKeyDown}
        isDirectorThinking={isDirectorThinking}
        isAnyFileUploading={isAnyFileUploading}
      />

      <SidebarDrawer
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        startNewConversation={startNewConversation}
        isGuestViewer={isGuestViewer}
        walletCredits={walletCredits}
        setActiveHeaderPanel={setActiveHeaderPanel}
        authUser={authUser}
        recentWorksLoading={recentWorksLoading}
        recentWorks={recentWorks}
        recentWorksExpanded={recentWorksExpanded}
        setRecentWorksExpanded={setRecentWorksExpanded}
      />

      <HeaderModalContainer
        activeHeaderPanel={activeHeaderPanel}
        setActiveHeaderPanel={setActiveHeaderPanel}
        authUser={authUser}
        setAuthUser={setAuthUser}
        conversations={conversations}
        startNewConversation={startNewConversation}
        highlightWorkId={highlightWorkId}
        setHighlightWorkId={setHighlightWorkId}
        handleWorkDownload={handleWorkDownload}
        walletCredits={walletCredits}
        membership={membership}
        refreshWallet={refreshWallet}
        pendingDownloadWork={pendingDownloadWork}
        setPendingDownloadWork={setPendingDownloadWork}
        triggerDownloadFile={triggerDownloadFile}
      />

      {isDragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div>
            <span>＋</span>
            <strong>把素材放在这里</strong>
            <small>支持图片与视频文件</small>
          </div>
        </div>
      )}
    </main>
  );
}
