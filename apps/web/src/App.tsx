import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type {
  AuthUser,
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
import { useVoiceInput } from "./hooks/useVoiceInput.js";
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
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  const activePlaceholder = useMemo(() => {
    const listMap: Record<typeof creationScene, string[]> = {
      "online-ecommerce": [
        "如'突出纯棉亲肤、透气吸汗，适合夏季穿搭'",
        "如'强调轻薄便携、续航持久，适合出差通勤'",
        "如'主打控油哑光、12小时持妆，适合混油肤质'",
        "如'突出大吸力低噪音、一键自清洁，适合养宠家庭'",
        "如'强调无糖低卡、鲜果冷萃，适合健身代餐'",
      ],
      "physical-store": [
        "如'店面门头+店内环境，配温馨音乐引导到店'",
        "如'招牌招牌菜特写，突出烟火气与食材新鲜'",
        "如'展示专业理发手法与精致发型，引导预约'",
        "如'健身房器械与私教带练，强调专业与氛围'",
        "如'精品咖啡制作过程，突出惬意空间与格调'",
      ],
      "personal-creation": [
        "如'记录旅途美好瞬间，舒缓治愈感'",
        "如'生活日常vlog，温暖有电影质感'",
        "如'快节奏卡点，展现活力与热情'",
        "如'记录萌宠日常互动，温馨轻快'",
        "如'个人成长随笔，旁白深情有力量'",
      ],
      "quick-cut": [
        "如'截取3-12秒与18-32秒并合并'",
        "如'只保留3-15秒，其余删掉'",
        "如'切出前10秒和最后20秒并合成一段'",
        "如'把开头5秒和结尾10秒剪掉'",
        "如'保留中间15到45秒精彩部分'",
      ],
    };
    const list = listMap[creationScene] ?? listMap["online-ecommerce"];
    return list[placeholderIndex % list.length] ?? list[0]!;
  }, [creationScene, placeholderIndex]);

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

  // 1. 语音听写 Hook
  const { isListening, listeningRemainingSeconds, toggleVoiceInput, stopVoiceInput } = useVoiceInput({
    onAppendDraft: useCallback((text: string) => {
      setDraft((current) => `${current}${current.trim() ? " " : ""}${text}`);
    }, []),
    onError: useCallback((msg: string) => setFileError(msg), []),
  });

  // 2. 素材选择与上传 Hook
  const {
    files,
    setFiles,
    previewUrls,
    uploadProgresses,
    isAnyFileUploading,
    uploadPromisesRef,
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
    startUploads,
    saveAccountConversation,
    refreshWallet,
    guideGuestToRegister,
    setFileError,
    textareaRef,
    stopVoiceInput,
  });

  // 占位词定时轮换（每 6 秒轮换下一条）
  useEffect(() => {
    const timer = setInterval(() => {
      setPlaceholderIndex((prev) => prev + 1);
    }, 6000);
    return () => clearInterval(timer);
  }, []);

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

  // 登录后拉取对话历史
  useEffect(() => {
    if (!authResolved) return;
    const currentUserId = authUser?.id ?? "anonymous";
    let active = true;
    fetch("/api/v1/conversations", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { conversations?: SavedConversation[] } | null) => {
        if (!active || !payload?.conversations) return;
        const serverConversations = payload.conversations;
        const pendingConversations = loadPendingConversations(currentUserId);
        const map = new Map<string, SavedConversation>();
        serverConversations.forEach((c) => map.set(c.id, c));
        pendingConversations.forEach((c) => {
          const existing = map.get(c.id);
          if (!existing || c.updatedAt > existing.updatedAt) map.set(c.id, c);
        });
        const merged = Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
        setConversations(merged);
        persistSavedConversations(merged);
        setActiveConversationId(resolveActiveConversationId(merged));
        setConversationsOwnerId(currentUserId);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [authResolved, authUser?.id]);

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

  // 刷新页面或切换对话/产生新消息时，自动平滑滚动到工作台最底部（展现最新对话/成片）
  useEffect(() => {
    const stage = chatStageRef.current;
    if (!stage) return;
    stage.scrollTo({ top: stage.scrollHeight, behavior: "smooth" });
  }, [activeConversationId, activeMessages.length]);

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
        isListening={isListening}
        listeningRemainingSeconds={listeningRemainingSeconds}
        toggleVoiceInput={toggleVoiceInput}
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
