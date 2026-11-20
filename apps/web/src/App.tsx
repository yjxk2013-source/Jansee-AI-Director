import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type TouchEvent } from "react";
import type { CreationMode } from "@jansee/contracts";
import QRCode from "qrcode";
import { Filmstrip } from "./Filmstrip";

const AdminConsole = lazy(() => import("./AdminConsole").then((m) => ({ default: m.AdminConsole })));

type ClientPlatform = "ios" | "android" | "desktop";

/** 一行字轻提示统一 2.5 秒自动消失；重复设置会重置计时，传空串立即清空。 */
const NOTICE_DURATION_MS = 2500;
function useTimedNotice(): [string, (next: string) => void] {
  const [value, setValue] = useState("");
  const timerRef = useRef<number | undefined>(undefined);
  const set = useCallback((next: string) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setValue(next);
    timerRef.current = next ? window.setTimeout(() => {
      setValue("");
      timerRef.current = undefined;
    }, NOTICE_DURATION_MS) : undefined;
  }, []);
  useEffect(() => () => { if (timerRef.current) window.clearTimeout(timerRef.current); }, []);
  return [value, set];
}

// APK 发布地址：替换为正式下载地址后即可生效，面板与二维码共用此值。
const ANDROID_APK_URL = "https://jansee.cn/download/jansee.apk";

function detectClientPlatform(): ClientPlatform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (/iPad|iPhone|iPod/i.test(ua) || (isMobile && /Macintosh/i.test(ua))) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "desktop";
}

type Attachment = {
  name: string;
  kind: "image" | "video";
  size: number;
  assetId?: string;
};

export type WorkItem = {
  id: string;
  jobId: string;
  // 引擎生成的纯净封面地址（无烧录台词、无 AI 角标）；旧作品为 null，回退到视频截帧。
  coverUrl?: string | null;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  publish?: {
    caption?: string;
    cover_title?: string;
    pinned_comment?: string;
    post_time?: string;
    tags?: string[];
  };
  directorPlan?: Record<string, unknown>;
};

type ChatMessage = {
  id: string;
  role: "user" | "director";
  speaker?: string;
  text: string;
  createdAt?: number;
  jobStage?: string;
  creationScene?: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  creationMode?: CreationMode;
  attachments?: Attachment[];
  isWorkbench?: boolean;
  plan?: string[];
  jobId?: string;
  jobStatus?: string;
  jobProgress?: number;
  jobError?: string;
  jobDirectorPlan?: Record<string, unknown>;
  speechCutSessionId?: string;
  speechCutStatus?: "analyzing" | "awaiting_confirmation" | "producing" | "consumed" | "failed";
  speechCutError?: string;
  speechCutSuggestions?: Array<{ id: string; start: number; end: number; word: string; reason: "filler" | "repeat" | "phrase" | "pause" }>;
  speechCutSelectedIds?: string[];
  speechCutSubmitting?: boolean;
  jobWorkId?: string;
};

function TypewriterText({ text, messageId, isNew }: { text: string; messageId: string; isNew: boolean }) {
  const [displayedLength, setDisplayedLength] = useState(() => (isNew ? 0 : text.length));

  useEffect(() => {
    if (!isNew) {
      setDisplayedLength(text.length);
      return;
    }
    setDisplayedLength(0);
    let current = 0;
    const speed = Math.max(12, Math.min(26, Math.floor(1000 / (text.length || 1))));
    const timer = setInterval(() => {
      current += 1;
      setDisplayedLength(current);
      if (current >= text.length) {
        clearInterval(timer);
      }
    }, speed);
    return () => clearInterval(timer);
  }, [text, isNew]);

  const isTyping = isNew && displayedLength < text.length;

  return (
    <span>
      {text.slice(0, displayedLength)}
      {isTyping && <span className="typewriter-cursor" aria-hidden="true" />}
    </span>
  );
}

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

const JOB_PROGRESS_LOGS: Record<string, Array<{ speaker: string; text: string }>> = {
  queued: [{ speaker: "简兮导演", text: "收到你的创作意图啦，正在为你调配算力与分镜资源，马上开始构思～" }],
  inspecting: [{ speaker: "简兮美术师", text: "画面素材全部收齐、画质校验无损，色调与构图很棒，准备为你设计视觉节奏！" }],
  planning: [{ speaker: "简兮导演", text: "分镜脚本与台词方案已经打磨完毕，这就正式交付制作流水线全面推进。" }],
  rendering: [
    { speaker: "简兮剪辑师", text: "正在顺着分镜细细编排运镜与柔和叠画，让每一帧画面的转换都自然流动。" },
    { speaker: "简兮音效师", text: "正在渲染超自然人声配音与多轨避让混音，给画面铺上最有感染力的听觉氛围。" },
    { speaker: "简兮包装师", text: "发丝级字幕、呼吸感版面与专属片尾正在细致压制，成片很快就能和你见面啦！" },
  ],
  "quality-check": [{ speaker: "简兮质检师", text: "全片合成完毕，正在做最后的画质平衡、音频平滑与合规细节核验，确保最佳呈现。" }],
  completed: [{ speaker: "简兮导演", text: "成片已制作完成！每个镜头的节奏与质感都已就绪，快点击播放看看效果吧～" }],
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function mediaKind(file: File): Attachment["kind"] | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  return null;
}

function isSpeechCutIntent(prompt: string) {
  if (/(不要|不需要|别|保留).{0,8}(剪|删|去掉).{0,8}(口头语|语气词|嗯啊|停顿|重复)/.test(prompt)) return false;
  return /口播精剪|智能剪口播|(?:剪掉|删掉|去掉|删除|清理|精剪).{0,10}(?:口头语|语气词|嗯啊|停顿|重复|冗余)|(?:口头语|语气词|嗯啊|停顿|重复|冗余).{0,10}(?:剪掉|删掉|去掉|删除|清理|精剪)/.test(prompt);
}

export default function App() {
  const [conversations, setConversations] = useState<SavedConversation[]>(() => loadSavedConversations());
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => loadActiveConversationId());
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

  function triggerDownloadFile(workId: string, filename: string) {
    const a = document.createElement("a");
    a.href = `/api/v1/works/${encodeURIComponent(workId)}/stream?download=1`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
      const friendlyNotice = isTimeout ? "网络偶发超时，点击重试" : ("这次创作没能继续：" + rawMessage);
      setConversations((current) => current.map((conversation) => {
        if (conversation.id !== conversationId) return conversation;
        // 发生异常时，将正在等待的用户消息解除 isWorkbench，避免工作台空转悬停
        const clearedMessages = conversation.messages.map((m) =>
          m.id === userMessage.id ? { ...m, isWorkbench: false } : m);
        return {
          ...conversation,
          updatedAt: Date.now(),
          messages: [
            ...clearedMessages,
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
                    {message.jobId && !message.jobWorkId && message.jobStatus === "failed" && (() => {
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
                            <p className="job-failure-desc">制作过程中遇到了临时问题，你的素材和创作内容都已保留。</p>
                            <p className="job-failure-hint">
                              {isPaidFailed
                                ? "本次消耗的积分已退回，可调整描述或素材后重试。"
                                : "本次为免费创作，不消耗积分，可调整描述或素材后重试。"}
                            </p>
                          </div>
                        </div>
                      );
                    })()}

                    {message.jobWorkId ? (
                      <div className="job-delivery">
                        <video
                          className="job-delivery-video"
                          src={"/api/v1/works/" + message.jobWorkId + "/stream"}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.1; }}
                          aria-label="简兮成片视频播放器"
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
                      <img src={previewUrls[index]} alt={`素材预览：${file.name}`} draggable={false} />
                    ) : (
                      <video src={previewUrls[index]} muted playsInline preload="metadata" aria-label={`视频预览：${file.name}`} draggable={false} />
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
                <div className="drawer-recent-works-list">
                  {recentWorks.map((work) => {
                    const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(work.createdAt)) / 60000));
                    const ageLabel = ageMinutes < 1 ? "\u521a\u521a\u5b8c\u6210" : ageMinutes < 60 ? ageMinutes + " \u5206\u949f\u524d" : ageMinutes < 1440 ? Math.floor(ageMinutes / 60) + " \u5c0f\u65f6\u524d" : Math.floor(ageMinutes / 1440) + " \u5929\u524d";
                    return (
                      <button className="drawer-recent-work" type="button" key={work.id} onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("works"); }}>
                        <span className="drawer-recent-work-thumb">
                          <video src={"/api/v1/works/" + work.id + "/stream"} muted playsInline preload="metadata" onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.1; }} />
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
export type SavedConversation = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

const CONVERSATION_STORAGE_KEY = "jansee.v4.guest-conversations.v1";
const ACTIVE_CONVERSATION_STORAGE_KEY = "jansee.v4.active-conversation.v1";
const MAX_SAVED_CONVERSATIONS = 30;
const PENDING_CONVERSATION_PREFIX = "jansee.v4.pending-conversation.v1:";

function pendingConversationKey(userId: string) {
  return `${PENDING_CONVERSATION_PREFIX}${userId}`;
}

function savePendingConversation(userId: string, conversation: SavedConversation) {
  try { window.localStorage.setItem(pendingConversationKey(userId), JSON.stringify(conversation)); } catch { /* local recovery is best effort */ }
}

function loadPendingConversations(userId: string): SavedConversation[] {
  try {
    const raw = window.localStorage.getItem(pendingConversationKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const item = parsed as Partial<SavedConversation>;
    return typeof item.id === "string" && typeof item.title === "string" && typeof item.updatedAt === "number" && Array.isArray(item.messages)
      ? [item as SavedConversation] : [];
  } catch { return []; }
}

function clearPendingConversationIfMatches(userId: string, conversation: SavedConversation) {
  try {
    const pending = loadPendingConversations(userId)[0];
    if (pending?.id === conversation.id && pending.updatedAt <= conversation.updatedAt) {
      window.localStorage.removeItem(pendingConversationKey(userId));
    }
  } catch { /* local recovery is best effort */ }
}

async function saveConversationToServer(conversation: SavedConversation): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: conversation.title, messages: conversation.messages }),
      });
      lastResponse = response;
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 250));
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("conversation save failed");
}

function loadActiveConversationId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveActiveConversationId(conversationId: string | null) {
  try {
    if (conversationId) window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
    else window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    // The active view preference must never block creating or opening a conversation.
  }
}

function resolveActiveConversationId(conversations: SavedConversation[]): string | null {
  const savedId = loadActiveConversationId();
  return savedId && conversations.some((conversation) => conversation.id === savedId && conversation.messages.length > 0)
    ? savedId
    : null;
}

