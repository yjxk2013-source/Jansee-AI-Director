import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type TouchEvent } from "react";
import type { CreationMode } from "@jansee/contracts";
import { Filmstrip } from "./Filmstrip";
import type {
  Attachment,
  AuthUser,
  ChatMessage,
  ClientPlatform,
  JobDeliveryVideoPlayerProps,
  SavedConversation,
  WorkItem,
} from "./types/client";
import {
  ANDROID_APK_URL,
  JOB_PROGRESS_LOGS,
  NOTICE_DURATION_MS,
  detectClientPlatform,
  fileKey,
  isSpeechCutIntent,
  makeId,
  mediaKind,
  useTimedNotice,
} from "./utils/clientPlatform";
import {
  clearPendingConversationIfMatches,
  loadActiveConversationId,
  loadPendingConversations,
  loadSavedConversations,
  makeConversationTitle,
  persistSavedConversations,
  resolveActiveConversationId,
  saveActiveConversationId,
  saveConversationToServer,
  savePendingConversation,
  MAX_SAVED_CONVERSATIONS,
} from "./utils/conversationStorage";
import { TypewriterText } from "./components/common/TypewriterText";
import { JobDeliveryVideoPlayer } from "./components/video/JobDeliveryVideoPlayer";
import { StandaloneAdminApp, isAdminHostRequested } from "./components/admin/StandaloneAdminApp";
import { AdminLoginPanel } from "./components/admin/AdminLoginPanel";
import { AuthPanel } from "./components/auth/AuthPanel";
import { WorksPanel } from "./components/works/WorksPanel";
import { BillingHistoryPanel } from "./components/billing/BillingHistoryPanel";
import { RechargePanel } from "./components/billing/RechargePanel";
import { InstallAppPanel } from "./components/modals/InstallAppPanel";
import { SiteInboxPanel } from "./components/modals/SiteInboxPanel";

const AdminConsole = lazy(() => import("./AdminConsole").then((m) => ({ default: m.AdminConsole })));