function loadSavedConversations(): SavedConversation[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SavedConversation =>
      item && typeof item === "object"
      && typeof item.id === "string"
      && typeof item.title === "string"
      && typeof item.updatedAt === "number"
      && Array.isArray(item.messages),
    ).slice(0, MAX_SAVED_CONVERSATIONS);
  } catch {
    return [];
  }
}

function persistSavedConversations(conversations: SavedConversation[]) {
  try {
    window.localStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify(conversations.slice(0, MAX_SAVED_CONVERSATIONS)),
    );
  } catch {
    // Private browsing or a full storage quota must not break the chat.
  }
}

function makeConversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  return (firstUserMessage?.text || "新对话").replace(/\s+/g, " ").slice(0, 34);
}

type AuthUser = { id: string; email?: string; phone?: string; displayName: string | null; createdAt: string; isGuest?: boolean };

const withdrawalStatusLabel: Record<string, string> = {
  pending: "待审核",
  approved: "已通过 · 待打款",
  paid: "已打款",
  rejected: "已驳回",
  failed: "打款失败",
};

function AuthPanel({ user, onSuccess, onProfileUpdated, onLogout, onWalletRefresh }: { user: AuthUser | null; onSuccess: (user: AuthUser) => void; onProfileUpdated: (user: AuthUser) => void; onLogout: () => void; onWalletRefresh: () => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "sms" | "register" | "password-setup">("password");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupUser, setSetupUser] = useState<AuthUser | null>(null);
  const [forcePasswordReset, setForcePasswordReset] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [displayNameSaving, setDisplayNameSaving] = useState(false);
  const [displayNameError, setDisplayNameError] = useTimedNotice();
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useTimedNotice();
  const [error, setError] = useTimedNotice();
  const [busy, setBusy] = useState(false);
  const [inviteQrDataUrl, setInviteQrDataUrl] = useState("");
  const [growth, setGrowth] = useState<{
    inviteCode: string;
    invitedCount: number;
    rewardedCount: number;
    checkedInToday: boolean;
    checkinRewardCredits: number;
    referralRewardCredits: number;
    partner: { active: boolean; province?: string | null; city?: string | null; target: number; progress: number; pendingYuan: number; settledYuan: number; inTransitYuan: number; withdrawnYuan: number; withdrawableYuan: number; totalYuan: number; levelOneRate: number; levelTwoRate: number };
  } | null>(null);
  const [expandedGrowthSection, setExpandedGrowthSection] = useState<"checkin" | "invite" | "partner" | null>(null);
  const [growthBusy, setGrowthBusy] = useState(false);
  const [payoutProfile, setPayoutProfile] = useState<{ channel: string; accountLast4: string; verificationStatus: string; verificationNote?: string | null } | null>(null);
  const [payoutName, setPayoutName] = useState("");
  const [payoutAccount, setPayoutAccount] = useState("");
  const [payoutEditing, setPayoutEditing] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawals, setWithdrawals] = useState<Array<{ id: string; amountYuan: number; feeYuan: number; netAmountYuan: number; status: string; note?: string | null; createdAt: string; processedAt?: string | null; arrivalType?: string }>>([]);
  const [growthInvitees, setGrowthInvitees] = useState<Array<{ level: number; displayName: string; contact: string; joinedAt: string; hasPaid: boolean }>>([]);
  const [growthCommissions, setGrowthCommissions] = useState<Array<{ id: string; level: number; orderAmountYuan: number; rate: number; commissionYuan: number; status: string; createdAt: string; settledAt: string | null; source: string }>>([]);
  const [growthNotice, setGrowthNotice] = useTimedNotice();
  const [partnerProvince, setPartnerProvince] = useState("");
  const [partnerCity, setPartnerCity] = useState("");
  const isMockPreview = import.meta.env.DEV && user?.id === "local-preview-user";

  useEffect(() => {
    if (!growth?.inviteCode) { setInviteQrDataUrl(""); return; }
    let active = true;
    const inviteUrl = `https://jansee.cn/?ref=${encodeURIComponent(growth.inviteCode)}`;
    QRCode.toDataURL(inviteUrl, { width: 480, margin: 2, errorCorrectionLevel: "H" })
      .then((dataUrl: string) => { if (active) setInviteQrDataUrl(dataUrl); })
      .catch(() => { if (active) setInviteQrDataUrl(""); });
    return () => { active = false; };
  }, [growth?.inviteCode]);

  function beginDisplayNameEdit() {
    setDisplayNameDraft(user?.displayName || "");
    setDisplayNameError("");
    setEditingDisplayName(true);
  }

  async function saveDisplayName() {
    const displayName = displayNameDraft.trim();
    if (!displayName || displayName.length > 24 || displayNameSaving || !user) {
      setDisplayNameError("\u6635\u79f0\u9700\u4e3a 1\u201324 \u4e2a\u5b57\u7b26");
      return;
    }
    setDisplayNameSaving(true);
    setDisplayNameError("");
    try {
      if (isMockPreview) {
        onProfileUpdated({ ...user, displayName });
      } else {
        const response = await fetch("/api/v1/auth/profile", {
          method: "PUT", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
        });
        const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
        if (!response.ok || !payload.user) throw new Error(payload.error?.message || "\u6635\u79f0\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
        onProfileUpdated(payload.user);
      }
      setEditingDisplayName(false);
    } catch (cause) {
      setDisplayNameError(cause instanceof Error ? cause.message : "\u6635\u79f0\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5");
    } finally {
      setDisplayNameSaving(false);
    }
  }

  async function loadGrowth() {
    try {
      const [overviewResponse, inviteesResponse, commissionsResponse, profileResponse, withdrawalsResponse] = await Promise.all([
        fetch("/api/v1/growth/overview?timeZone=Asia%2FShanghai", { credentials: "include", cache: "no-store" }),
        fetch("/api/v1/growth/invitees", { credentials: "include" }),
        fetch("/api/v1/growth/commissions", { credentials: "include" }),
        fetch("/api/v1/growth/payout-profile", { credentials: "include", cache: "no-store" }),
        fetch("/api/v1/growth/withdrawals", { credentials: "include" }),
      ]);
      const [overviewPayload, inviteesPayload, commissionsPayload, profilePayload, withdrawalsPayload] = await Promise.all([
        overviewResponse.json() as Promise<{ overview?: typeof growth }>,
        inviteesResponse.json() as Promise<{ invitees?: typeof growthInvitees }>,
        commissionsResponse.json() as Promise<{ commissions?: typeof growthCommissions }>,
        profileResponse.json() as Promise<{ profile?: typeof payoutProfile }>,
        withdrawalsResponse.json() as Promise<{ withdrawals?: typeof withdrawals }>,
      ]);
      if (overviewResponse.ok && overviewPayload.overview) {
        setGrowth(overviewPayload.overview);
        setPartnerProvince(overviewPayload.overview.partner.province ?? "");
        setPartnerCity(overviewPayload.overview.partner.city ?? "");
      }
      if (inviteesResponse.ok && inviteesPayload.invitees) setGrowthInvitees(inviteesPayload.invitees);
      if (commissionsResponse.ok && commissionsPayload.commissions) setGrowthCommissions(commissionsPayload.commissions);
      if (profileResponse.ok) {
        setPayoutProfile(profilePayload.profile ?? null);
      }
      if (withdrawalsResponse.ok && withdrawalsPayload.withdrawals) setWithdrawals(withdrawalsPayload.withdrawals);
    } catch {
      setGrowthNotice("暂时无法加载签到与推广信息，请检查网络后重试。");
    }
  }

  useEffect(() => {
    if (import.meta.env.DEV && user?.id === "local-preview-user") {
      const mockPartnerMode = new URLSearchParams(window.location.search).get("mockPartner");
      const showMockPartner = mockPartnerMode === "1";
      const showEligiblePartner = mockPartnerMode === "eligible";
      setGrowth({
        inviteCode: "JANSEEV4PRE",
        invitedCount: showMockPartner ? 8 : showEligiblePartner ? 5 : 3,
        rewardedCount: showMockPartner ? 6 : showEligiblePartner ? 5 : 3,
        checkedInToday: false,
        checkinRewardCredits: 100,
        referralRewardCredits: 200,
        partner: showMockPartner ? { active: true, province: "\u6d59\u6c5f\u7701", city: "\u676d\u5dde\u5e02", target: 5, progress: 8, pendingYuan: 386.50, settledYuan: 1260, inTransitYuan: 120, withdrawnYuan: 680, withdrawableYuan: 460, totalYuan: 2106.50, levelOneRate: 0.15, levelTwoRate: 0.05 } : { active: false, target: 5, progress: showEligiblePartner ? 5 : 3, pendingYuan: 0, settledYuan: 0, inTransitYuan: 0, withdrawnYuan: 0, withdrawableYuan: 0, totalYuan: 0, levelOneRate: 0.15, levelTwoRate: 0.05 },
      });
      setGrowthInvitees([
        { level: 1, displayName: "\u521b\u4f5c\u8005 A", contact: "138****1024", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "\u521b\u4f5c\u8005 B", contact: "139****2088", joinedAt: new Date().toISOString(), hasPaid: true },
        { level: 1, displayName: "\u521b\u4f5c\u8005 C", contact: "137****3106", joinedAt: new Date().toISOString(), hasPaid: true },
        ...(showEligiblePartner || showMockPartner ? [
          { level: 1, displayName: "\u521b\u4f5c\u8005 D", contact: "136****4120", joinedAt: new Date().toISOString(), hasPaid: true },
          { level: 1, displayName: "\u521b\u4f5c\u8005 E", contact: "135****5132", joinedAt: new Date().toISOString(), hasPaid: true },
        ] : []),
      ]);
      setGrowthCommissions([]);
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthNotice("本地预览数据 · 不会发放真实积分");
    } else if (user) {
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthInvitees([]);
      setGrowthCommissions([]);
      void loadGrowth();
    } else {
      setGrowth(null);
      setPayoutProfile(null);
      setWithdrawals([]);
      setGrowthNotice("");
    }
  }, [user?.id]);

  async function claimCheckin() {
    if (growthBusy || growth?.checkedInToday) return;
    if (isMockPreview) {
      setGrowthBusy(true);
      setGrowth((current) => current ? { ...current, checkedInToday: true } : current);
      setGrowthNotice("签到成功，预览状态不会发放真实积分");
      setGrowthBusy(false);
      return;
    }
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/checkin", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeZone: "Asia/Shanghai" }),
      });
      const payload = await response.json() as { already?: boolean; rewardCredits?: number; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "签到失败，请稍后重试");
      // The POST response is authoritative: lock the button immediately instead of
      // relying on a follow-up overview request to refresh the UI state.
      setGrowth((current) => current ? { ...current, checkedInToday: true } : current);
      setGrowthNotice(payload.already ? "今天已经签到过了" : "签到成功，已获得 100 积分");
      await loadGrowth();
      await onWalletRefresh();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "签到失败"); }
    finally { setGrowthBusy(false); }
  }

  async function activatePartner() {
    if (growthBusy) return;
    if (isMockPreview) {
      if (!partnerProvince.trim() || !partnerCity.trim()) return;
      setGrowthBusy(true);
      setGrowth((current) => current ? { ...current, partner: { ...current.partner, active: true, province: partnerProvince.trim(), city: partnerCity.trim() } } : current);
      setGrowthNotice("\u6a21\u62df\u5f00\u901a\u6210\u529f\uff0c\u672a\u5199\u5165\u771f\u5b9e\u6570\u636e");
      setGrowthBusy(false);
      return;
    }
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/partner/activate", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ province: partnerProvince, city: partnerCity }),
      });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "申请失败");
      setGrowthNotice("城市合伙人资格已开通");
      await loadGrowth();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "申请失败"); }
    finally { setGrowthBusy(false); }
  }

  async function performSavePayoutProfile() {
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/payout-profile", {
        method: "PUT", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountName: payoutName, account: payoutAccount }),
      });
      const payload = await response.json() as { profile?: typeof payoutProfile; error?: { message?: string } };
      if (!response.ok || !payload.profile) throw new Error(payload.error?.message || "收款资料保存失败");
      setPayoutProfile(payload.profile);
      setPayoutName(""); setPayoutAccount("");
      setPayoutEditing(false);
      setGrowthNotice("收款资料已加密保存，等待管理员核验通过后即可申请提现。");
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setGrowthBusy(false); }
  }

  async function savePayoutProfile() {
    if (growthBusy) return;
    if (isMockPreview) {
      setPayoutProfile({ channel: "alipay", accountLast4: payoutAccount.trim().slice(-4), verificationStatus: "verified" });
      setPayoutName(""); setPayoutAccount(""); setPayoutEditing(false);
      setGrowthNotice("模拟保存成功，未写入真实数据。");
      return;
    }
    await performSavePayoutProfile();
  }

  async function performSubmitWithdrawal() {
    const amountYuan = Number(withdrawAmount);
    setGrowthBusy(true); setGrowthNotice("");
    try {
      const response = await fetch("/api/v1/growth/withdrawals", {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountYuan, idempotencyKey: crypto.randomUUID() }),
      });
      const payload = await response.json() as { withdrawal?: { netAmountYuan: number }; error?: { message?: string } };
      if (!response.ok || !payload.withdrawal) throw new Error(payload.error?.message || "提现申请失败");
      setWithdrawAmount("");
      setGrowthNotice(`提现申请已提交，预计 T+1 工作日到账 ¥${payload.withdrawal.netAmountYuan.toFixed(2)}，请等待审核和人工转账。`);
      await loadGrowth();
    } catch (cause) { setGrowthNotice(cause instanceof Error ? cause.message : "提现申请失败"); }
    finally { setGrowthBusy(false); }
  }

  async function submitWithdrawal() {
    if (isMockPreview || growthBusy) return;
    const amountYuan = Number(withdrawAmount);
    if (!Number.isFinite(amountYuan) || amountYuan < 100 || amountYuan > 5000 || amountYuan % 10 !== 0) {
      setGrowthNotice("单笔提现须为 100 至 5000 元，且为 10 元的整数倍。"); return;
    }
    await performSubmitWithdrawal();
  }

  async function downloadInvitePoster() {
    if (!growth?.inviteCode) return;
    try {
      const inviteUrl = "https://jansee.cn/?ref=" + encodeURIComponent(growth.inviteCode);
      const qrDataUrl = await QRCode.toDataURL(inviteUrl, { width: 480, margin: 2, errorCorrectionLevel: "H" });
      const qr = new Image();
      const qrLoaded = new Promise<void>((resolve, reject) => {
        qr.onload = () => resolve();
        qr.onerror = () => reject(new Error("QR load failed"));
      });
      qr.src = qrDataUrl;
      await qrLoaded;
      const logoMark = new Image();
      const logoMarkLoaded = new Promise<void>((resolve, reject) => {
        logoMark.onload = () => resolve();
        logoMark.onerror = () => reject(new Error("JANSEE symbol logo load failed"));
      });
      logoMark.src = "/assets/jansee-mark.svg";
      const wordmark = new Image();
      const wordmarkLoaded = new Promise<void>((resolve, reject) => {
        wordmark.onload = () => resolve();
        wordmark.onerror = () => reject(new Error("JANSEE wordmark load failed"));
      });
      wordmark.src = "/assets/jansee-pirulen-wordmark.png";
      await Promise.all([logoMarkLoaded, wordmarkLoaded]);
      await document.fonts.ready;

      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 1200;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Poster generation failed");
      const chineseFont = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif';
      context.textBaseline = "alphabetic";

      context.fillStyle = "#f6f4ef";
      context.fillRect(0, 0, 900, 1200);
      context.fillStyle = "#18191b";
      context.fillRect(0, 0, 900, 18);

      context.textAlign = "left";
      context.fillStyle = "#777b80";
      context.drawImage(logoMark, 86, 78, 64, 64);
      context.drawImage(wordmark, 164, 100, 140, 19);
      context.fillStyle = "#17191c";
      context.font = "600 72px " + chineseFont;
      context.fillText("\u597d\u89c6\u9891\uff0c", 86, 270);
      context.fillText("\u4e0d\u5fc5\u4ece\u96f6\u5b66\u526a\u8f91", 86, 355);
      context.fillStyle = "#777b80";
      context.font = "32px " + chineseFont;
      context.fillText("\u7b80\u516e AI \u667a\u80fd\u5bfc\u6f14\u7cfb\u7edf", 90, 425);
      context.font = "26px " + chineseFont;
      context.fillText("\u4e0a\u4f20\u7d20\u6750\uff0c\u667a\u80fd\u751f\u6210\u5b8c\u6574\u77ed\u89c6\u9891", 90, 470);

      context.fillStyle = "#ffffff";
      context.fillRect(270, 490, 360, 360);
      context.drawImage(qr, 286, 506, 328, 328);
      context.textAlign = "center";
      context.fillStyle = "#33363a";
      context.font = "600 28px " + chineseFont;
      context.fillText("\u626b\u7801\u6ce8\u518c\uff0c\u5f00\u542f\u667a\u80fd\u521b\u4f5c", 450, 895);
      context.fillStyle = "#85898e";
      context.font = "22px " + chineseFont;
      context.fillText("\u4e13\u5c5e\u9080\u8bf7\u7801\uff1a" + growth.inviteCode, 450, 935);

      context.fillStyle = "#18191b";
      context.fillRect(0, 970, 900, 230);
      context.fillStyle = "#ffffff";
      context.font = "600 30px " + chineseFont;
      context.fillText("\u6ce8\u518c\u5c31\u9001 600 \u79ef\u5206", 450, 1030);
      context.font = "28px " + chineseFont;
      context.fillText("\u9080\u8bf7\u597d\u53cb\u518d\u9001 200 \u79ef\u5206", 450, 1090);
      context.fillText("\u6bcf\u65e5\u7b7e\u5230\u518d\u9001 100 \u79ef\u5206", 450, 1150);

      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Poster export failed")), "image/png"));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "JANSEE-\u63a8\u5e7f\u6d77\u62a5-" + growth.inviteCode + ".png";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      setGrowthNotice("\u4e13\u5c5e\u63a8\u5e7f\u6d77\u62a5\u5df2\u751f\u6210\uff0c\u4fdd\u5b58\u540e\u5373\u53ef\u5206\u4eab");
    } catch (cause) {
      setGrowthNotice(cause instanceof Error ? cause.message : "Poster generation failed");
    }
  }

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  async function handleSendSms() {
    const cleanPhone = phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) {
      setError("请输入 11 位有效的大陆手机号");
      return;
    }
    setError(""); setNotice(""); setSending(true);
    try {
      const res = await fetch("/api/v1/auth/sms/send", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone }),
      });
      const data = await res.json() as { ok?: boolean; error?: { message?: string } };
      if (!res.ok || !data.ok) throw new Error(data.error?.message || "短信发送失败");
      setCountdown(60);
      setNotice("验证码已发送至您的手机，请查收");
    } catch (err) {
      setError(err instanceof Error ? err.message : "发送失败，请稍后重试");
    } finally {
      setSending(false);
    }
  }

  async function submitPasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (password.length < 1) { setError("请输入登录密码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, password }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "手机号或密码不正确");
      onSuccess(payload.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitSmsLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    const cleanCode = code.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/login", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, code: cleanCode }),
      });
      const payload = await response.json() as { user?: AuthUser; hasPassword?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "验证码错误或已失效");
      if (forcePasswordReset || !payload.hasPassword) {
        setSetupUser(payload.user);
        setAuthMode("password-setup");
        setNewPassword(""); setConfirmPassword("");
        setNotice(payload.hasPassword ? "短信验证成功，请设置新密码。" : "短信验证成功，请设置登录密码。");
      } else {
        onSuccess(payload.user);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitSmsRegistration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const cleanPhone = phone.replace(/\D/g, "");
    const cleanCode = code.replace(/\D/g, "");
    if (!/^1\d{10}$/.test(cleanPhone)) { setError("请输入 11 位有效手机号"); return; }
    if (!/^\d{4,8}$/.test(cleanCode)) { setError("请输入有效短信验证码"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/register", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: cleanPhone, code: cleanCode, inviteCode: new URLSearchParams(window.location.search).get("ref") || undefined }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "注册失败，请稍后重试");
      setSetupUser(payload.user);
      setAuthMode("password-setup");
      setForcePasswordReset(false);
      setNewPassword(""); setConfirmPassword("");
      setNotice("手机号验证成功，最后设置一个登录密码即可完成注册。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络不可用，请稍后重试");
    } finally { setBusy(false); }
  }

  async function submitPasswordSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !setupUser) return;
    if (newPassword.length < 8) { setError("密码至少需要 8 位"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的密码不一致"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/password", {
        method: "PUT", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "密码设置失败，请重试");
      setPassword(""); setNewPassword(""); setConfirmPassword("");
      setSetupUser(null); setForcePasswordReset(false);
      onSuccess(payload.user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "密码设置失败，请稍后重试");
    } finally { setBusy(false); }
  }

  async function logout() {
    try {
      const response = await fetch("/api/v1/auth/logout", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("logout failed");
      onLogout();
    } catch { setError("退出登录失败，请检查网络后重试。"); }
  }

  if (user && !user.isGuest) return <>
    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
    <h2 id="header-panel-title">{"\u8d26\u6237\u4fe1\u606f"}</h2>
    <p className="header-panel-copy">{"\u7ba1\u7406\u4f60\u7684\u7b80\u516e\u8d26\u6237\u4e0e\u521b\u4f5c\u6743\u76ca\u3002"}</p>
    <div className="login-notice">
      <div className="profile-name-row">
        {editingDisplayName ? (
          <div className="profile-name-editor">
            <input value={displayNameDraft} maxLength={24} onChange={(event) => setDisplayNameDraft(event.target.value)} aria-label="修改昵称" />
            <button type="button" className="profile-name-save" disabled={displayNameSaving} onClick={() => void saveDisplayName()}>{displayNameSaving ? "保存中…" : "保存"}</button>
          </div>
        ) : (
          <>
            <strong>{user.displayName || (user.phone ? "\u7528\u6237_" + user.phone.slice(-4) : "\u521b\u4f5c\u8005")}</strong>
            <button type="button" className="profile-name-edit" aria-label="修改昵称" title="修改昵称" onClick={beginDisplayNameEdit}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>
            </button>
          </>
        )}
      </div>
      <span>{user.phone ? user.phone.slice(0, 3) + "****" + user.phone.slice(-4) : (user.email || "")}</span>
      {displayNameError && <small className="auth-error" role="alert">{displayNameError}</small>}
    </div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {growthNotice && <p className="growth-notice" role="status">{growthNotice}</p>}
    {growth ? (
      <>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "checkin"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "checkin" ? null : "checkin"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">DAILY CHECK-IN</span><h3>每日签到</h3></div>
                <span className="growth-reward">+{growth.checkinRewardCredits} 积分</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>每日签到可领取奖励积分，奖励自动发放到账户。</p>
          <button className="growth-primary-button growth-login-style" type="button" disabled={growthBusy || growth.checkedInToday} onClick={() => void claimCheckin()}>
            {growth.checkedInToday ? "今日已签到" : growthBusy ? "处理中…" : "立即签到"}
          </button>
        </details>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "invite"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "invite" ? null : "invite"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">INVITE & GROW</span><h3>邀请推广</h3></div>
                <span className="growth-reward">好友注册奖励 +{growth.referralRewardCredits} 积分</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>分享专属邀请链接，好友通过邀请注册即可获得相应奖励。</p>
          <div className="growth-invite-card">
            <div className="growth-poster-copy">
              <span>YOUR INVITATION CODE</span>
              <strong>{growth.inviteCode}</strong>
              <small>已邀请 {growth.invitedCount} 位 · 已奖励 {growth.rewardedCount} 位</small>
            </div>
            {inviteQrDataUrl && <img src={inviteQrDataUrl} alt="专属邀请二维码" />}
          </div>
          <div className="growth-stats">
            <div><strong>{growth.invitedCount}</strong><span>邀请注册人数</span></div>
            <div><strong>{growth.rewardedCount}</strong><span>已获得奖励人数</span></div>
          </div>
          <button className="growth-poster-download" type="button" onClick={() => void downloadInvitePoster()}>生成并下载推广海报</button>
          {growthInvitees.length > 0 && (
            <details className="growth-more-records">
              <summary>查看邀请记录（{growthInvitees.length}）</summary>
              <div className="growth-record-list">
                {growthInvitees.map((invitee, index) => (
                  <div className="growth-record-row" key={index}>
                    <span>{invitee.displayName}<small>{invitee.contact} · {new Date(invitee.joinedAt).toLocaleDateString("zh-CN")}</small></span>
                    <span>{invitee.hasPaid ? "已完成付费" : "已注册"}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </details>
        <details className="growth-section growth-accordion" open={expandedGrowthSection === "partner"}>
          <summary className="growth-accordion-trigger" onClick={(event) => { event.preventDefault(); setExpandedGrowthSection((current) => current === "partner" ? null : "partner"); }}>
            <div className="growth-section-heading-content">
              <div className="growth-section-heading">
                <div><span className="growth-kicker">CITY PARTNER PROGRAM</span><h3>城市合伙人</h3></div>
                <span className="growth-status">{growth.partner.active ? "已开通" : "邀请进度中"}</span>
              </div>
            </div>
            <svg className="growth-accordion-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </summary>
          <p>邀请有效用户达到要求，即可申请成为城市合伙人并享受会员推广佣金。</p>
          {growth.partner.active ? (
            <>
              <div className="growth-partner-summary">
                <strong>{growth.partner.province || ""}{growth.partner.city || ""} · 城市合伙人</strong>
                <span>一级佣金 {Math.round(growth.partner.levelOneRate * 100)}% · 二级佣金 {Math.round(growth.partner.levelTwoRate * 100)}%</span>
                <span>累计佣金 ¥{growth.partner.totalYuan.toFixed(2)} · 待结算佣金 ¥{growth.partner.pendingYuan.toFixed(2)}</span>
                <div className="growth-money-stats">
                  <div><strong>¥{growth.partner.withdrawableYuan.toFixed(2)}</strong><span>可提现余额</span></div>
                  <div><strong>¥{growth.partner.inTransitYuan.toFixed(2)}</strong><span>在途金额</span></div>
                  <div><strong>¥{growth.partner.withdrawnYuan.toFixed(2)}</strong><span>已提现金额</span></div>
                </div>
              </div>
              {growthCommissions.length > 0 && (
                <details className="growth-more-records">
                  <summary>查看佣金明细（{growthCommissions.length}）</summary>
                  <div className="growth-record-list">
                    {growthCommissions.map((item) => (
                      <div className="growth-record-row" key={item.id}>
                        <span>{item.level === 1 ? "一级推广佣金" : "二级推广佣金"}<small>{new Date(item.createdAt).toLocaleDateString("zh-CN")} · 订单金额 ¥{item.orderAmountYuan.toFixed(2)}</small></span>
                        <span>¥{item.commissionYuan.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="growth-partner-summary">
                <strong>收款信息</strong>
                {payoutProfile ? <span>支付宝账号已加密保存 · 尾号 ****{payoutProfile.accountLast4} · {payoutProfile.verificationStatus === "verified" ? "已核验" : payoutProfile.verificationStatus === "pending" ? "等待管理员核验" : "核验未通过"}</span> : <span>尚未设置收款账户</span>}
                <button className="growth-poster-download" type="button" onClick={() => setPayoutEditing((value) => !value)}>{payoutEditing ? "取消" : payoutProfile ? "修改收款信息" : "设置收款信息"}</button>
                {payoutEditing && (
                  <div className="growth-partner-form">
                    <input value={payoutName} onChange={(event) => setPayoutName(event.target.value)} placeholder="支付宝真实姓名" autoComplete="name" />
                    <input value={payoutAccount} onChange={(event) => setPayoutAccount(event.target.value)} placeholder="支付宝手机号或账号" autoComplete="off" />
                    <button type="button" disabled={growthBusy || !payoutName.trim() || !payoutAccount.trim()} onClick={() => void savePayoutProfile()}>保存并提交核验</button>
                  </div>
                )}
                <div className="growth-partner-form">
                  <input inputMode="decimal" value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} placeholder="提现金额（100–5000 元）" />
                  <button type="button" disabled={growthBusy || isMockPreview || !payoutProfile || payoutProfile.verificationStatus !== "verified" || !withdrawAmount.trim()} onClick={() => void submitWithdrawal()}>申请提现</button>
                </div>
                {withdrawals.length > 0 && (
                  <details className="growth-more-records">
                    <summary>查看提现记录（{withdrawals.length}）</summary>
                    <div className="growth-record-list">
                      {withdrawals.map((item) => (
                        <div className="growth-record-row" key={item.id}>
                          <span>{new Date(item.createdAt).toLocaleDateString("zh-CN")}<small>{withdrawalStatusLabel[item.status] ?? item.status}</small></span>
                          <span>¥{item.amountYuan.toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="growth-progress-track"><span style={{ width: `${Math.min(100, growth.partner.progress / Math.max(1, growth.partner.target) * 100)}%` }} /></div>
              <div className="growth-progress-caption"><span>有效邀请进度</span><strong>{growth.partner.progress}/{growth.partner.target} 人</strong></div>
              {growth.partner.progress >= growth.partner.target ? (
                <div className="growth-partner-form">
                  <input value={partnerProvince} onChange={(event) => setPartnerProvince(event.target.value)} placeholder="所在省份（例如：浙江省）" />
                  <input value={partnerCity} onChange={(event) => setPartnerCity(event.target.value)} placeholder="所在城市（例如：杭州市）" />
                  <button type="button" disabled={growthBusy || !partnerProvince.trim() || !partnerCity.trim()} onClick={() => void activatePartner()}>申请开通城市合伙人</button>
                </div>
              ) : (
                <p className="growth-muted">还需邀请 {Math.max(0, growth.partner.target - growth.partner.progress)} 位有效用户，即可申请成为城市合伙人。</p>
              )}
            </>
          )}
        </details>
      </>
    ) : (
      <>
        <p className="header-panel-copy" role="status">{growthNotice || "正在加载签到与推广权益…"}</p>
        <button className="growth-poster-download" type="button" onClick={() => void loadGrowth()}>重新加载</button>
      </>
    )}
    <button className="panel-primary-action" type="button" onClick={logout}>{"\u9000\u51fa\u767b\u5f55"}</button>
  </>;

  return <>
    <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></svg></div>
    <h2 id="header-panel-title">{authMode === "register" ? "\u521b\u5efa\u7b80\u516e\u8d26\u6237" : authMode === "password-setup" ? (forcePasswordReset ? "\u91cd\u7f6e\u767b\u5f55\u5bc6\u7801" : "\u8bbe\u7f6e\u767b\u5f55\u5bc6\u7801") : authMode === "sms" ? "\u77ed\u4fe1\u9a8c\u8bc1\u7801\u767b\u5f55" : "\u6b22\u8fce\u767b\u5f55\u7b80\u516e"}</h2>
    <p className="header-panel-copy">{authMode === "register" ? "\u4f7f\u7528\u624b\u673a\u53f7\u9a8c\u8bc1\u6ce8\u518c\uff0c\u5b8c\u6210\u540e\u8bbe\u7f6e\u5bc6\u7801\u3002" : authMode === "password-setup" ? "\u8bbe\u7f6e\u5bc6\u7801\u540e\uff0c\u4e0b\u6b21\u5373\u53ef\u4f7f\u7528\u624b\u673a\u53f7\u548c\u5bc6\u7801\u767b\u5f55\u3002" : authMode === "sms" ? "\u4f7f\u7528\u6ce8\u518c\u624b\u673a\u53f7\u63a5\u6536\u9a8c\u8bc1\u7801\uff0c\u5b89\u5168\u5feb\u6377\u5730\u767b\u5f55\u3002" : "\u4f7f\u7528\u624b\u673a\u53f7\u548c\u5bc6\u7801\u767b\u5f55 JANSEE\u3002"}</p>
    {notice && <p className="auth-notice" role="status">{notice}</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {authMode !== "password-setup" && (
      <div className="auth-tabs" role="tablist" aria-label={"\u6ce8\u518c\u4e0e\u767b\u5f55"}>
        <button type="button" role="tab" aria-selected={authMode === "register"} className={authMode === "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("register"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u6ce8\u518c"}</button>
        <button type="button" role="tab" aria-selected={authMode !== "register"} className={authMode !== "register" ? "auth-tab active" : "auth-tab"} onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>{"\u767b\u5f55"}</button>
      </div>
    )}
    {authMode === "password-setup" ? (
      <form className="auth-form" onSubmit={submitPasswordSetup}>
        <label><span>{"\u65b0\u5bc6\u7801"}</span><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder={"\u81f3\u5c11 8 \u4f4d\u5bc6\u7801"} /></label>
        <label><span>{"\u786e\u8ba4\u5bc6\u7801"}</span><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required placeholder={"\u518d\u6b21\u8f93\u5165\u5bc6\u7801"} /></label>
        <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "\u4fdd\u5b58\u4e2d\u2026" : "\u5b8c\u6210\u5e76\u8fdb\u5165\u7b80\u516e"}</button>
      </form>
    ) : (
      <form className="auth-form auth-entry-form" onSubmit={authMode === "password" ? submitPasswordLogin : authMode === "register" ? submitSmsRegistration : submitSmsLogin}>
        <label><span>{"\u624b\u673a\u53f7"}</span><input type="tel" value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} required maxLength={11} autoComplete="tel" placeholder={"\u8bf7\u8f93\u5165 11 \u4f4d\u5927\u9646\u624b\u673a\u53f7"} /></label>
        {authMode === "password" ? (
          <label><span>{"\u767b\u5f55\u5bc6\u7801"}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" placeholder={"\u8bf7\u8f93\u5165\u5bc6\u7801"} /></label>
        ) : (
          <label><span>{"\u77ed\u4fe1\u9a8c\u8bc1\u7801"}</span><div className="auth-code-row">
            <input type="text" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} required maxLength={8} inputMode="numeric" autoComplete="one-time-code" placeholder={"\u8bf7\u8f93\u5165\u9a8c\u8bc1\u7801"} />
            <button type="button" className="auth-code-send" disabled={sending || countdown > 0 || phone.length !== 11} onClick={handleSendSms}>{countdown > 0 ? countdown + "s \u540e\u91cd\u53d1" : sending ? "\u53d1\u9001\u4e2d\u2026" : "\u83b7\u53d6\u9a8c\u8bc1\u7801"}</button>
          </div></label>
        )}
        <button className="panel-primary-action" type="submit" disabled={busy}>{busy ? "\u5904\u7406\u4e2d\u2026" : authMode === "password" ? "\u767b\u5f55" : authMode === "register" ? "\u9a8c\u8bc1\u624b\u673a\u53f7\u5e76\u6ce8\u518c" : "\u9a8c\u8bc1\u7801\u767b\u5f55"}</button>
      </form>
    )}
    {authMode !== "password-setup" && (
      <div className="auth-footer-links">
        {authMode === "password" ? <>
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); }}>{"\u9a8c\u8bc1\u7801\u767b\u5f55"}</button>
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("sms"); setForcePasswordReset(true); setError(""); setNotice("\u8bf7\u5148\u4f7f\u7528\u77ed\u4fe1\u9a8c\u8bc1\u7801\uff0c\u9a8c\u8bc1\u901a\u8fc7\u540e\u5373\u53ef\u91cd\u7f6e\u5bc6\u7801\u3002"); setCode(""); }}>{"\u5fd8\u8bb0\u5bc6\u7801\uff1f"}</button>
        </> : authMode === "sms" ? (
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u8fd4\u56de\u5bc6\u7801\u767b\u5f55"}</button>
        ) : (
          <button type="button" className="auth-mode-link" onClick={() => { setAuthMode("password"); setForcePasswordReset(false); setError(""); setNotice(""); setCode(""); setPassword(""); }}>{"\u8fd4\u56de\u767b\u5f55"}</button>
        )}
      </div>
    )}
  </>;
}

function resolvePublishForWork(work: WorkItem, conversations: SavedConversation[]): {
  title?: string;
  caption?: string;
  cover_title?: string;
  pinned_comment?: string;
  post_time?: string;
} | null {
  // 画面主标题 title 属于导演方案顶层字段，不在 publish 四件套里，单独带出。
  let title = "";
  const workPlan = work.directorPlan as Record<string, unknown> | undefined;
  if (typeof workPlan?.title === "string" && workPlan.title.trim()) title = workPlan.title.trim();

  // publish 四件套：优先作品自带，缺的再从对应对话的导演方案回填。
  let base: NonNullable<WorkItem["publish"]> | null = null;
  if (work.publish && (work.publish.caption || work.publish.cover_title || work.publish.pinned_comment)) {
    base = work.publish;
  }
  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (msg.jobWorkId === work.id || (msg.jobId && msg.jobId === work.jobId)) {
        const plan = msg.jobDirectorPlan;
        if (!title && typeof plan?.title === "string" && plan.title.trim()) title = plan.title.trim();
        if (!base) {
          const p = plan?.publish as Record<string, unknown> | undefined;
          if (p && (p.caption || p.cover_title || p.pinned_comment || p.post_time)) {
            const res: NonNullable<WorkItem["publish"]> = {};
            if (typeof p.caption === "string") res.caption = p.caption;
            if (typeof p.cover_title === "string") res.cover_title = p.cover_title;
            if (typeof p.pinned_comment === "string") res.pinned_comment = p.pinned_comment;
            if (typeof p.post_time === "string") res.post_time = p.post_time;
            base = res;
          }
        }
      }
    }
  }
  if (!base && !title) return null;
  return { ...(base ?? {}), ...(title ? { title } : {}) };
}

function WorksPanel({
  user,
  onNew,
  conversations = [],
  highlightWorkId,
  onClearHighlight,
  onRequestDownload,
}: {
  user: AuthUser | null;
  onNew: () => void;
  conversations?: SavedConversation[];
  highlightWorkId?: string | null;
  onClearHighlight?: () => void;
  onRequestDownload?: (workId: string, filename: string) => void;
}) {
  const [works, setWorks] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useTimedNotice();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<string>("");
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const [coverDataUrls, setCoverDataUrls] = useState<Record<string, string>>({});

  const captureFrameAsCover = (workId: string, showFeedback = true) => {
    const video = videoRefs.current[workId];
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      setCoverDataUrls((prev) => ({ ...prev, [workId]: dataUrl }));
      if (showFeedback) {
        setCopyFeedback("已将当前画面设为封面");
        setTimeout(() => setCopyFeedback(""), NOTICE_DURATION_MS);
      }
    } catch {
      // ignore cross-origin error if any
    }
  };

  const downloadCover = (work: WorkItem) => {
    const workId = work.id;
    if (!user || user.isGuest) {
      if (onRequestDownload) {
        onRequestDownload(workId, `jansee-cover-${workId}.png`);
      }
      return;
    }
    // 新作品直接下载引擎生成的纯净封面（后端鉴权流）；旧作品回退到前端截帧。
    if (work.coverUrl) {
      const a = document.createElement("a");
      a.href = work.coverUrl;
      a.download = `jansee-cover-${workId}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setCopyFeedback("封面图片已开始下载");
      setTimeout(() => setCopyFeedback(""), NOTICE_DURATION_MS);
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
    setLoading(true);
    fetch("/api/v1/works", { credentials: "include" })
      .then((res) => res.json() as Promise<{ works?: WorkItem[]; error?: { message?: string } }>)
      .then((data) => {
        if (data.works) setWorks(data.works);
        else if (data.error?.message) setError(data.error.message);
      })
      .catch(() => setError("无法获取成片列表"))
      .finally(() => setLoading(false));
  }, [user]);

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
              <article
                key={work.id}
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

                <div className="work-card-player">
                  <video
                    ref={(el) => { videoRefs.current[work.id] = el; }}
                    src={`/api/v1/works/${work.id}/stream`}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      event.currentTarget.currentTime = 0.1;
                    }}
                    onLoadedData={() => {
                      // 仅在旧作品没有纯净封面时才截帧兜底；新作品直接用引擎生成的封面。
                      if (!work.coverUrl && !coverDataUrls[work.id]) {
                        setTimeout(() => captureFrameAsCover(work.id, false), 150);
                      }
                    }}
                    onSeeked={() => {
                      if (!work.coverUrl && !coverDataUrls[work.id]) {
                        captureFrameAsCover(work.id, false);
                      }
                    }}
                    aria-label={titleLabel}
                  />
                </div>

                <div className="work-card-actions">
                  <button
                    type="button"
                    className="work-btn-download"
                    onClick={() => {
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
                      <div className="work-publish-cover-preview">
                        {(coverDataUrls[work.id] || work.coverUrl) ? (
                          <img
                            src={coverDataUrls[work.id] || work.coverUrl!}
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
                            onClick={() => downloadCover(work)}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                            </svg>
                            下载封面图
                          </button>
                          <button
                            type="button"
                            className="work-cover-btn-action work-cover-btn-capture"
                            onClick={() => captureFrameAsCover(work.id, true)}
                            title="从视频当前画面截一张图作为封面（旧作品适用；新作品自带纯净封面）"
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <circle cx="12" cy="12" r="3" />
                              <path d="M4 7h4l2-3h4l2 3h4a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V9a2 2 0 012-2z" />
                            </svg>
                            截取当前播放帧
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
                )}
              </article>
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
      <button className="panel-primary-action" type="button" onClick={onNew}>开始新创作</button>
    </div>
  );
}

type BillingHistoryKind = "orders" | "ledger";

type BillingOrder = {
  id: string;
  packageId: string;
  packageName: string;
  amountYuan: number;
  credits: number;
  status: "pending" | "paid" | "closed" | "refund_requested" | "refunding" | "refunded";
  paymentProvider?: "opcpay";
  payUrl?: string;
  paymentExpiresAt?: string;
  createdAt: string;
  paidAt?: string;
};

type BillingLedgerEntry = {
  id: string;
  jobId?: string;
  orderId?: string;
  type: "grant" | "hold" | "settle" | "refund" | "recharge" | "compensation";
  amount: number;
  description: string;
  createdAt: string;
};

function BillingHistoryPanel({ user, kind }: { user: AuthUser | null; kind: BillingHistoryKind }) {
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [entries, setEntries] = useState<BillingLedgerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [statusClock, setStatusClock] = useState(Date.now());
  const [resumingOrderId, setResumingOrderId] = useState<string | null>(null);
  const [payment, setPayment] = useState<{ orderId: string; payUrl: string; qrImageUrl: string; expiresAt?: string } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setStatusClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const endpoint = kind === "orders" ? "/api/v1/billing/orders" : "/api/v1/billing/ledger";
      const response = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
      const responseText = await response.text();
      let payload: { orders?: BillingOrder[]; entries?: BillingLedgerEntry[]; error?: { message?: string } } = {};
      if (responseText.trim()) {
        try {
          payload = JSON.parse(responseText) as typeof payload;
        } catch {
          if (response.ok) throw new Error("\u670d\u52a1\u5668\u8fd4\u56de\u7684\u6570\u636e\u65e0\u6cd5\u8bc6\u522b\uff0c\u8bf7\u7a0d\u540e\u5237\u65b0\u91cd\u8bd5\u3002");
        }
      }
      if (!response.ok) {
        throw new Error(payload.error?.message || (response.status === 401
          ? "\u767b\u5f55\u72b6\u6001\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002"
          : response.status >= 500
            ? "\u670d\u52a1\u5668\u6682\u65f6\u65e0\u6cd5\u8bfb\u53d6\u4ea4\u6613\u8bb0\u5f55\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"
            : "\u6682\u65f6\u65e0\u6cd5\u8bfb\u53d6\u4ea4\u6613\u8bb0\u5f55\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002"));
      }
      if (!responseText.trim()) throw new Error("\u670d\u52a1\u5668\u6682\u65f6\u6ca1\u6709\u8fd4\u56de\u8bb0\u5f55\u6570\u636e\uff0c\u8bf7\u7a0d\u540e\u5237\u65b0\u91cd\u8bd5\u3002");
      if (kind === "orders") {
        if (!Array.isArray(payload.orders)) throw new Error("订单数据格式异常，请稍后重试。");
        setOrders([...payload.orders].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      } else {
        if (!Array.isArray(payload.entries)) throw new Error("积分流水数据格式异常，请稍后重试。");
        setEntries([...payload.entries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
      }
      setShowAll(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络异常，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [kind, user]);

  useEffect(() => { void load(); }, [load]);

  // 继续付款：通过 checkout 接口幂等恢复支付入口后弹出扫码窗口。
  // 不能直接打开存储的 payUrl——它可能是 alipays:// 深链，PC 浏览器无法唤起。
  async function resumePayment(orderId: string) {
    if (resumingOrderId) return;
    setResumingOrderId(orderId);
    setError("");
    try {
      const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(orderId)}/checkout`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
      });
      const payload = await response.json() as { payUrl?: string; qrImageUrl?: string; expiresAt?: string; error?: { message?: string } };
      if (!response.ok || !payload.payUrl || !payload.qrImageUrl) {
        throw new Error(payload.error?.message || "支付入口创建失败，请稍后重试");
      }
      setPayment({
        orderId,
        payUrl: payload.payUrl,
        qrImageUrl: payload.qrImageUrl,
        ...(payload.expiresAt ? { expiresAt: payload.expiresAt } : {}),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起付款失败，请稍后重试");
    } finally {
      setResumingOrderId(null);
    }
  }

  // 付款弹窗打开期间轮询对账接口，支付成功后自动关闭弹窗并刷新订单状态。
  useEffect(() => {
    if (!payment) return;
    let active = true;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(payment.orderId)}/reconcile`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
        });
        if (!response.ok) return;
        const payload = await response.json() as { tradeState?: string; order?: { status?: string } };
        if (active && (payload.tradeState === "PAID" || payload.order?.status === "paid")) {
          setPayment(null);
          void load();
        }
      } catch {
        // 临时网络抖动不中断轮询；服务端对账兜底仍然有效。
      }
    };
    void checkPayment();
    const timer = window.setInterval(() => { void checkPayment(); }, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [payment, load]);

  if (!user) {
    return <div className="billing-history-state"><strong>请先登录</strong><span>登录后可查看与当前账户关联的订单和积分流水。</span></div>;
  }

  const rows = kind === "orders" ? orders : entries;
  const visibleRows = showAll ? rows : rows.slice(0, 3);
  const orderStatus: Record<BillingOrder["status"], string> = { pending: "待支付", paid: "已入账", closed: "已失效", refund_requested: "退款申请中", refunding: "退款处理中", refunded: "已退款" };
  const isOrderExpired = (order: BillingOrder) => order.status === "pending" && Date.parse(order.paymentExpiresAt || new Date(Date.parse(order.createdAt) + 30 * 60 * 1000).toISOString()) <= statusClock;
  const ledgerType: Record<BillingLedgerEntry["type"], string> = {
    grant: "积分赠送", hold: "制作冻结", settle: "制作扣除", refund: "失败返还", recharge: "购买积分", compensation: "积分补偿",
  };
  const ledgerSourceLabel = (entry: BillingLedgerEntry) => {
    const description = entry.description.toLowerCase();
    if (entry.type === "refund" && entry.orderId) return "购买积分退款回收";
    if (entry.type === "recharge" || entry.orderId) return "购买积分";
    if (description.includes("签到")) return "签到积分";
    if (description.includes("邀请") || description.includes("推广") || description.includes("注册奖励")) return "推广积分";
    if (description.includes("注册") || description.includes("新账号")) return "注册积分";
    return ledgerType[entry.type] || "积分变动";
  };

  return (
    <>
      <section className="billing-history">
        <div className="billing-history-heading">
          <strong id="header-panel-title">{kind === "orders" ? "订单记录" : "积分明细"}</strong>
          <span>{kind === "orders" ? "仅展示当前账户创建的订单" : "按发生时间倒序展示账本记录"}</span>
          <button type="button" className="billing-history-refresh" onClick={() => void load()}>刷新</button>
        </div>
        {error && <div className="billing-history-error" role="alert"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
        {loading ? (
          <div className="billing-history-state" role="status">正在读取记录…</div>
        ) : rows.length === 0 && !error ? (
          <div className="billing-history-state"><strong>{kind === "orders" ? "暂无订单" : "暂无积分记录"}</strong><span>{kind === "orders" ? "创建的订单会显示在这里。" : "积分赠送、冻结、扣除和返还记录会显示在这里。"}</span></div>
        ) : (
          <>
            <div className="billing-history-list">
              {kind === "orders"
                ? (visibleRows as BillingOrder[]).map((order) => (
                  <article className="billing-history-row" key={order.id}>
                    <div className="billing-history-main">
                      <strong>{order.packageName}</strong>
                      <span>{order.id}</span>
                      <small>{new Date(order.createdAt).toLocaleString("zh-CN")}</small>
                    </div>
                    <div className="billing-history-value">
                      <strong>¥{Number(order.amountYuan).toFixed(2)}</strong>
                      <span className={"billing-status billing-status-" + (isOrderExpired(order) ? "closed" : order.status)}>{isOrderExpired(order) ? "已失效" : (orderStatus[order.status] || "状态未知")}</span>
                      <small>{Number(order.credits).toLocaleString()} 积分</small>
                      {order.status === "pending" && !isOrderExpired(order) && (
                        <button
                          type="button"
                          className="billing-order-resume"
                          disabled={resumingOrderId === order.id}
                          onClick={() => void resumePayment(order.id)}
                        >
                          {resumingOrderId === order.id ? "正在发起付款…" : "继续付款"}
                        </button>
                      )}
                      {isOrderExpired(order) && <small className="billing-order-expired">付款时间已结束，请重新创建订单</small>}
                      {order.status === "paid" && <><small>如需退款或处理订单问题，请发送站内信联系简兮管理员，由人工核实处理。</small><button type="button" className="billing-order-resume" onClick={async () => { const message = window.prompt("请填写退款原因或订单问题"); if (!message?.trim()) return; try { const response = await fetch("/api/v1/support/messages", { method: "POST", credentials: "include", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ orderId: order.id, subject: "退款/订单处理申请", message: message.trim() }) }); const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }; if (!response.ok) throw new Error(payload.error?.message || "站内信发送失败"); window.alert("站内信已发送，管理员核实后会处理。"); } catch (cause) { window.alert(cause instanceof Error ? cause.message : "站内信发送失败"); } }}>发送站内信</button></>}                    {order.status === "refund_requested" && <small className="billing-refund-window">购买积分已暂时预留，等待商户后台完成真实退款</small>}
                    </div>
                  </article>
                ))
                : (visibleRows as BillingLedgerEntry[]).map((entry) => (
                  <article className="billing-history-row" key={entry.id}>
                    <div className="billing-history-main">
                      <strong>{ledgerSourceLabel(entry)}</strong>
                      <span>{entry.description}</span>
                      <small>{new Date(entry.createdAt).toLocaleString("zh-CN")}{entry.orderId ? ` · 订单 ${entry.orderId}` : ""}</small>
                    </div>
                    <div className="billing-history-value">
                      <strong className={["hold", "settle"].includes(entry.type) || (entry.type === "refund" && Boolean(entry.orderId)) ? "billing-amount-negative" : "billing-amount-positive"}>{["hold", "settle"].includes(entry.type) || (entry.type === "refund" && Boolean(entry.orderId)) ? "−" : "+"}{Math.abs(Number(entry.amount)).toLocaleString()} 积分</strong>
                    </div>
                  </article>
                ))}
            </div>
            {rows.length > 3 && <div className="billing-history-pagination">
              <span>{showAll ? `全部 ${rows.length} 条记录` : `显示最近 3 条，共 ${rows.length} 条`}</span>
              <button type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? "收起" : `更多（${rows.length - 3}）`}</button>
            </div>}
          </>
        )}
      </section>
      {payment && (
        <div className="payment-dialog-overlay">
          <section className="payment-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-resume-title">
            <button type="button" className="payment-dialog-close" aria-label="关闭付款窗口" onClick={() => setPayment(null)}>×</button>
            <h3 id="payment-resume-title">扫码完成支付</h3>
            <p>请使用支付宝扫描二维码</p>
            <img className="payment-dialog-qr" src={payment.qrImageUrl} alt="支付宝直接付款二维码" />
            <a className="payment-dialog-link" href={payment.payUrl} target="_blank" rel="noreferrer">手机支付宝打开付款页</a>
            <small>付款成功后自动核对，积分与会员权益将自动到账</small>
            {payment.expiresAt && <small>付款入口有效至 {new Date(payment.expiresAt).toLocaleString("zh-CN")}</small>}
            <button type="button" className="payment-dialog-done" onClick={() => setPayment(null)}>稍后查看</button>
          </section>
        </div>
      )}
    </>
  );
}

function RechargePanel({
  user,
  credits,
  membership,
  onPaid,
}: {
  user: AuthUser | null;
  credits: number | null;
  membership: { tierId: string; expiresAt: string; active: boolean } | null;
  onPaid: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [checkout, setCheckout] = useState<{ orderId: string; payUrl: string; qrImageUrl: string; expiresAt?: string } | null>(null);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const [notice, setNotice] = useTimedNotice();
  const [error, setError] = useTimedNotice();
  const [pricingCatalog, setPricingCatalog] = useState<{ members: { id: string; priceYuan: number; strikeYuan: string }[]; boostPacks: { id: string; priceYuan: number; strikeYuan: string }[] } | null>(null);

  useEffect(() => {
    let active = true;
    const refreshPricing = () => {
      fetch("/api/v1/pricing", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as { members?: { id: string; priceYuan: number; strikeYuan: string }[]; boostPacks?: { id: string; priceYuan: number; strikeYuan: string }[] };
      }).then((data) => { if (active && data?.members && data?.boostPacks) setPricingCatalog(data as NonNullable<typeof pricingCatalog>); }).catch(() => { });
    };
    refreshPricing();
    const timer = window.setInterval(refreshPricing, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const memberPlans = [
    { id: "lite", name: "Lite 体验版", price: pricingCatalog?.members.find((item) => item.id === "lite")?.priceYuan ?? 41, strike: pricingCatalog?.members.find((item) => item.id === "lite")?.strikeYuan ?? "¥69", credits: 7600, clipsText: "约 38 条成片", desc: "高清成片，轻松开启创作" },
    { id: "plus", name: "Plus 日常版", price: pricingCatalog?.members.find((item) => item.id === "plus")?.priceYuan ?? 119, strike: pricingCatalog?.members.find((item) => item.id === "plus")?.strikeYuan ?? "¥199", credits: 24800, clipsText: "约 124 条成片", desc: "高峰优先，创作更顺畅" },
    { id: "pro", name: "Pro 旗舰版", price: pricingCatalog?.members.find((item) => item.id === "pro")?.priceYuan ?? 299, strike: pricingCatalog?.members.find((item) => item.id === "pro")?.strikeYuan ?? "¥499", credits: 66600, clipsText: "约 333 条成片", desc: "最高优先级，专业创作之选", tag: "官方主推" },
    { id: "ultra", name: "Ultra 团队版", price: pricingCatalog?.members.find((item) => item.id === "ultra")?.priceYuan ?? 599, strike: pricingCatalog?.members.find((item) => item.id === "ultra")?.strikeYuan ?? "¥999", credits: 153800, clipsText: "约 769 条成片", desc: "大额积分，满足团队创作" },
  ];

  const boostPack = {
    id: "boost_small",
    name: "1,000 算力加油包",
    price: pricingCatalog?.boostPacks.find((item) => item.id === "boost_small")?.priceYuan ?? 9.9,
    strike: pricingCatalog?.boostPacks.find((item) => item.id === "boost_small")?.strikeYuan ?? "¥19.9",
    credits: 1000,
    clipsText: "约 5 次成片",
    desc: "即时到账，积分长期有效",
    tag: "基础补给",
  };

  async function handleBuy(packageId: string) {
    if (!user) { setError("请先登录账户后再进行充值"); return; }
    if (user.id === "local-preview-user") {
      setError("当前为本地预览账号，不能创建真实订单。请连接 V4 数据库并使用真实账号登录后再购买。");
      return;
    }
    setLoading(true); setError(""); setNotice(""); setCheckout(null);
    try {
      const res = await fetch("/api/v1/billing/orders", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId }),
      });
      const data = await res.json() as { order?: { id: string }; error?: { message?: string } };
      if (!res.ok || !data.order) throw new Error(data.error?.message || "创建订单失败");

      const checkoutResponse = await fetch(`/api/v1/billing/orders/${encodeURIComponent(data.order.id)}/checkout`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const checkoutData = await checkoutResponse.json() as {
        payUrl?: string;
        qrImageUrl?: string;
        expiresAt?: string;
        error?: { message?: string };
      };
      if (!checkoutResponse.ok || !checkoutData.payUrl || !checkoutData.qrImageUrl) {
        throw new Error(checkoutData.error?.message || "支付入口暂不可用，请稍后重试");
      }
      setCheckout({
        orderId: data.order.id,
        payUrl: checkoutData.payUrl,
        qrImageUrl: checkoutData.qrImageUrl,
        ...(checkoutData.expiresAt ? { expiresAt: checkoutData.expiresAt } : {}),
      });
      setCheckoutVisible(true);
      setNotice("请使用支付宝完成付款。支付成功后，积分和会员权益会自动到账。");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "充值异常，请稍后重试";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!checkout) return;
    let active = true;
    const checkPayment = async () => {
      try {
        const response = await fetch(`/api/v1/billing/orders/${encodeURIComponent(checkout.orderId)}/reconcile`, {
          method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
        });
        if (!response.ok) return;
        const payload = await response.json() as { tradeState?: string; order?: { status?: string } };
        if (active && (payload.tradeState === "PAID" || payload.order?.status === "paid")) {
          setCheckout(null);
          setCheckoutVisible(false);
          setNotice("支付成功，积分与会员权益已到账。");
          setError("");
          onPaid();
        }
      } catch {
        // The server-side reconciliation sweep remains active if the browser temporarily disconnects.
      }
    };
    void checkPayment();
    const timer = window.setInterval(() => { void checkPayment(); }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [checkout, onPaid]);

  return (
    <>
      <>
        <div className="credit-center-heading">
          <h2 id="header-panel-title">算力积分</h2>
          <p className="header-panel-copy">用于简兮 AI 导演生成与制作</p>
        </div>
        <div className="credit-balance">
          <span>当前余额</span>
          <strong>{credits !== null ? credits.toLocaleString() : "—"}</strong>
          <span>积分</span>
          <small>带货视频、门店获客每生成 1 条成片消耗 200 积分；个人创作与一句话剪辑免费</small>
          {membership?.active && <small className="credit-membership-status">当前会员：{membership.tierId.toUpperCase()} · 到期 {new Date(membership.expiresAt).toLocaleDateString("zh-CN")}</small>}
        </div>

        {notice && <p className="credit-notice" role="status">{notice}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}

        <div className="credit-products">
          <section className="credit-product-section">
            <div className="credit-section-title">会员方案</div>
            <div className="credit-plan-list">
              {memberPlans.map((plan) => (
                <div
                  key={plan.id}
                  className={`credit-plan-card${plan.tag ? " is-featured" : ""}`}
                >
                  <div>
                    <div className="credit-plan-main">
                      <strong>{plan.name}</strong>
                      {plan.tag && <span className="credit-plan-tag">{plan.tag}</span>}
                    </div>
                    <div className="credit-plan-detail">
                      <strong>+{plan.credits.toLocaleString()}</strong> 积分
                      <span>{plan.clipsText}</span>
                    </div>
                    <div className="credit-plan-desc">{plan.desc}</div>
                  </div>
                  <button
                    type="button"
                    className="credit-buy-button"
                    disabled={loading}
                    onClick={() => handleBuy(plan.id)}
                  >
                    ¥{plan.price}
                    <span className="credit-old-price">{plan.strike}</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
          <section className="credit-product-section">
            <div className="credit-section-title">算力加油卡 <span>无需订阅</span></div>
            <div className="credit-plan-card credit-topup-card">
              <div>
                <div className="credit-plan-main"><strong>{boostPack.name}</strong><span className="credit-plan-tag">{boostPack.tag}</span></div>
                <div className="credit-plan-detail"><strong>+{boostPack.credits.toLocaleString()}</strong> 积分 <span>{boostPack.clipsText}</span></div>
                <div className="credit-plan-desc">{boostPack.desc}</div>
              </div>
              <button
                type="button"
                className="credit-buy-button"
                disabled={loading}
                onClick={() => handleBuy(boostPack.id)}
              >
                ¥{boostPack.price}
                <span className="credit-old-price">{boostPack.strike}</span>
              </button>
            </div>
          </section>
        </div>
      </>
      {checkout && checkoutVisible && (
        <div className="payment-dialog-overlay">
          <section className="payment-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-dialog-title">
            <button type="button" className="payment-dialog-close" aria-label="关闭付款窗口" onClick={() => setCheckoutVisible(false)}>×</button>
            <h3 id="payment-dialog-title">扫码完成支付</h3>
            <p>请使用支付宝扫描二维码</p>
            <img className="payment-dialog-qr" src={checkout.qrImageUrl} alt="支付宝直接付款二维码" />
            <a className="payment-dialog-link" href={checkout.payUrl} target="_blank" rel="noreferrer">无法扫码？打开支付页面</a>
            <small>付款成功后自动核对，积分与会员权益将自动到账</small>
            {checkout.expiresAt && <small>付款入口有效至 {new Date(checkout.expiresAt).toLocaleString("zh-CN")}</small>}
            <button type="button" className="payment-dialog-done" onClick={() => setCheckoutVisible(false)}>稍后查看</button>
          </section>
        </div>
      )}
    </>
  );
}

function AdminLoginPanel({ onSuccess }: { onSuccess: (user: AuthUser) => void }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [mode, setMode] = useState<"password" | "sms">("password");
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useTimedNotice();
  const [notice, setNotice] = useTimedNotice();

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  function cleanPhone() { return phone.replace(/\D/g, ""); }

  async function sendCode() {
    const mobile = cleanPhone();
    if (!/^1\d{10}$/.test(mobile)) { setError("请输入有效的管理员手机号"); return; }
    setSending(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/v1/auth/sms/send", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: mobile }),
      });
      const payload = await response.json() as { message?: string; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message || "验证码发送失败");
      setCountdown(60);
      setNotice(payload.message || "验证码发送请求已受理，请查看手机短信");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "验证码发送失败，请检查短信服务配置");
    } finally { setSending(false); }
  }

  async function verifyAdmin(user: AuthUser) {
    const response = await fetch("/api/v1/admin/overview", { credentials: "include", cache: "no-store" });
    if (response.status === 401 || response.status === 403) throw new Error("该手机号对应的账号没有管理员权限");
    if (!response.ok) throw new Error("管理员权限验证失败（HTTP " + response.status + "）");
    return user;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const mobile = cleanPhone();
    if (!/^1\d{10}$/.test(mobile)) { setError("请输入有效的管理员手机号"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "password") {
        if (!password) throw new Error("请输入管理员密码");
        const response = await fetch("/api/v1/auth/login", {
          method: "POST", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ phone: mobile, password }),
        });
        const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
        if (!response.ok || !payload.user) throw new Error(payload.error?.message || "手机号或密码不正确");
        onSuccess(await verifyAdmin(payload.user));
        return;
      }

      if (!/^\d{4,8}$/.test(code.trim())) throw new Error("请输入短信验证码");
      const response = await fetch("/api/v1/auth/sms/login", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: mobile, code: code.trim() }),
      });
      const payload = await response.json() as { user?: AuthUser; error?: { message?: string } };
      if (!response.ok || !payload.user) throw new Error(payload.error?.message || "验证码不正确或已失效");
      const adminUser = await verifyAdmin(payload.user);
      if (resetting) {
        if (newPassword.length < 8) throw new Error("新密码至少需要 8 位");
        if (newPassword !== confirmPassword) throw new Error("两次输入的新密码不一致");
        const resetResponse = await fetch("/api/v1/auth/password", {
          method: "PUT", credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: newPassword }),
        });
        const resetPayload = await resetResponse.json() as { error?: { message?: string } };
        if (!resetResponse.ok) throw new Error(resetPayload.error?.message || "密码重置失败");
        setNotice("密码重置成功，正在进入管理后台…");
      }
      onSuccess(adminUser);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败，请检查本地 API 和短信服务");
    } finally { setBusy(false); }
  }

  return (
    <main className="admin-login-screen">
      <section className="admin-login-card" aria-labelledby="admin-login-title">
        <div className="admin-login-mark">JANSEE <span>ADMIN</span></div>
        <h1 id="admin-login-title">管理后台</h1>
        <p>管理员专用登录</p>
        <div className="admin-login-modes">
          <button type="button" className={mode === "password" ? "active" : ""} onClick={() => { setMode("password"); setResetting(false); setError(""); setNotice(""); }}>密码登录</button>
          <button type="button" className={mode === "sms" ? "active" : ""} onClick={() => { setMode("sms"); setError(""); setNotice(""); }}>短信验证码</button>
        </div>
        <form onSubmit={submit} className="admin-login-form">
          <label><span>管理员手机号</span><input type="tel" inputMode="numeric" autoComplete="username" maxLength={11} value={phone} onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))} placeholder="请输入管理员手机号" required /></label>
          {mode === "password" ? (
            <label><span>登录密码</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="请输入管理员密码" required /></label>
          ) : (
            <>
              <label><span>短信验证码</span><div className="admin-login-code-row"><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} inputMode="numeric" autoComplete="one-time-code" placeholder="请输入验证码" required /><button type="button" disabled={sending || countdown > 0} onClick={sendCode}>{countdown > 0 ? countdown + " 秒后重发" : sending ? "发送中…" : "获取验证码"}</button></div></label>
              {resetting && <>
                <label><span>设置新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="至少 8 位新密码" required /></label>
                <label><span>确认新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" required /></label>
              </>}
            </>
          )}
          {error && <div className="admin-login-error" role="alert">{error}</div>}
          {notice && <div className="admin-login-notice" role="status">{notice}</div>}
          <button type="submit" disabled={busy}>{busy ? "正在验证…" : resetting ? "验证并重置密码" : mode === "sms" ? "验证码登录管理后台" : "登录管理后台"}</button>
        </form>
        {mode === "password" ? (
          <button type="button" className="admin-login-link" onClick={() => { setMode("sms"); setResetting(true); setCode(""); setError(""); setNotice("请使用管理员手机号接收短信验证码，验证通过后设置新密码。"); }}>忘记密码？使用短信验证码重置</button>
        ) : (
          <button type="button" className="admin-login-link" onClick={() => { setMode("password"); setResetting(false); setError(""); setNotice(""); setCode(""); }}>返回密码登录</button>
        )}
        <a href="/">返回简兮首页</a>
      </section>
    </main>
  );
}


type SiteInboxMessage = {
  id: string;
  subject: string;
  body: string;
  category: "welcome" | "features" | "notice";
  publishedAt: string | null;
  readAt: string | null;
};

function InstallAppPanel() {
  const [platform] = useState<ClientPlatform>(() => detectClientPlatform());
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [qrError, setQrError] = useState(false);
  const pageUrl = typeof window !== "undefined" ? `${window.location.origin}/` : "https://jansee.cn/";

  useEffect(() => {
    // 安卓端只提供下载按钮，不生成二维码；二维码仅 PC 端使用。
    if (platform === "android") return;
    let active = true;
    QRCode.toDataURL(pageUrl, {
      width: 200,
      margin: 1,
      color: { dark: "#202124", light: "#FFFFFF" },
    }).then((url) => { if (active) setQrDataUrl(url); }).catch(() => { if (active) setQrError(true); });
    return () => { active = false; };
  }, [platform, pageUrl]);

  return (
    <>
      <h2 id="header-panel-title" className="visually-hidden">安装 App</h2>

      {platform === "ios" ? (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">添加到主屏幕</p>
          <p className="install-section-copy">iPhone 无需下载安装包。用 Safari 打开本页，按下面两步操作即可。</p>
          <ol className="install-steps">
            <li><span className="install-step-num">1</span><span>点击 Safari 底部的<strong>分享</strong>按钮（方框带向上箭头）</span></li>
            <li><span className="install-step-num">2</span><span>在菜单里选择<strong>添加到主屏幕</strong>，确认后桌面就会出现简兮图标</span></li>
          </ol>
          <p className="install-note">请使用 Safari 浏览器操作，其他浏览器可能不支持添加到主屏幕。</p>
        </div>
      ) : platform === "android" ? (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">安装安卓客户端</p>
          <p className="install-section-copy">下载安装包后按提示完成安装。若系统提示“未知来源”，请在设置中允许本应用安装。</p>
          <a className="credit-buy-button install-download-button" href={ANDROID_APK_URL} download>下载 APK 安装包</a>
        </div>
      ) : (
        <div className="install-section" role="tabpanel">
          <p className="install-section-title">扫码在手机上打开</p>
          <p className="install-section-copy">用手机扫描下方二维码打开简兮，再按提示添加到主屏幕或安装客户端。</p>
          <div className="install-qr-block">
            {qrDataUrl ? <img className="install-qr-image" src={qrDataUrl} alt="简兮手机版下载二维码" /> : <div className="install-qr-placeholder">{qrError ? "二维码生成失败，请用手机访问 jansee.cn" : "正在生成二维码…"}</div>}
            <p className="install-qr-hint">支持 iPhone 与安卓手机</p>
          </div>
        </div>
      )}
    </>
  );
}

function SiteInboxPanel({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const [messages, setMessages] = useState<SiteInboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useTimedNotice();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subject, setSubject] = useState("产品建议");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useTimedNotice();

  useEffect(() => {
    if (!user) { setLoading(false); return; }
    let active = true;
    fetch("/api/v1/inbox", { credentials: "include", cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error?.message || "站内信读取失败");
        if (active) {
          const rows = (payload.messages ?? []) as SiteInboxMessage[];
          setMessages(rows);
          setSelectedId((current) => current ?? rows[0]?.id ?? null);
        }
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "站内信读取失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user?.id]);

  const openMessage = async (message: SiteInboxMessage) => {
    setSelectedId(message.id);
    if (message.readAt) return;
    try {
      const response = await fetch(`/api/v1/inbox/${encodeURIComponent(message.id)}/read`, {
        method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: "{}",
      });
      if (!response.ok) return;
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, readAt: new Date().toISOString() } : item));
    } catch { /* Reading the message remains available even if the read receipt cannot be saved. */ }
  };

  const sendFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user) { onLogin(); return; }
    if (!feedback.trim()) { setNotice("请填写反馈内容"); return; }
    setSending(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/support/messages", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, message: feedback.trim() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || "反馈提交失败");
      setFeedback("");
      setNotice("反馈已提交，我们会认真查看。");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "反馈提交失败，请稍后重试");
    } finally { setSending(false); }
  };

  const selected = messages.find((message) => message.id === selectedId) ?? null;
  const unreadCount = messages.filter((message) => !message.readAt).length;

  return (
    <section className="site-inbox-panel">
      <div className="panel-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg></div>
      <h2 id="header-panel-title">站内信</h2>
      <p className="header-panel-copy">查看简兮通知，向我们反馈问题，或联系商务合作。</p>
      {!user ? (
        <div className="panel-empty-state">
          <strong>登录后查看站内信</strong>
          <span>欢迎信、功能通知和反馈记录将与账号关联保存。</span>
          <button className="panel-primary-action" type="button" onClick={onLogin}>登录账号</button>
        </div>
      ) : (
        <>
          <div className="site-inbox-section">
            <div className="site-inbox-section-heading"><strong>收件箱</strong><span>{unreadCount > 0 ? `${unreadCount} 封未读` : `${messages.length} 封信件`}</span></div>
            {loading ? <p className="site-inbox-muted">正在读取站内信…</p> : error ? <p className="site-inbox-error" role="alert">{error}</p> : messages.length === 0 ? <p className="site-inbox-muted">暂时没有新信件。</p> : (
              <div className="site-inbox-layout">
                <div className="site-inbox-list">
                  {messages.map((message) => (
                    <button type="button" key={message.id} className={`site-inbox-item ${selectedId === message.id ? "is-selected" : ""}`} onClick={() => void openMessage(message)}>
                      <span className="site-inbox-item-title">{message.subject}</span>
                      <span className="site-inbox-item-meta">{message.category === "welcome" ? "欢迎信" : message.category === "features" ? "功能介绍" : "通知"} · {message.readAt ? "已读" : "未读"}</span>
                    </button>
                  ))}
                </div>
                {selected && <article className="site-inbox-reading"><h3>{selected.subject}</h3><p>{selected.body}</p><time>{selected.publishedAt ? new Date(selected.publishedAt).toLocaleString("zh-CN") : ""}</time></article>}
              </div>
            )}
          </div>
          <div className="site-inbox-section">
            <div className="site-inbox-section-heading"><strong>意见反馈</strong><span>问题与建议直达后台</span></div>
            <form className="site-inbox-feedback" onSubmit={sendFeedback}>
              <select aria-label="反馈类型" value={subject} onChange={(event) => setSubject(event.target.value)}>
                <option value="产品建议">产品建议</option><option value="功能问题">功能问题</option><option value="账号与积分">账号与积分</option><option value="其他反馈">其他反馈</option>
              </select>
              <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={2000} rows={3} placeholder="请描述你遇到的问题或建议…" />
              {notice && <p className="site-inbox-notice" role="status">{notice}</p>}
              <button className="panel-primary-action" type="submit" disabled={sending}>{sending ? "提交中…" : "提交反馈"}</button>
            </form>
          </div>
        </>
      )}
      <div className="site-inbox-section site-inbox-business">
        <div className="site-inbox-section-heading"><strong>商务合作</strong><span>品牌合作与业务联系</span></div>
        <a href="mailto:jansee@jansee.cn">jansee@jansee.cn</a>
      </div>
    </section>
  );
}