type SpeechResult = { 0: { transcript: string }; isFinal: boolean };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function voiceErrorMessage(code?: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未开启，请在浏览器或系统设置里允许简兮使用麦克风后重试。";
    case "no-speech":
      return "没有听到声音，请靠近麦克风再试一次。";
    case "audio-capture":
      return "没有找到可用的麦克风，请检查设备后重试。";
    case "network":
      return "语音服务暂时连不上，请检查网络后重试。";
    default:
      return "语音输入暂不可用，请检查麦克风权限后重试。";
  }
}
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  // 安卓 APK 的 WebView 注入原生语音识别桥；浏览器端走 Web Speech API。
  JanseeVoice?: { start: () => void; cancel: () => void };
  __janseeVoiceResult?: ((text: string) => void) | undefined;
  __janseeVoiceError?: ((message: string) => void) | undefined;
};





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
  const [searchQuery, setSearchQuery] = useState("");
  const messages = conversations.find((conversation) => conversation.id === activeConversationId)?.messages ?? [];
  const [draft, setDraft] = useState("");
  const [creationScene, setCreationScene] = useState<"online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut">("online-ecommerce");
  const scenePlaceholderCandidates: Record<typeof creationScene, string[]> = {
    "online-ecommerce": [
      "说说产品卖点，想打动谁",
      "如'突出核心功能，适合年轻上班族'",
      "如'主打高性价比与日常实用场景'",
      "如'突出爆款特质，节奏明快紧凑'",
    ],
    "physical-store": [
      "聊聊店铺特色、招牌与目标客人",
      "如'突出招牌美食与舒适用餐环境'",
      "如'同城探店风格，引导周末打卡'",
      "如'突出新店开业福利与门店位置'",
    ],
    "personal-creation": [
      "描述素材故事、心情与期待画面",
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
      "如'每隔15秒切成一段，批量输出'",
      "如'多个视频直接拼接，保留原声'",
      "如'口播消语气词：呃、嗯、那个、就是'",
      "如'智能检测长停顿，消除空白卡顿'",
      "如'剔除连续重复词句，口播表达更紧凑'",
      "如'剪掉停顿与废话，保留原声'",
      "如'原声直出，本地识别并烧录字幕'",
      "如'不用AI配音，用原片自己的声音'",
      "如'保留我的口播声音，微调BGM人声避让'",
    ],
  };
  const [placeholderIndex, setPlaceholderIndex] = useState(() => Math.floor(Math.random() * 4));
  const activePlaceholder = useMemo(() => {
    const list = scenePlaceholderCandidates[creationScene] ?? [];
    return list[placeholderIndex % list.length] || "告诉简兮你想创作什么";
  }, [creationScene, placeholderIndex]);
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const uploadPromisesRef = useRef<Map<string, Promise<string>>>(new Map());
  // 素材上传进度状态：记录每个文件当前上传百分比（0-100），100 之后自动移除
  const [uploadProgresses, setUploadProgresses] = useState<Record<string, number>>({});
  const isAnyFileUploading = files.some((file) => {
    const p = uploadProgresses[fileKey(file)];
    return typeof p === "number" && p < 100;
  });
  const [fileError, setFileError] = useTimedNotice();
  // 游客点收费场景的轻提示：同样 2.5 秒自动消失，与创作框错误位分开显示。
  const [guestTip, setGuestTip] = useTimedNotice();
  // 底部思考气泡已下线，但 isDirectorThinking 仍用于提交防重入与按钮加载态。
  const [isDirectorThinking, setIsDirectorThinking] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [listeningRemainingSeconds, setListeningRemainingSeconds] = useState(60);
  const voiceTimerRef = useRef<number | null>(null);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeHeaderPanel, setActiveHeaderPanel] = useState<"works" | "login" | "recharge" | "orders" | "ledger" | "inbox" | "install" | "admin" | "admin-login" | null>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (window.location.hostname.toLowerCase() === "admin.jansee.cn" || window.location.pathname.replace(/\/+$/, "") === "/admin" || params.get("admin") === "1" || window.location.hash === "#admin") {
        return "admin-login";
      }
    }
    return null;
  });
  const [highlightWorkId, setHighlightWorkId] = useState<string | null>(null);
  const [inlinePreviewWorkIds, setInlinePreviewWorkIds] = useState<Record<string, boolean>>({});
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [pendingDownloadWork, setPendingDownloadWork] = useState<{ id: string; filename: string } | null>(null);
  const [authResolved, setAuthResolved] = useState(false);
  const [conversationsOwnerId, setConversationsOwnerId] = useState<string | null>(null);
  const [walletCredits, setWalletCredits] = useState<number | null>(null);
  const [membership, setMembership] = useState<{ tierId: string; expiresAt: string; active: boolean } | null>(null);
  const [recentWorks, setRecentWorks] = useState<WorkItem[]>([]);
  const [recentWorksLoading, setRecentWorksLoading] = useState(false);
  const [recentWorksExpanded, setRecentWorksExpanded] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const cameraCaptureInputRef = useRef<HTMLInputElement>(null);
  const draggedFileIndexRef = useRef<number | null>(null);
  const dragCommittedRef = useRef(false);
  const touchDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const touchDragSourceRef = useRef<HTMLElement | null>(null);
  const touchDragTargetIndexRef = useRef<number | null>(null);
  const touchDragGhostRef = useRef<HTMLElement | null>(null);
  const touchDragStartedRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatStageRef = useRef<HTMLElement>(null);
  const conversationSaveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const saveAccountConversation = useCallback((conversation: SavedConversation) => {
    const operation = conversationSaveQueueRef.current.catch(() => undefined).then(async () => {
      savePendingConversation(authUser?.id ?? "unknown", conversation);
      const response = await saveConversationToServer(conversation);
      if (response.ok && authUser) clearPendingConversationIfMatches(authUser.id, conversation);
      if (!response.ok) throw new Error("对话保存失败");
    });
    conversationSaveQueueRef.current = operation;
    return operation;
  }, [authUser]);

  const refreshWallet = useCallback(() => {
    return fetch("/api/v1/billing/wallet", { credentials: "include" })
      .then(async (response) => (response.ok ? (await response.json() as { wallet?: { availableCredits: number }; membership?: { tierId: string; expiresAt: string; active: boolean } | null }) : null))
      .then((payload) => {
        if (payload?.wallet?.availableCredits !== undefined) {
          setWalletCredits(payload.wallet.availableCredits);
        }
        if (payload) setMembership(payload.membership ?? null);
      })
      .catch(() => undefined);
  }, []);

  const isEmpty = messages.length === 0;
  // 游客（未登录或未绑定手机/邮箱）不展示积分与财务信息；注册/登录后才显示。
  // 认证未完成（authUser 仍为 null）时同样按游客处理，避免身份确定前闪出积分。
  const isGuestViewer = !authUser || authUser.isGuest === true;

  // 游客默认落在免费场景，避免一进来就停在锁定的带货/门店上；认证完成前不判断，避免误伤登录用户。
  useEffect(() => {
    if (authResolved && isGuestViewer && (creationScene === "online-ecommerce" || creationScene === "physical-store")) {
      setCreationScene("personal-creation");
    }
  }, [authResolved, isGuestViewer, creationScene]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (window.location.hostname.toLowerCase() === "admin.jansee.cn" || window.location.pathname.replace(/\/+$/, "") === "/admin" || params.get("admin") === "1" || window.location.hash === "#admin") return;
    const storageKey = "jansee_analytics_visitor_id";
    let visitorId = "";
    try {
      visitorId = window.localStorage.getItem(storageKey) || "";
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(visitorId)) {
        visitorId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
        window.localStorage.setItem(storageKey, visitorId);
      }
    } catch {
      visitorId = `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    }
    let sent = false;
    const sendOnce = (verifiedBy: string, dwellMs?: number) => {
      if (sent) return;
      sent = true;
      const payload = {
        visitorId,
        path: window.location.pathname,
        referrer: document.referrer,
        utmSource: params.get("utm_source") || "",
        verifiedBy,
        ...(dwellMs === undefined ? {} : { dwellMs }),
        event: "pageview",
      };
      void fetch("/api/v1/site-analytics/visit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
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
    const dwellTimer = window.setTimeout(() => sendOnce("dwell_4s", 4000), 4000);
    return () => {
      window.clearTimeout(dwellTimer);
      for (const [name, handler] of listeners) window.removeEventListener(name, handler);
    };
  }, []);

  useEffect(() => {
    // Local-only preview switch: never creates a server session or bypasses API auth.
    const previewParams = new URLSearchParams(window.location.search);
    if (import.meta.env.DEV && previewParams.get("mockLogin") === "1") {
      setAuthUser({
        id: "local-preview-user",
        phone: "13800138000",
        displayName: "Jansee Preview",
        createdAt: new Date().toISOString(),
      });
      setWalletCredits(1280);
      setMembership(null);
      setAuthResolved(true);
      return;
    }

    let active = true;
    fetch("/api/v1/auth/me", { credentials: "include" })
      .then(async (response) => {
        if (response.ok) return await response.json() as { user: AuthUser };
        // 如果未登录，自动初始化访客身份，支持无需登录直接出片
        const guestRes = await fetch("/api/v1/auth/guest", { method: "POST", credentials: "include" }).catch(() => null);
        if (guestRes && guestRes.ok) return await guestRes.json() as { user: AuthUser };
        return null;
      })
      .then((payload) => {
        if (active && payload?.user) {
          setAuthUser(payload.user);
          // 游客没有积分账户，不拉钱包，避免任何余额进入前端状态。
          if (!payload.user.isGuest) void refreshWallet();
        }
      })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthResolved(true); });
    return () => { active = false; };
  }, [refreshWallet]);

  // Authenticated conversation history belongs to the account database, never shared browser storage.
  useEffect(() => {
    if (!authResolved) return;
    let active = true;
    uploadPromisesRef.current.clear();
    setConversationsOwnerId(null);
    setConversations([]);
    setActiveConversationId(null);
    setFileError("");
    if (!authUser || authUser.id === "local-preview-user") {
      const restored = loadSavedConversations();
      setConversations(restored);
      setActiveConversationId(resolveActiveConversationId(restored));
      return () => { active = false; };
    }

    fetch("/api/v1/conversations", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { conversations?: SavedConversation[]; error?: { message?: string } };
        if (!response.ok) throw new Error(payload.error?.message || "历史对话读取失败");
        return payload.conversations ?? [];
      })
      .then((items) => {
        if (!active) return;
        const pending = loadPendingConversations(authUser.id);
        const merged = [...items, ...pending.filter((candidate) => !items.some((item) => item.id === candidate.id))]
          .map((item) => pending.find((candidate) => candidate.id === item.id && candidate.updatedAt > item.updatedAt) ?? item);
        const restored = merged.filter((item) => typeof item.id === "string" && Array.isArray(item.messages))
          .slice(0, MAX_SAVED_CONVERSATIONS);
        setConversations(restored);
        setActiveConversationId(resolveActiveConversationId(restored));
        setConversationsOwnerId(authUser.id);
      })
      .catch((error) => {
        if (active) {
          const pending = loadPendingConversations(authUser.id);
          if (pending.length) {
            setConversations(pending);
            setActiveConversationId(resolveActiveConversationId(pending));
          }
        }
        if (active) setFileError(error instanceof Error ? error.message : "历史对话暂时无法读取；本次输入仍可继续，但不会假装已保存。");
      });
    return () => { active = false; };
  }, [authResolved, authUser?.id]);

  useEffect(() => {
    if (!authResolved || authUser || conversationsOwnerId) return;
    persistSavedConversations(conversations);
  }, [authResolved, authUser, conversationsOwnerId, conversations]);

  useEffect(() => {
    if (authUser && authUser.id !== "local-preview-user" && files.length > 0) {
      const missing = files.filter((file) => !uploadPromisesRef.current.has(fileKey(file)));
      if (missing.length > 0) startUploads(missing);
    }
  }, [authUser]);

  useEffect(() => {
    const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
    if (!authResolved || !authUser || authUser.id === "local-preview-user" || conversationsOwnerId !== authUser.id || !activeConversation) return;
    const timer = window.setTimeout(() => {
      void saveAccountConversation(activeConversation)
        .catch(() => setFileError("当前对话未能保存到账号数据库，请检查网络后重试。"));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [authResolved, authUser?.id, conversationsOwnerId, conversations, activeConversationId, saveAccountConversation]);

  useEffect(() => {
    if (typeof window === "undefined" || !authResolved) return;
    const params = new URLSearchParams(window.location.search);
    const adminRequested = window.location.hostname.toLowerCase() === "admin.jansee.cn" || window.location.pathname.replace(/\/+$/, "") === "/admin" || params.get("admin") === "1" || window.location.hash === "#admin";
    if (!adminRequested) return;
    if (!authUser) {
      setActiveHeaderPanel("admin-login");
      return;
    }
    let active = true;
    fetch("/api/v1/admin/overview", { credentials: "include", cache: "no-store" })
      .then((response) => { if (active) setActiveHeaderPanel(response.ok ? "admin" : "admin-login"); })
      .catch(() => { if (active) setActiveHeaderPanel("admin-login"); });
    return () => { active = false; };
  }, [authResolved, authUser]);

  useEffect(() => {
    if (!isSidebarOpen) return;
    if (!authUser) {
      setRecentWorks([]);
      setRecentWorksLoading(false);
      return;
    }
    let active = true;
    setRecentWorksLoading(true);
    fetch("/api/v1/works", { credentials: "include" })
      .then(async (response) => response.ok ? await response.json() as { works?: WorkItem[] } : null)
      .then((payload) => {
        if (!active) return;
        const validWorks = (payload?.works ?? [])
          .filter((work) => !work.expiresAt || Date.parse(work.expiresAt) > Date.now())
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        setRecentWorks(validWorks);
      })
      .catch(() => { if (active) setRecentWorks([]); })
      .finally(() => { if (active) setRecentWorksLoading(false); });
    return () => { active = false; };
  }, [isSidebarOpen, authUser]);

  useEffect(() => {
    const stage = chatStageRef.current;
    if (!stage) return;
    stage.scrollTo({ top: stage.scrollHeight, behavior: "smooth" });
  }, [activeConversationId, messages.length]);

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviewUrls(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [files]);

  useEffect(() => {
    if (!isSidebarOpen && !activeHeaderPanel && !isUploadMenuOpen) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSidebarOpen(false);
        setActiveHeaderPanel(null);
        setIsUploadMenuOpen(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isSidebarOpen, activeHeaderPanel, isUploadMenuOpen]);

  const conversationTitle = activeConversationId
    ? conversations.find((conversation) => conversation.id === activeConversationId)?.title
    : undefined;
  const filteredConversations = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
  );

  // Keep accepted generation jobs live in the conversation until the server confirms a terminal state.
  // Job progress is narrated as chat messages: each worker stage posts one director log line,
  // and completion delivers the finished video inline in the conversation.
  useEffect(() => {
    const pending = conversations.flatMap((conversation) => conversation.messages)
      .filter((message) => message.jobId && (
        message.jobStatus !== "preview" &&
        !["completed", "failed", "cancelled"].includes(message.jobStatus ?? "")
        || (message.jobStatus === "completed" && !message.jobWorkId)
      ));
    if (!pending.length) return;
    let active = true;
    const attachWorkOutput = (jobId: string, logMessageId: string) => {
      fetch("/api/v1/works", { credentials: "include" })
        .then(async (response) => response.ok ? await response.json() as { works?: WorkItem[] } : null)
        .then((payload) => {
          if (!active || !payload) return;
          const work = (payload.works ?? []).find((item) => item.jobId === jobId);
          if (!work) return;
          // 创作者端到端极速开播：静默轻量预热视频头 512KB，用户点击秒出画面
          fetch(`/api/v1/works/${work.id}/stream`, {
            credentials: "include",
            headers: { Range: "bytes=0-524287" },
          }).catch(() => undefined);
          setConversations((current) => current.map((conversation) => ({
            ...conversation,
            messages: conversation.messages.map((item) => item.id === logMessageId ? { ...item, jobWorkId: work.id } : item),
          })));
        })
        .catch(() => undefined);
    };
    const refreshJobs = async () => {
      await Promise.all(pending.map(async (message) => {
        const jobId = message.jobId!;
        try {
          if (message.jobStatus === "completed") {
            // Completed before the output id was attached (e.g. reload); recover it.
            const completionLog = conversations.flatMap((conversation) => conversation.messages)
              .find((item) => item.jobId === jobId);
            attachWorkOutput(jobId, completionLog?.id ?? message.id);
            return;
          }
          const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
          if (!response.ok) return;
          const payload = await response.json() as { job?: { status?: string; progress?: number; errorMessage?: string | null; directorPlan?: Record<string, unknown> | null } };
          if (!active || !payload.job) return;
          const job = payload.job;
          let matchedAnchorId: string | undefined;
          setConversations((current) => {
            const conversationIndex = current.findIndex((conversation) => conversation.messages.some((item) => item.jobId === jobId));
            if (conversationIndex < 0) return current;
            const conversation = current[conversationIndex]!;
            const anchor = conversation.messages.find((item) => item.jobId === jobId);
            matchedAnchorId = anchor?.id;
            const nextStatus = job.status ?? anchor?.jobStatus;
            const nextProgress = typeof job.progress === "number" ? job.progress : anchor?.jobProgress;
            const nextError = job.errorMessage ?? undefined;
            const nextPlan = job.directorPlan ?? anchor?.jobDirectorPlan;
            const unchanged = anchor
              && anchor.jobStatus === nextStatus
              && anchor.jobProgress === nextProgress
              && anchor.jobError === nextError
              && JSON.stringify(anchor.jobDirectorPlan ?? null) === JSON.stringify(nextPlan ?? null);
            if (!nextStatus) return current;

            // 升级：采用单卡片片场分镜手稿原地演进，不再向消息流中重复追加碎屑气泡 log
            const messages = conversation.messages.map((item) => {
              if (item.jobId === jobId) return {
                ...item,
                jobStatus: nextStatus,
                ...(nextProgress !== undefined ? { jobProgress: nextProgress } : {}),
                ...(nextError !== undefined ? { jobError: nextError } : {}),
                ...(nextPlan !== undefined ? { jobDirectorPlan: nextPlan } : {}),
              };
              return item;
            });

            if (unchanged) return current;
            const nextConversation = { ...conversation, updatedAt: Date.now(), messages };
            const next = [...current];
            next[conversationIndex] = nextConversation;
            return next;
          });
          if (job.status === "completed") attachWorkOutput(jobId, matchedAnchorId || message.id);
        } catch {
          // A temporary network failure must not erase the accepted job or its last known progress.
        }
      }));
    };
    void refreshJobs();
    // 动态智能自适应轮询：当有任务处于渲染冲刺阶段（rendering / quality-check）时，将轮询频率从 2000ms 提高到 600ms，消除成片展示延迟
    const hasRenderingJob = pending.some((m) => m.jobStatus === "rendering" || m.jobStatus === "quality-check" || (typeof m.jobProgress === "number" && m.jobProgress >= 70));
    const pollInterval = hasRenderingJob ? 600 : 2_000;
    const timer = window.setInterval(() => { void refreshJobs(); }, pollInterval);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversations.map((conversation) => conversation.messages
    .filter((message) => message.jobId && message.jobStatus !== 'preview' && (!['completed', 'failed', 'cancelled'].includes(message.jobStatus ?? '') || (message.jobStatus === 'completed' && !message.jobWorkId)))
    .map((message) => `${message.jobId}:${message.jobStatus ?? ''}:${message.jobWorkId ?? ''}`).join('|'))]);

  // Speech-cut analysis is persisted server-side; this poll only refreshes the inline chat review.
  useEffect(() => {
    const pending = conversations.flatMap((conversation) => conversation.messages)
      .filter((message) => message.speechCutSessionId && message.speechCutStatus === "analyzing");
    if (!pending.length) return;
    let active = true;
    const refreshSpeechCuts = async () => {
      await Promise.all(pending.map(async (message) => {
        try {
          const response = await fetch(`/api/v1/speech-cut/${encodeURIComponent(message.speechCutSessionId!)}`, { credentials: "include" });
          if (!response.ok) return;
          const payload = await response.json() as {
            session?: {
              status: ChatMessage["speechCutStatus"];
              suggestions?: NonNullable<ChatMessage["speechCutSuggestions"]>;
              errorMessage?: string | null;
            }
          };
          if (!active || !payload.session) return;
          const session = payload.session;
          setConversations((current) => current.map((conversation) => ({
            ...conversation,
            messages: conversation.messages.map((item) => {
              if (item.id !== message.id) return item;
              const suggestions = session.suggestions ?? [];
              const selectedIds = item.speechCutSelectedIds ?? suggestions.map((suggestion) => suggestion.id);
              if (
                item.speechCutStatus === session.status &&
                JSON.stringify(item.speechCutSuggestions ?? []) === JSON.stringify(suggestions) &&
                JSON.stringify(item.speechCutSelectedIds ?? []) === JSON.stringify(selectedIds) &&
                item.speechCutError === (session.errorMessage ?? undefined)
              ) return item;
              return {
                ...item,
                ...(session.status ? { speechCutStatus: session.status } : {}),
                speechCutSuggestions: suggestions,
                speechCutSelectedIds: selectedIds,
                ...(session.errorMessage ? { speechCutError: session.errorMessage } : {}),
              };
            }),
          })));
        } catch {
          // Keep the last transcript/review state during temporary network failures.
        }
      }));
    };
    void refreshSpeechCuts();
    const timer = window.setInterval(() => { void refreshSpeechCuts(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversations.map((conversation) => conversation.messages
    .filter((message) => message.speechCutSessionId && message.speechCutStatus === 'analyzing')
    .map((message) => message.speechCutSessionId).join('|'))]);

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;

    const firstCurrent = files.at(0);
    const currentKind = firstCurrent ? mediaKind(firstCurrent) : null;
    const incomingKinds = new Set(incoming.map(mediaKind).filter(Boolean));
    if (incomingKinds.size > 1 || (currentKind && incomingKinds.size && !incomingKinds.has(currentKind))) {
      setFileError("一次创作请上传同一类素材：图片或视频。");
      return;
    }

    const valid = incoming.filter((file) => {
      const kind = mediaKind(file);
      if (!kind) {
        setFileError("目前只支持图片和视频文件，请移除其他类型的文件。");
        return false;
      }
      const limit = kind === "image" ? 20 : 200;
      if (file.size > limit * 1024 * 1024) {
        setFileError(`${file.name} 超过 ${limit} MB 限制，未添加该文件。`);
        return false;
      }
      return true;
    });
    if (valid.length === incoming.length) setFileError("");

    const merged = [...files, ...valid];
    const unique = Array.from(new Map(
      merged.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]),
    ).values());

    const totalBytes = unique.reduce((total, file) => total + file.size, 0);
    if (totalBytes > 500 * 1024 * 1024) {
      setFileError("\u5355\u8f6e\u7d20\u6750\u603b\u91cf\u4e0d\u80fd\u8d85\u8fc7 500 MB\uff0c\u8bf7\u79fb\u9664\u90e8\u5206\u6587\u4ef6\u3002");
      return;
    }

    if (unique.length > 9) {
      setFileError("一轮创作最多添加 9 个素材，超出的文件未添加。");
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
  }

  function startUploads(batch: File[]) {
    if (!batch.length) return;
    const formData = new FormData();
    batch.forEach((file) => formData.append("files", file));

    // 初始上传进度设为 5%，显示顺时针进度环
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
            // 上传成功：冲刺到 100%，并在短暂动效后自动消除进度环
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
        setFileError(error instanceof Error ? error.message : "素材上传失败，请重试。");
        throw error;
      }));
    });
  }

  // 优雅的通用文件下载（支持同源与跨域 CDN，避免直接在浏览器中跳转播放）
  async function downloadBlobFromUrl(url: string, filename: string) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("下载请求失败");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch {
      // 网络或 CORS 回退：直接 a.click
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  }

  function triggerDownloadFile(workId: string, filename: string) {
    void downloadBlobFromUrl(`/api/v1/works/${encodeURIComponent(workId)}/stream?download=1`, filename);
  }

  // 游客点收费场景：不切换场景，弹登录面板 + 2.5 秒自动消失的轻提示。
  function guideGuestToRegister(sceneLabel: string) {
    setGuestTip(`${sceneLabel}为注册用户的付费功能，请先登录或注册`);
    setActiveHeaderPanel("login");
  }

  function handleWorkDownload(workId: string, filename: string) {
    if (!authUser || authUser.isGuest) {
      setPendingDownloadWork({ id: workId, filename });
      setGuestTip("视频制作完成！请登录或注册账号后保存并下载高清原片。");
      setActiveHeaderPanel("login");
      return;
    }
    triggerDownloadFile(workId, filename);
  }

  function removeFile(index: number) {
    const removed = files[index];
    if (removed) {
      const key = fileKey(removed);
      uploadPromisesRef.current.delete(key);
      setUploadProgresses((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setFileError("");
  }

  function moveFile(index: number, direction: -1 | 1) {
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
  }

  function reorderFile(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return;
    setFiles((current) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(fromIndex, 1);
      if (!moved) return current;
      reordered.splice(toIndex, 0, moved);
      return reordered;
    });
  }

  function clearAttachmentDragVisuals() {
    touchDragGhostRef.current?.remove();
    touchDragGhostRef.current = null;
    touchDragSourceRef.current?.classList.remove("is-dragging");
    touchDragSourceRef.current = null;
    touchDragTargetIndexRef.current = null;
    touchDragStartRef.current = null;
    touchDragStartedRef.current = false;
    document.querySelectorAll(".pending-attachment.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
  }

  function startTouchAttachmentDrag(event: TouchEvent<HTMLElement>, index: number) {
    if ((event.target as HTMLElement).closest("button")) return;
    const touch = event.touches[0];
    if (!touch) return;
    draggedFileIndexRef.current = index;
    dragCommittedRef.current = false;
    touchDragStartRef.current = { x: touch.clientX, y: touch.clientY };
    touchDragSourceRef.current = event.currentTarget;
    touchDragTargetIndexRef.current = index;
    touchDragStartedRef.current = false;
  }

  function moveTouchAttachmentDrag(event: TouchEvent<HTMLElement>) {
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
  }

  function endTouchAttachmentDrag(_event: TouchEvent<HTMLElement>) {
    const from = draggedFileIndexRef.current;
    const to = touchDragTargetIndexRef.current;
    if (touchDragStartedRef.current && !dragCommittedRef.current && from !== null && to !== null && Number.isInteger(to) && to >= 0) {
      dragCommittedRef.current = true;
      reorderFile(from, to);
    }
    draggedFileIndexRef.current = null;
    dragCommittedRef.current = false;
    clearAttachmentDragVisuals();
  }

  async function submitMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const trimmed = draft.trim();
    if (isDirectorThinking) return;
    if (isAnyFileUploading) {
      setFileError("素材还在上传中，请稍候片刻…");
      return;
    }
    // 服务端底线拦截之外的前端引导：游客即使停在默认的收费场景，也在发请求前就引导注册。
    if (isGuestViewer && (creationScene === "online-ecommerce" || creationScene === "physical-store")) {
      guideGuestToRegister(creationScene === "online-ecommerce" ? "带货视频" : "门店获客");
      return;
    }
    if (!files.length) { setFileError("请先上传图片或视频素材，导演才能结合实际素材制定方案。"); return; }
    if (!trimmed) { setFileError("请告诉导演你希望这支视频呈现什么内容或效果。"); return; }
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; setIsListening(false); }
    const firstFile = files[0]; if (!firstFile) return;
    const kind = mediaKind(firstFile); if (!kind) return;
    const mode: CreationMode = kind === "image" ? "image-film" : files.length === 1 ? "video-dub" : "storyboard";
    const directorPrompt = trimmed;
    if (mode === "storyboard" && files.length < 2) { setFileError("分镜成片至少需要两个视频素材。"); return; }
    let currentAuthUser = authUser;
    if (!currentAuthUser) {
      try {
        const guestRes = await fetch("/api/v1/auth/guest", { method: "POST", credentials: "include" });
        if (guestRes.ok) {
          const payload = await guestRes.json() as { user: AuthUser };
          currentAuthUser = payload.user;
          setAuthUser(payload.user);
          // 游客不拉钱包，避免游客态出现积分余额。
        }
      } catch {
        // 网络异常降级处理
      }
    }
    if (!currentAuthUser) {
      setFileError("网络连接异常，请刷新后重试。");
      return;
    }
    if (currentAuthUser.id !== "local-preview-user" && conversationsOwnerId && conversationsOwnerId !== currentAuthUser.id) {
      setFileError("正在读取历史对话，请稍后再提交，避免覆盖未加载的记录。");
      return;
    }
    const submittingFiles = [...files];
    const submittingDraft = trimmed;
    const submittingMode = mode;
    const submittingScene = creationScene;
    const submittingPrompt = directorPrompt;
    setIsDirectorThinking(true); setFileError("");
    const conversationId = activeConversationId ?? (currentAuthUser.id !== "local-preview-user" ? crypto.randomUUID() : makeId());
    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text: submittingDraft,
      creationScene: submittingScene,
      creationMode: submittingMode,
      // 带本地 blob 预览：工作台胶片面板直接渲染用户上传的素材缩略图，
      // 不依赖后端下载路由（当前无 /api/assets/:id/download），刷新后失效可接受（仅制作中展示）。
      attachments: submittingFiles.map((file) => ({ name: file.name, kind: mediaKind(file)!, size: file.size, previewUrl: URL.createObjectURL(file) })),
      // 用户一点创作就把这条消息当工作台载体：胶片面板见 isWorkbench 立即弹出，
      // 不等 LLM 规划（jobId 要 20-34 秒后才有）。规划完成后把 jobId/进度挂到这条消息继续演进。
      isWorkbench: true,
    };
    const baseMessages = [...messages, userMessage];
    const baseConversation: SavedConversation = {
      id: conversationId,
      title: makeConversationTitle(baseMessages),
      updatedAt: Date.now(),
      messages: baseMessages,
    };
    setConversations((current) => [baseConversation, ...current.filter((conversation) => conversation.id !== conversationId)].slice(0, MAX_SAVED_CONVERSATIONS));
    saveActiveConversationId(conversationId);
    setActiveConversationId(conversationId);
    // 素材已在选择时开始上传；聊天里先给用户即时回应，再等收齐素材、出方案、直接开做。
    const ackMessage: ChatMessage = {
      id: makeId(),
      role: "director",
      text: currentAuthUser.id === "local-preview-user"
        ? "收到，我先整理你的需求，给你排一版导演方案。"
        : "素材我已经收下了。我先把你的需求排成制作方案，然后直接开始做，过程随时跟你汇报。",
    };
    // The new workbench is the first execution surface; do not inject the legacy
    // "先整理需求/排导演方案" acknowledgement into the conversation.
    const messagesWithAck = baseMessages;
    const conversationWithAck: SavedConversation = {
      ...baseConversation,
      title: makeConversationTitle(messagesWithAck),
      messages: messagesWithAck,
    };
    setConversations((current) => [conversationWithAck, ...current.filter((conversation) => conversation.id !== conversationId)].slice(0, MAX_SAVED_CONVERSATIONS));
    // 立即清空输入框并释放交互锁，让用户 0.1 秒内感受到系统响应；后续规划与入队全部在后台异步完成。
    setDraft("");
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // 提前释放输入锁：输入区已清空、素材已清空，不存在重复提交风险；
    // 后台规划/入队期间，底部思考动效由 intermediateTimer 和 job status 驱动，无需 isDirectorThinking。
    setIsDirectorThinking(false);

    // 仅在调用 LLM 导演（三大生成场景）时展示多角色思考过程；纯一句话剪辑直通本地数控，无需漫长思考
    const isPureCut = submittingScene === "quick-cut";
    const isFreeScene = submittingScene === "personal-creation" || submittingScene === "quick-cut";
    let intermediateFinished = isPureCut;
    const intermediateTimer1 = isPureCut ? 0 : window.setTimeout(() => {
      if (intermediateFinished) return;
      setConversations((current) => current.map((c) => {
        if (c.id !== conversationId) return c;
        if (c.messages.some((m) => m.id === `ack-art-${conversationId}`)) return c;
        const msg: ChatMessage = {
          id: `ack-art-${conversationId}`,
          role: "director",
          speaker: "简兮美术师",
          text: "素材画幅与分辨率解析完成，正在提取构图主体与光影特征点…",
        };
        return { ...c, messages: [...c.messages, msg] };
      }));
    }, 800);

    const intermediateTimer2 = isPureCut ? 0 : window.setTimeout(() => {
      if (intermediateFinished) return;
      setConversations((current) => current.map((c) => {
        if (c.id !== conversationId) return c;
        if (c.messages.some((m) => m.id === `ack-script-${conversationId}`)) return c;
        const msg: ChatMessage = {
          id: `ack-script-${conversationId}`,
          role: "director",
          speaker: "简兮编导",
          text: "正在结合短视频黄金前3秒节奏与场景调性，梳理分镜台词与情绪曲线…",
        };
        return { ...c, messages: [...c.messages, msg] };
      }));
    }, 1800);

    try {
      if (currentAuthUser.id !== "local-preview-user") {
        void saveAccountConversation(conversationWithAck).catch((err) => {
          console.warn("[conversation-save] 创作需求静默存盘失败，已本地兜底，不阻断出片:", err);
        });
        const ensureUploads = async (filesToUpload: File[]) => {
          const missing = filesToUpload.filter((file) => !uploadPromisesRef.current.has(fileKey(file)));
          if (missing.length > 0) {
            startUploads(missing);
          }
          return await Promise.all(filesToUpload.map(async (file) => {
            const pending = uploadPromisesRef.current.get(fileKey(file));
            if (!pending) throw new Error("素材上传未就绪，请重新选择文件。");
            return await pending;
          }));
        };

        let assetIds: string[];
        try {
          assetIds = await ensureUploads(submittingFiles);
        } catch (uploadErr) {
          throw new Error(uploadErr instanceof Error ? uploadErr.message : "素材上传还没有完成，请在输入框确认素材状态后重新发送。");
        }
        // 保留第 986 行已生成的本地 blob 预览，只补 assetId；重复 createObjectURL 会泄漏内存。
        // 历史消息（刷新后恢复）没有 blob，则用 assetId 兜底（后端路由就绪后可显示）。
        let attachments: Attachment[] = submittingFiles.map((file, index) => {
          const prior = (messagesWithAck.find((message) => message.id === userMessage.id)?.attachments?.[index]) as Record<string, unknown> | undefined;
          return {
            name: file.name,
            kind: mediaKind(file)!,
            size: file.size,
            assetId: assetIds[index]!,
            ...(typeof prior?.previewUrl === "string" ? { previewUrl: prior.previewUrl } : {}),
          };
        });
        const baseMessagesWithAssets = messagesWithAck.map((message) => message.id === userMessage.id ? { ...message, attachments } : message);
        setConversations((current) => current.map((conversation) => conversation.id === conversationId
          ? { ...conversation, updatedAt: Date.now(), messages: baseMessagesWithAssets }
          : conversation));

        if (submittingMode === "video-dub" && isSpeechCutIntent(submittingDraft)) {
          let speechResponse = await fetch("/api/v1/speech-cut/analyze", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assetId: assetIds[0] }),
          });
          let speechPayload = await speechResponse.json() as { session?: { id: string; status: string }; error?: { code?: string; message?: string } };
          if (!speechResponse.ok && speechPayload.error?.code === "ASSET_NOT_FOUND") {
            submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
            assetIds = await ensureUploads(submittingFiles);
            speechResponse = await fetch("/api/v1/speech-cut/analyze", {
              method: "POST",
              credentials: "include",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ assetId: assetIds[0] }),
            });
            speechPayload = await speechResponse.json();
          }
          if (!speechResponse.ok || !speechPayload.session) throw new Error(speechPayload.error?.message || "语音分析任务创建失败，请稍后重试。");
          submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
          const directorMessage: ChatMessage = {
            id: makeId(),
            role: "director",
            text: "收到。我会先识别原始人声、口头语和明显停顿，再把剪辑建议交给你确认。未经你确认，我不会删除任何台词。",
            plan: ["语音识别与停顿分析", "逐条展示可删除建议", "你确认后才开始精剪，原始人声保持不变"],
            speechCutSessionId: speechPayload.session.id,
            speechCutStatus: "analyzing",
          };
          const nextMessages = [...baseMessagesWithAssets, directorMessage];
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : conversation));
          setDraft("");
          setFiles([]);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
          return;
        }

        let response = await fetch("/api/v1/director/plan", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: submittingMode,
            prompt: submittingPrompt,
            aspectRatio: "9:16",
            creationScene: submittingScene,
            assetIds,
          }),
        });
        type PlanPayload = {
          title: string;
          concept: string;
          scenes: Array<{ order: number; description: string }>;
          style: string;
          soundtrack: string;
          anchor?: string;
          voice_id?: string;
          bgm_emotion?: string;
        };
        let payload = await response.json() as {
          plan?: PlanPayload;
          // 批量赛马：规划接口一次 LLM 调用产出的 N 版差异化方案
          plans?: PlanPayload[];
          batch?: { total?: number };
          error?: { code?: string; message?: string };
        };

        if (!response.ok && payload.error?.code === "ASSET_NOT_FOUND") {
          submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
          assetIds = await ensureUploads(submittingFiles);
          attachments = submittingFiles.map((file, index) => {
            const prior = (messagesWithAck.find((message) => message.id === userMessage.id)?.attachments?.[index]) as Record<string, unknown> | undefined;
            return {
              name: file.name,
              kind: mediaKind(file)!,
              size: file.size,
              assetId: assetIds[index]!,
              ...(typeof prior?.previewUrl === "string" ? { previewUrl: prior.previewUrl } : {}),
            };
          });
          response = await fetch("/api/v1/director/plan", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: submittingMode,
              prompt: submittingPrompt,
              aspectRatio: "9:16",
              creationScene: submittingScene,
              assetIds,
            }),
          });
          payload = await response.json();
        }

        if (!response.ok || !payload.plan) throw new Error(payload.error?.message || "导演服务暂时不可用，请稍后重试。");
        const plan = payload.plan;
        // 批量赛马新链路：规划接口一次调用返回 N 版方案；plans 缺失时回退单版（兼容旧服务端）。
        const plans = (payload.plans && payload.plans.length ? payload.plans : [plan]) as PlanPayload[];
        // 多版成片（批量赛马）：版数来自服务端对用户文字/语音输入的解析，非滑动条
        const batchTotal = Math.max(1, Math.min(10, Math.floor(payload.batch?.total ?? 1)));
        // 方案确认环节已下线：方案生成后直接创建制作任务，进度像聊天一样逐条汇报。
        let jobResponse = await fetch("/api/v1/jobs", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: submittingMode,
            prompt: submittingPrompt,
            aspectRatio: "9:16",
            creationScene: submittingScene,
            assetIds,
            directorPlan: plan as Record<string, unknown>,
            ...(batchTotal > 1 && plans.length > 1 ? { directorPlans: plans } : {}),
            idempotencyKey: crypto.randomUUID(),
            ...(batchTotal > 1 ? { versions: batchTotal } : {}),
          }),
        });
        type CreatedJob = { id: string; status: string; progress: number };
        let jobData = await jobResponse.json() as { job?: CreatedJob; jobs?: CreatedJob[]; batch?: { total?: number }; error?: { code?: string; message?: string } };

        if (!jobResponse.ok && jobData.error?.code === "ASSET_NOT_FOUND") {
          submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
          assetIds = await ensureUploads(submittingFiles);
          jobResponse = await fetch("/api/v1/jobs", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              mode: submittingMode,
              prompt: submittingPrompt,
              aspectRatio: "9:16",
              creationScene: submittingScene,
              assetIds,
              directorPlan: plan as Record<string, unknown>,
              ...(batchTotal > 1 && plans.length > 1 ? { directorPlans: plans } : {}),
              idempotencyKey: crypto.randomUUID(),
              ...(batchTotal > 1 ? { versions: batchTotal } : {}),
            }),
          });
          jobData = await jobResponse.json();
        }

        const createdJobs: CreatedJob[] = jobData.jobs ?? (jobData.job ? [jobData.job] : []);
        if (!jobResponse.ok || createdJobs.length === 0) throw new Error(jobData.error?.message || "创建制作任务失败，请稍后重试。");
        submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
        refreshWallet();
        const directorRoleLine = plan.voice_id
          ? "导演选定音色：" + plan.voice_id
          : null;
        const planSite = (plan as Record<string, unknown>).site;
        const planList = [
          ...plan.scenes.map((scene) => "镜头 " + scene.order + ((scene as Record<string, unknown>).side_typo ? " · " + (scene as Record<string, unknown>).side_typo : "") + "：" + scene.description),
          ...(typeof planSite === "string" && planSite.trim() ? ["高奢英文署名：" + planSite.trim()] : []),
          "整体风格：" + plan.style,
          "配乐方向：" + plan.soundtrack,
          ...(directorRoleLine ? [directorRoleLine] : []),
          "BGM 情绪：" + (plan.bgm_emotion || "温和垫底") + "（两段式音量 0.10/0.22 避让人声）",
          "转场效果：0.7 秒柔和叠画（宪法级过渡）",
          "成片时长：按配音实测自动对齐",
        ];
        // 工作台移交：用户消息不再显示面板（避免重复），把素材附件（含本地缩略图）
        // 复制给带 jobId 的导演消息，让进度阶段胶片区继续显示用户上传的素材。
        const baseMessagesForWorkbench = baseMessagesWithAssets.map((message) =>
          message.id === userMessage.id ? { ...message, isWorkbench: false } : message);
        const workbenchAttachments = attachments;
        if (batchTotal > 1 && createdJobs.length > 1) {
          // 批量赛马：方案一条 + 每版独立进度卡片（每条各自轮询各自的 jobId）。
          const planMessage: ChatMessage = {
            id: makeId(), role: "director",
            text: "构思完成啦！为你规划了《" + plan.title + "》：" + plan.concept + " 接下来我会为你制作 " + createdJobs.length + " 版不同风格取向的成片" + (isFreeScene ? "（免费，不消耗积分）" : "（合计消耗 " + createdJobs.length * 200 + " 积分）") + "，哪个版本最先做好就第一时间发给你～",
            createdAt: Date.now(),
            plan: planList,
          };
          const versionMessages: ChatMessage[] = createdJobs.map((job, index) => ({
            id: makeId(), role: "director",
            text: "第 " + (index + 1) + "/" + createdJobs.length + " 版已开工，做好了直接发给你。",
            createdAt: Date.now(),
            jobId: job.id,
            jobStatus: job.status,
            jobProgress: job.progress,
            jobDirectorPlan: ((plans[index] ?? plan) as unknown as Record<string, unknown>),
            creationScene: submittingScene,
            attachments: workbenchAttachments,
          }));
          const nextMessages = [...baseMessagesForWorkbench, planMessage, ...versionMessages];
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : conversation));
        } else {
          const directorMessage: ChatMessage = {
            id: makeId(), role: "director",
            text: "构思完成啦！为你规划了《" + plan.title + "》：" + plan.concept + " 我现在就带领团队全力制作，做好了直接发在对话里" + (isFreeScene ? "（本次制作免费，不消耗积分）" : "（本次制作消耗 200 积分）") + "～",
            createdAt: Date.now(),
            plan: planList,
            jobId: createdJobs[0]!.id,
            jobStatus: createdJobs[0]!.status,
            jobProgress: createdJobs[0]!.progress,
            jobDirectorPlan: plan as Record<string, unknown>,
            creationScene: submittingScene,
            attachments: workbenchAttachments,
          };
          const nextMessages = [...baseMessagesForWorkbench, directorMessage];
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : conversation));
        }
      } else {
        // Local mock mode keeps the director preview usable without a running API.
        // It intentionally stops at a plan preview and never claims a rendered video exists.
        const mockScenes = submittingFiles.map((file, index) => ({
          order: index + 1,
          description: `展示素材 ${index + 1}：${file.name}，突出主体、质感与价格信息。`,
        }));
        const mockPlan = {
          title: "本地 Mock 导演预览",
          concept: `围绕“${submittingPrompt}”组织 ${submittingFiles.length} 个镜头，先完成卖点建立，再收束到行动引导。`,
          scenes: mockScenes,
          style: "明亮、克制、突出商品质感",
          soundtrack: "轻快、低存在感，避免压过人声",
        };
        const previewMessage: ChatMessage = {
          id: makeId(), role: "director",
          text: `本地 Mock 导演预览已完成：${mockPlan.title}。当前只验证导演意图与执行计划，尚未生成真实视频。`,
          createdAt: Date.now(),
          jobId: `mock-preview-${conversationId}`,
          attachments: submittingFiles.map((file, index) => ({
            id: `mock-frame-${index}`,
            name: file.name,
            kind: mediaKind(file)!,
            size: file.size,
            previewUrl: URL.createObjectURL(file),
          })),
          plan: [
            ...mockPlan.scenes.map((scene) => `镜头 ${scene.order}：${scene.description}`),
            `整体风格：${mockPlan.style}`,
            `配乐方向：${mockPlan.soundtrack}`,
            `成片时长：按配音实测自动对齐`,
          ],
          jobStatus: "preview",
          jobProgress: 100,
          jobDirectorPlan: mockPlan,
          creationScene: submittingScene,
        };
        const nextMessages = [...messagesWithAck, previewMessage];
        setConversations((current) => current.map((conversation) => conversation.id === conversationId
          ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
          : conversation));
        setDraft(""); setFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        return;
      }
      /* Legacy API-only preview branch is unreachable in local mock mode.
      const response = await fetch("/api/v1/director/plan", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: submittingMode,
          prompt: submittingPrompt,
          aspectRatio: "9:16",
          assets: submittingFiles.map((file) => ({ name: file.name, kind: mediaKind(file)!, size: file.size })),
        }),
      });
      const payload = await response.json() as {
        plan?: {
          title: string;
          concept: string;
          scenes: Array<{ order: number; description: string }>;
          style: string;
          soundtrack: string;
        };
        error?: { message?: string };
      };
      if (!response.ok || !payload.plan) throw new Error(payload.error?.message || "导演服务暂时不可用，请稍后重试。");
      const plan = payload.plan;
      const previewSite = (plan as Record<string, unknown>).site;
      const directorMessage: ChatMessage = {
        id: makeId(), role: "director",
        text: "初步构思好啦！这版方案命名为《" + plan.title + "》：" + plan.concept + " 这是为你量身规划的预览方案；登录后就可以正式进入成片流水线制作啦～",
        createdAt: Date.now(),
        plan: [
          ...plan.scenes.map((scene) => "镜头 " + scene.order + ((scene as Record<string, unknown>).side_typo ? " · " + (scene as Record<string, unknown>).side_typo : "") + "：" + scene.description),
          ...(typeof previewSite === "string" && previewSite.trim() ? ["高奢英文署名：" + previewSite.trim()] : []),
          "整体风格：" + plan.style,
          "配乐方向：" + plan.soundtrack,
          "成片时长：按配音实测自动对齐",
        ],
      };
      const nextMessages = [...messagesWithAck, directorMessage];
      setConversations((current) => current.map((conversation) => conversation.id === conversationId
        ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
        : conversation));
    }
    */
      setDraft(""); setFiles([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "创作过程中遇到问题，请稍后重试。";
      const isTimeout = /timed out|TIMEOUT|超时|不可用|DIRECTOR_ALL_MODELS_FAILED/i.test(rawMessage);
      const friendlyNotice = isTimeout ? "网络偶发超时，点击下方重试" : ("这次创作没能继续：" + rawMessage);
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        // 发生异常时保留工作台载体与素材，标记 jobStatus: "failed"，让失败通知与重试卡片稳定呈现
        const updatedMessages = conversation.messages.map((m) =>
          m.id === userMessage.id ? { ...m, isWorkbench: true, jobStatus: "failed", jobError: friendlyNotice } : m);
        return {
          ...conversation,
          updatedAt: Date.now(),
          messages: [
            ...updatedMessages,
            {
              id: makeId(),
              role: "director" as const,
              text: friendlyNotice,
              createdAt: Date.now(),
            },
          ],
        };
      }));
    } finally {
      intermediateFinished = true;
      window.clearTimeout(intermediateTimer1);
      window.clearTimeout(intermediateTimer2);
      setIsDirectorThinking(false);
    }
  }

  function toggleSpeechCutSuggestion(messageId: string, suggestionId: string, checked: boolean) {
    setConversations((current) => current.map((conversation) => conversation.id !== activeConversationId ? conversation : {
      ...conversation,
      messages: conversation.messages.map((message) => {
        if (message.id !== messageId) return message;
        const selected = new Set(message.speechCutSelectedIds ?? []);
        if (checked) selected.add(suggestionId);
        else selected.delete(suggestionId);
        return { ...message, speechCutSelectedIds: [...selected] };
      }),
    }));
  }

  async function confirmSpeechCut(messageId: string, sessionId: string, suggestionIds: string[]) {
    setConversations((current) => current.map((conversation) => ({
      ...conversation,
      messages: conversation.messages.map((message) => message.id === messageId ? { ...message, speechCutSubmitting: true, speechCutError: "" } : message),
    })));
    try {
      const response = await fetch(`/api/v1/speech-cut/${encodeURIComponent(sessionId)}/confirm`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suggestionIds }),
      });
      const payload = await response.json() as { jobId?: string; status?: string; error?: { message?: string } };
      if (!response.ok || !payload.jobId) throw new Error(payload.error?.message || "提交语音精剪任务失败，请稍后重试。");
      const jobId = payload.jobId;
      refreshWallet();
      setConversations((current) => current.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((message) => message.id === messageId ? {
          ...message,
          speechCutSubmitting: false,
          speechCutStatus: "consumed",
          jobId,
          jobStatus: payload.status ?? "queued",
          jobProgress: 0,
        } : message),
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交语音精剪任务失败";
      setConversations((current) => current.map((conversation) => ({
        ...conversation,
        messages: conversation.messages.map((item) => item.id === messageId ? { ...item, speechCutSubmitting: false, speechCutError: message } : item),
      })));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!isAnyFileUploading) {
        submitMessage();
      }
    }
  }

  const stopVoiceInput = useCallback(() => {
    if (voiceTimerRef.current) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    const speechWindow = window as SpeechWindow;
    speechWindow.JanseeVoice?.cancel();
    speechWindow.__janseeVoiceResult = undefined;
    speechWindow.__janseeVoiceError = undefined;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // no-op
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
    setListeningRemainingSeconds(60);
  }, []);

  function beginVoiceSession() {
    setIsListening(true);
    setListeningRemainingSeconds(60);
    if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current);
    voiceTimerRef.current = window.setInterval(() => {
      setListeningRemainingSeconds((prev) => {
        if (prev <= 1) {
          stopVoiceInput();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
  }

  function toggleVoiceInput() {
    if (recognitionRef.current || isListening) {
      stopVoiceInput();
      return;
    }

    const speechWindow = window as SpeechWindow;
    if (speechWindow.JanseeVoice) {
      setFileError("");
      speechWindow.__janseeVoiceResult = (text) => {
        const transcript = text.trim();
        if (transcript) {
          setDraft((current) => `${current}${current.trim() ? " " : ""}${transcript}`);
        }
        stopVoiceInput();
      };
      speechWindow.__janseeVoiceError = (message) => {
        stopVoiceInput();
        if (message.trim()) setFileError(message);
      };
      try {
        beginVoiceSession();
        speechWindow.JanseeVoice.start();
      } catch {
        stopVoiceInput();
        setFileError("无法启动语音输入，请检查麦克风权限。");
      }
      return;
    }

    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setFileError("当前浏览器不支持语音输入，可以点输入框后用系统键盘的麦克风按钮听写。");
      return;
    }

    setFileError("");
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    // iOS Safari 的连续识别很不稳定，单段识别更容易正常结束并回填文字。
    const isIOS = /iPad|iPhone|iPod/.test(navigator.platform)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    recognition.continuous = !isIOS;
    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) finalText += result[0].transcript;
      }
      if (finalText.trim()) {
        setDraft((current) => `${current}${current.trim() ? " " : ""}${finalText.trim()}`);
      }
    };
    recognition.onerror = (event) => {
      stopVoiceInput();
      setFileError(voiceErrorMessage(event.error));
    };
    recognition.onend = () => {
      stopVoiceInput();
    };

    try {
      recognitionRef.current = recognition;
      beginVoiceSession();
      recognition.start();
    } catch {
      stopVoiceInput();
      setFileError("无法启动语音输入，请检查浏览器麦克风权限。");
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) {
      event.preventDefault();
      event.stopPropagation();
      setIsDragging(false);
      return;
    }
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  }

  function openConversation(conversationId: string) {
    saveActiveConversationId(conversationId);
    setActiveConversationId(conversationId);
    setDraft("");
    setFiles([]);
    setFileError("");
    setIsSidebarOpen(false);
  }

  function startNewConversation() {
    saveActiveConversationId(null);
    setActiveConversationId(null);
    setDraft("");
    setFiles([]);
    setFileError("");
    setIsSidebarOpen(false);
    setActiveHeaderPanel(null);
  }

  return (
    <main
      className={`app-shell ${isDragging ? "is-dragging" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setIsDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <header className="app-header">
        <div className="header-brand-group">
          <button
            className="menu-button"
            type="button"
            aria-label="打开导航菜单"
            aria-expanded={isSidebarOpen}
            onClick={() => setIsSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <a className="brand" href="/" aria-label="JANSEE 首页">
            <img className="brand-symbol" src="/assets/jansee-mark.svg" alt="" /><img className="brand-wordmark brand-wordmark-pirulen" src="/assets/jansee-pirulen-wordmark.png" alt="JANSEE" />
          </a>
        </div>
        <div className="header-actions">
          <button
            className="login-button account-icon-button"
            type="button"
            onClick={() => setActiveHeaderPanel("login")}
            aria-label={authUser ? "我的账号" : "登录"}
            title={authUser ? "我的账号" : "登录"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5 20c.8-3.5 3.1-5.3 7-5.3s6.2 1.8 7 5.3" />
            </svg>
          </button>
        </div>
      </header>

      <section ref={chatStageRef} className={`chat-stage ${isEmpty ? "chat-stage-empty" : "chat-stage-active"}`} aria-label="简兮 AI 导演对话">
        {isEmpty ? (
          <div className="welcome-panel">
            <p className="welcome-eyebrow"><span>JANSEE</span><i />AI 智能导演</p>
            <h1>简于形<br /><span>胜于效</span></h1>
            <p className="welcome-copy">行至简处，见光影，见山海，见简兮。</p>
          </div>
        ) : (
          <div className="message-thread" aria-live="polite">
            {messages.map((message) => (
              <article className={`message-row message-${message.role}`} key={message.id}>
                <div className="message-content">
                  <div className="message-author">{message.role === "user" ? "你" : (message.speaker || "简兮导演")}</div>
                  <div className="message-bubble">
                    <p>
                      {message.role === "user" ? (
                        message.text
                      ) : (
                        <TypewriterText
                          text={message.text}
                          messageId={message.id}
                          isNew={Boolean(message.createdAt && Date.now() - message.createdAt < 30_000)}
                        />
                      )}
                    </p>


                    {/* 片场分镜手稿 / 胶片冲洗走带流 (Live Director Filmstrip)
                        点创作即弹出：用户消息带 isWorkbench（素材附件+本地缩略图），
                        规划完成后移交 jobId 给导演消息继续演进进度，全程同一个面板。 */}
                    {(message.isWorkbench || message.jobId) && message.jobStatus !== "failed" && (
                      <Filmstrip message={message} fallbackScene={creationScene} />
                    )}

                    {/* 任务失败：明确告知结果、不暴露内部错误、说明恢复方式与积分去向 */}
                    {message.jobStatus === "failed" && !message.jobWorkId && (() => {
                      const failedScene = message.creationScene ?? creationScene;
                      const isPaidFailed = failedScene === "online-ecommerce" || failedScene === "physical-store";
                      return (
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
                            <div style={{ marginTop: "10px" }}>
                              <button
                                type="button"
                                className="composer-button"
                                style={{ padding: "6px 16px", fontSize: "13px", height: "auto" }}
                                onClick={() => {
                                  if (message.text) setDraft(message.text);
                                }}
                              >
                                恢复素材与文案重试
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {message.jobWorkId ? (
                      <div className="job-delivery">
                        <JobDeliveryVideoPlayer
                          workId={message.jobWorkId}
                          activeId={activePlayingVideoId}
                          onPlay={(id) => setActivePlayingVideoId(id)}
                          onPause={() => setActivePlayingVideoId((curr) => curr === message.jobWorkId ? null : curr)}
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
                                  <p><span>发布标题：</span><strong>{coverTitle}</strong></p>
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
                                  {pinnedComment && <p><span>置顶评论：</span>{pinnedComment}</p>}
                                  {postTime && <p><span>建议发布：</span>{postTime}</p>}
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

                    {message.plan && message.speechCutSessionId && (
                      <div className="director-plan">
                        <div className="plan-heading">
                          {(message.jobDirectorPlan as Record<string, any>)?._providerTelemetry?.selectedModel
                            ? `AI 导演独家构思 · 《${String((message.jobDirectorPlan as Record<string, unknown>).title || "定制商业成片")}》`
                            : "AI 导演独家构思 · 创作方案"}
                        </div>
                        <ol>{message.plan.map((step) => <li key={step}>{step}</li>)}</ol>
                        {message.speechCutSessionId && !message.jobId && (
                          <div className="speech-cut-review" style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid rgba(0,0,0,0.10)" }}>
                            {message.speechCutStatus === "analyzing" && <p role="status" style={{ margin: 0, color: "#666" }}>正在识别原声与停顿，请稍候…</p>}
                            {message.speechCutStatus === "failed" && <p role="alert" style={{ margin: 0, color: "#a33" }}>{message.speechCutError || "语音分析失败，请重新上传素材后再试。"}</p>}
                            {message.speechCutStatus === "awaiting_confirmation" && (() => {
                              const suggestions = message.speechCutSuggestions ?? [];
                              const selectedIds = message.speechCutSelectedIds ?? [];
                              const reasonLabel = (reason: string) => reason === "pause" ? "明显停顿" : reason === "repeat" ? "重复表达" : reason === "phrase" ? "冗余语句" : "口头语";
                              return (
                                <div>
                                  <strong style={{ display: "block", marginBottom: "8px" }}>识别完成 · 请确认剪辑建议</strong>
                                  <p style={{ margin: "0 0 10px", color: "#777", fontSize: "12px" }}>默认勾选建议删除的片段；取消勾选即可保留。简兮不会擅自删除未确认内容。</p>
                                  {suggestions.length ? (
                                    <div style={{ display: "grid", gap: "6px", maxHeight: "220px", overflowY: "auto" }}>
                                      {suggestions.map((suggestion) => (
                                        <label key={suggestion.id} style={{ display: "flex", gap: "9px", alignItems: "flex-start", padding: "8px 10px", borderRadius: "7px", background: "rgba(0,0,0,0.035)", cursor: "pointer" }}>
                                          <input
                                            type="checkbox"
                                            checked={selectedIds.includes(suggestion.id)}
                                            onChange={(event) => toggleSpeechCutSuggestion(message.id, suggestion.id, event.currentTarget.checked)}
                                            style={{ marginTop: "3px" }}
                                          />
                                          <span style={{ minWidth: 0, flex: 1 }}>
                                            <span style={{ display: "block", fontSize: "13px" }}>{suggestion.word}</span>
                                            <small style={{ color: "#888" }}>{reasonLabel(suggestion.reason)} · {suggestion.start.toFixed(1)}s–{suggestion.end.toFixed(1)}s</small>
                                          </span>
                                        </label>
                                      ))}
                                    </div>
                                  ) : (
                                    <p style={{ margin: "8px 0", color: "#666", fontSize: "13px" }}>没有检测到明确需要删除的口头语或停顿，可直接确认保留原声完成包装。</p>
                                  )}
                                  <button
                                    type="button"
                                    className="panel-primary-action"
                                    style={{ marginTop: "12px", width: "auto", padding: "8px 16px", fontSize: "14px" }}
                                    disabled={message.speechCutSubmitting}
                                    onClick={() => confirmSpeechCut(message.id, message.speechCutSessionId!, selectedIds)}
                                  >
                                    {message.speechCutSubmitting ? "正在提交…" : "确认精剪并开始制作（免费）"}
                                  </button>
                                  {message.speechCutError && <p role="alert" style={{ margin: "8px 0 0", color: "#a33", fontSize: "13px" }}>{message.speechCutError}</p>}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            ))}
            {/* 底部“正在全力制作中…”思考气泡已移除：工作台面板的红点呼吸与顶部阶段状态
                已完整表达“正在工作”，再挂一条文字气泡属重复信息，增加等待焦虑。制作中
                仍由工作台面板承载，用户不会失去进度反馈。 */}
          </div>
        )}
      </section>

      <footer className="composer-dock">
        <div className="creation-scene-picker" role="group" aria-label="选择创作场景">
          {guestTip && <div className="guest-tip" role="status">{guestTip}</div>}
          <div className="creation-scene-options">
            <button
              type="button"
              className={`${creationScene === "online-ecommerce" ? "is-selected" : ""}${isGuestViewer ? " is-locked" : ""}`}
              aria-pressed={creationScene === "online-ecommerce"}
              title={isGuestViewer ? "注册登录后可使用" : undefined}
              onClick={() => {
                if (isGuestViewer) { guideGuestToRegister("带货视频"); return; }
                setCreationScene("online-ecommerce");
                setPlaceholderIndex((prev) => prev + 1);
                setFileError("");
              }}
            >
              带货视频
            </button>
            <button
              type="button"
              className={`${creationScene === "physical-store" ? "is-selected" : ""}${isGuestViewer ? " is-locked" : ""}`}
              aria-pressed={creationScene === "physical-store"}
              title={isGuestViewer ? "注册登录后可使用" : undefined}
              onClick={() => {
                if (isGuestViewer) { guideGuestToRegister("门店获客"); return; }
                setCreationScene("physical-store");
                setPlaceholderIndex((prev) => prev + 1);
                setFileError("");
              }}
            >
              门店获客
            </button>
            <button
              type="button"
              className={creationScene === "personal-creation" ? "is-selected" : ""}
              aria-pressed={creationScene === "personal-creation"}
              onClick={() => {
                setCreationScene("personal-creation");
                setPlaceholderIndex((prev) => prev + 1);
                setFileError("");
              }}
            >
              个人创作 <span className="creation-scene-free-label" title="免费" aria-label="免费">免</span>
            </button>
            <button
              type="button"
              className={creationScene === "quick-cut" ? "is-selected" : ""}
              aria-pressed={creationScene === "quick-cut"}
              onClick={() => {
                setCreationScene("quick-cut");
                setPlaceholderIndex((prev) => prev + 1);
                setFileError("");
              }}
            >
              一句话剪辑 <span className="creation-scene-free-label" title="免费" aria-label="免费">免</span>
            </button>
          </div>
        </div>
        <form className="composer" onSubmit={submitMessage}>
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
                    document.querySelectorAll(".pending-attachment.is-drop-target").forEach((element) => element.classList.remove("is-drop-target"));
                    if (event.currentTarget.dataset.fileIndex !== String(draggedFileIndexRef.current)) event.currentTarget.classList.add("is-drop-target");
                  }}
                  onDragLeave={(event: DragEvent<HTMLElement>) => { event.currentTarget.classList.remove("is-drop-target"); }}
                  onDrop={(event: DragEvent<HTMLElement>) => {
                    if (!Array.from(event.dataTransfer.types).includes("application/x-jansee-attachment")) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (!dragCommittedRef.current) {
                      dragCommittedRef.current = true;
                      const from = draggedFileIndexRef.current ?? Number(event.dataTransfer.getData("application/x-jansee-attachment"));
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
                    <button type="button" className="pending-remove" aria-label={`移除 ${file.name}`} onClick={() => removeFile(index)}>×</button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {fileError && <p className="composer-error" role="alert">{fileError}</p>}
          <div className="composer-main">
            <div className="upload-menu-anchor">
              <button
                className={`attach-button ${isUploadMenuOpen ? "is-active" : ""}`}
                type="button"
                onClick={() => setIsUploadMenuOpen((open) => !open)}
                aria-label="添加素材"
                aria-haspopup="menu"
                aria-expanded={isUploadMenuOpen}
                title="添加素材"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              {isUploadMenuOpen && (
                <div className="upload-menu" role="menu" aria-label="拍摄或选择素材">
                  <button type="button" role="menuitem" onClick={() => { setIsUploadMenuOpen(false); cameraCaptureInputRef.current?.click(); }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11H3V8a1 1 0 0 1 1-1Z" /><circle cx="12" cy="13" r="3.5" /></svg>
                    <span><strong>现场拍摄</strong><small>拍摄照片或录制视频</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setIsUploadMenuOpen(false); imageInputRef.current?.click(); }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>
                    <span><strong>选择照片</strong><small>从手机相册或电脑选择图片</small></span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setIsUploadMenuOpen(false); videoInputRef.current?.click(); }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="13" height="14" rx="3" /><path d="m16 10 5-3v10l-5-3z" /></svg>
                    <span><strong>选择视频</strong><small>从手机相册或电脑选择视频</small></span>
                  </button>
                </div>
              )}
            </div>
            <label className="visually-hidden" htmlFor="director-message">告诉简兮你想创作什么</label>
            <textarea
              ref={textareaRef}
              id="director-message"
              value={draft}
              rows={1}
              maxLength={2000}
              placeholder={activePlaceholder}
              onChange={(event) => {
                setDraft(event.target.value);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
              }}
              onKeyDown={handleKeyDown}
            />
            <div className="composer-actions">
              <button
                className={`voice-button ${isListening ? "is-listening" : ""}`}
                type="button"
                onClick={toggleVoiceInput}
                aria-label={isListening ? `停止语音输入（剩余 ${listeningRemainingSeconds} 秒）` : "语音输入"}
                title={isListening ? `停止语音输入（剩余 ${listeningRemainingSeconds} 秒）` : "语音输入"}
              >
                {isListening ? (
                  <div className="voice-countdown-indicator" aria-hidden="true">
                    <svg className="voice-countdown-svg" viewBox="0 0 52 52">
                      <circle className="voice-countdown-bg" cx="26" cy="26" r="23" />
                      <circle
                        className="voice-countdown-progress"
                        cx="26"
                        cy="26"
                        r="23"
                        strokeDasharray="144.51"
                        strokeDashoffset={144.51 * (1 - listeningRemainingSeconds / 60)}
                      />
                    </svg>
                    <span className="voice-countdown-number">{listeningRemainingSeconds}</span>
                  </div>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
                  </svg>
                )}
              </button>
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
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
                )}
              </button>
            </div>
          </div>
        </form>
      </footer>

      {isSidebarOpen && (
        <div className="navigation-layer">
          <button
            className="navigation-backdrop"
            type="button"
            aria-label="关闭导航菜单"
            onClick={() => setIsSidebarOpen(false)}
          />
          <aside className="navigation-drawer" aria-label="主导航">
            <div className="drawer-header">
              <button className="drawer-close" type="button" aria-label="关闭菜单" onClick={() => setIsSidebarOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <button className="drawer-new-chat" type="button" onClick={startNewConversation}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
              <span>新的创作</span>
            </button>
            <nav className="drawer-utility-links" aria-label={"\u5de5\u5177\u5bfc\u822a"}>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel(isGuestViewer ? "login" : "recharge"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
                <span>算力积分</span>
                {!isGuestViewer && walletCredits !== null && <span className="drawer-credit-value">{String(walletCredits)}分</span>}
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel(isGuestViewer ? "login" : "orders"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 2-1.5Z" /><path d="M14.5 3.5V8H19M8 12h8M8 16h8" /></svg>
                <span>订单记录</span>
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel(isGuestViewer ? "login" : "ledger"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5h16M4 12h16M4 18.5h16" /><circle cx="7" cy="5.5" r="1" /><circle cx="7" cy="12" r="1" /><circle cx="7" cy="18.5" r="1" /></svg>
                <span>积分明细</span>
              </button>
              <button
                className="drawer-credit-link drawer-works-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("works"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v4m4-4v4m4-4v4M8 15h8" /></svg>
                <span>{"\u6211\u7684\u4f5c\u54c1"}</span>
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("inbox"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
                <span>站内信</span>
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("install"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></svg>
                <span>安装 App</span>
              </button>
            </nav>
            <section className="drawer-recent-works" aria-label="最近作品">
              <div className="drawer-recent-works-heading">
                <span>最近作品</span>
                {authUser && <button type="button" onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("works"); }}>查看全部</button>}
              </div>
              {!authUser ? (
                <button className="drawer-recent-works-empty drawer-recent-works-login" type="button" onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("login"); }}>登录后查看最近作品</button>
              ) : recentWorksLoading ? (
                <p className="drawer-recent-works-empty">正在加载…</p>
              ) : recentWorks.length > 0 ? (
                <>
                  <div className="drawer-recent-works-list">
                    {(recentWorksExpanded ? recentWorks : recentWorks.slice(0, 3)).map((work) => {
                      const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(work.createdAt)) / 60000));
                      const remainingHours = Math.max(0, 24 - Math.floor(ageMinutes / 60));
                      const isExpiringSoon = remainingHours <= 4;
                      const ageLabel = isExpiringSoon
                        ? (remainingHours <= 1 ? "即将过期 (不足1小时)" : `即将过期 (剩 ${remainingHours} 小时)`)
                        : (ageMinutes < 1 ? "刚刚完成" : ageMinutes < 60 ? ageMinutes + " 分钟前" : Math.floor(ageMinutes / 60) + " 小时前");
                      return (
                        <button className="drawer-recent-work" type="button" key={work.id} onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("works"); }}>
                          <span className="drawer-recent-work-thumb">
                            {work.coverUrl ? (
                              <img src={work.coverUrl} alt="作品封面" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                              <video src={"/api/v1/works/" + work.id + "/stream"} muted playsInline preload="none" />
                            )}
                            <span className="drawer-recent-work-play" aria-hidden="true">▶</span>
                          </span>
                          <span className="drawer-recent-work-copy">
                            <strong>{recentWorks.filter((item) => item.jobId === work.jobId).length > 1 ? "\u89c6\u9891\u5207\u7247" : "\u77ed\u89c6\u9891\u6210\u7247"}</strong>
                            <small>{ageLabel}</small>
                          </span>
                          <span className="drawer-recent-work-chevron" aria-hidden="true">›</span>
                        </button>
                      );
                    })}
                  </div>
                  {recentWorks.length > 3 && (
                    <button
                      type="button"
                      className="drawer-recent-works-toggle"
                      onClick={() => setRecentWorksExpanded((prev) => !prev)}
                      aria-expanded={recentWorksExpanded}
                    >
                      <span>{recentWorksExpanded ? "收起" : `展开更多 (${recentWorks.length - 3})`}</span>
                      <svg
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        style={{
                          width: 12,
                          height: 12,
                          transform: recentWorksExpanded ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform .2s ease",
                        }}
                      >
                        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  )}
                </>
              ) : (
                <p className="drawer-recent-works-empty">完成一次创作，你的作品就会出现在这里</p>
              )}
              <p className="drawer-recent-works-note">成片仅保留 24 小时</p>
            </section>
          </aside>
        </div>
      )}

      {activeHeaderPanel && (
        activeHeaderPanel === "admin-login" ? (
          <AdminLoginPanel onSuccess={(user) => { setAuthUser(user); setActiveHeaderPanel("admin"); }} />
        ) : activeHeaderPanel === "admin" ? (
          <Suspense fallback={<div className="header-panel-layer"><div className="header-panel" style={{ padding: "40px", textAlign: "center", color: "var(--jansee-text-muted, #80868b)" }}>正在载入管理控制台...</div></div>}>
            <AdminConsole onClose={() => setActiveHeaderPanel(null)} />
          </Suspense>
        ) : (
          <div className="header-panel-layer">
            <button
              className="header-panel-backdrop"
              type="button"
              aria-label="关闭窗口"
              onClick={() => setActiveHeaderPanel(null)}
            />
            <section className="header-panel" role="dialog" aria-modal="true" aria-labelledby="header-panel-title">
              <button className="header-panel-close" type="button" aria-label="关闭" onClick={() => setActiveHeaderPanel(null)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
              </button>
              {activeHeaderPanel === "works" ? (
                <WorksPanel
                  user={authUser}
                  onNew={() => { setActiveHeaderPanel(null); startNewConversation(); }}
                  conversations={conversations}
                  highlightWorkId={highlightWorkId}
                  onClearHighlight={() => setHighlightWorkId(null)}
                  onRequestDownload={handleWorkDownload}
                />
              ) : activeHeaderPanel === "recharge" ? (
                <RechargePanel
                  user={authUser}
                  credits={walletCredits}
                  membership={membership}
                  onPaid={refreshWallet}
                />
              ) : activeHeaderPanel === "orders" ? (
                <BillingHistoryPanel key={authUser?.id ?? "guest"} user={authUser} kind="orders" />
              ) : activeHeaderPanel === "ledger" ? (
                <BillingHistoryPanel key={authUser?.id ?? "guest"} user={authUser} kind="ledger" />
              ) : activeHeaderPanel === "inbox" ? (
                <SiteInboxPanel user={authUser} onLogin={() => setActiveHeaderPanel("login")} />
              ) : activeHeaderPanel === "install" ? (
                <InstallAppPanel />
              ) : (
                <AuthPanel
                  user={authUser}
                  onSuccess={(user) => {
                    setAuthUser(user);
                    void refreshWallet();
                    setActiveHeaderPanel(null);
                    if (pendingDownloadWork) {
                      triggerDownloadFile(pendingDownloadWork.id, pendingDownloadWork.filename);
                      setPendingDownloadWork(null);
                    }
                  }}
                  onProfileUpdated={(user) => setAuthUser(user)}
                  onLogout={() => { setAuthUser(null); setActiveHeaderPanel(null); }}
                  onWalletRefresh={refreshWallet}
                />
              )}
            </section>
          </div>
        )
      )}

      {isDragging && <div className="drop-overlay" aria-hidden="true"><div><span>＋</span><strong>把素材放在这里</strong><small>支持图片与视频文件</small></div></div>}
    </main>
  );
}