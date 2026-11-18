import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type TouchEvent } from "react";
import type { CreationMode } from "@jansee/contracts";
import { AdminConsole } from "./AdminConsole";
import QRCode from "qrcode";

type Attachment = {
  name: string;
  kind: "image" | "video";
  size: number;
  assetId?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "director";
  speaker?: string;
  text: string;
  jobStage?: string;
  creationScene?: "online-ecommerce" | "physical-store" | "personal-creation";
  creationMode?: CreationMode;
  attachments?: Attachment[];
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

type SpeechResult = { 0: { transcript: string }; isFinal: boolean };
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

const JOB_PROGRESS_LOGS: Record<string, Array<{ speaker: string; text: string }>> = {
  queued: [{ speaker: "简兮导演", text: "我已接到你的创作需求，正在统筹制作安排。" }],
  inspecting: [{ speaker: "简兮美术师", text: "素材已收到，我正在核对素材是否齐全、可读取，为后续画面处理做好准备。" }],
  planning: [{ speaker: "简兮导演", text: "素材检查完成，创作方案已确定；我正在把镜头结构与表达方向交给制作流程。" }],
  rendering: [
    { speaker: "简兮剪辑师", text: "我正在编排镜头与转场，让画面衔接自然、节奏清晰。" },
    { speaker: "简兮音效师", text: "我正在把配音与背景音乐按画面节奏整合，让声音层次更协调。" },
    { speaker: "简兮包装师", text: "我正在整合字幕、片头片尾与视觉细节，让成片完整呈现。" },
  ],
  "quality-check": [{ speaker: "简兮质检师", text: "成片已经生成，我正在检查文件完整性、声音轨道与交付合规信息。" }],
  completed: [{ speaker: "简兮导演", text: "成片已通过检查并完成交付，你可以直接在这里预览。" }],
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
  const [creationScene, setCreationScene] = useState<"online-ecommerce" | "physical-store" | "personal-creation" | "">("online-ecommerce");
  const scenePlaceholders: Record<typeof creationScene, string> = {
    "online-ecommerce": "说说产品亮点，和想打动的人",
    "physical-store": "聊聊店铺特色，和想吸引的客人",
    "personal-creation": "描述素材故事，和期待的画面",
    "": "说说你想创作什么"
  };
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const uploadPromisesRef = useRef<Map<string, Promise<string>>>(new Map());
  const [fileError, setFileError] = useState("");
  const [isDirectorThinking, setIsDirectorThinking] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isUploadMenuOpen, setIsUploadMenuOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeHeaderPanel, setActiveHeaderPanel] = useState<"works" | "login" | "recharge" | "orders" | "ledger" | "inbox" | "admin" | "admin-login" | null>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (window.location.hostname.toLowerCase() === "admin.jansee.cn" || window.location.pathname.replace(/\/+$/, "") === "/admin" || params.get("admin") === "1" || window.location.hash === "#admin") {
        return "admin-login";
      }
    }
    return null;
  });
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
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
      .then(async (response) => response.ok ? await response.json() as { user: AuthUser } : null)
      .then((payload) => {
        if (active && payload?.user) {
          setAuthUser(payload.user);
          refreshWallet();
        }
      })
      .catch(() => undefined)
      .finally(() => { if (active) setAuthResolved(true); });
    refreshWallet();
    return () => { active = false; };
  }, [refreshWallet]);

  // Authenticated conversation history belongs to the account database, never shared browser storage.
  useEffect(() => {
    if (!authResolved) return;
    let active = true;
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
              .find((item) => item.id === `job-log-${jobId}-completed`);
            attachWorkOutput(jobId, completionLog?.id ?? `job-log-${jobId}-completed`);
            return;
          }
          const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
          if (!response.ok) return;
          const payload = await response.json() as { job?: { status?: string; progress?: number; errorMessage?: string | null; directorPlan?: Record<string, unknown> | null } };
          if (!active || !payload.job) return;
          const job = payload.job;
          setConversations((current) => {
            const conversationIndex = current.findIndex((conversation) => conversation.messages.some((item) => item.jobId === jobId));
            if (conversationIndex < 0) return current;
            const conversation = current[conversationIndex]!;
            const anchor = conversation.messages.find((item) => item.jobId === jobId);
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
            const stageLogs = nextStatus === "failed"
              ? [{ speaker: "简兮导演", text: "这次制作遇到了问题：" + (nextError || "未知原因") + "。制作消耗的积分已经原路退回。" }]
              : (JOB_PROGRESS_LOGS[nextStatus] ?? []);
            const logIds = stageLogs.map((_, index) => index === 0
              ? `job-log-${jobId}-${nextStatus}`
              : `job-log-${jobId}-${nextStatus}-${index + 1}`);
            const loggedIds = new Set(conversation.messages.filter((item) => logIds.includes(item.id)).map((item) => item.id));
            if (unchanged && loggedIds.size === logIds.length) return current;
            const logIndexes = new Map(logIds.map((logId, index) => [logId, index]));
            const messages = conversation.messages.map((item) => {
              if (item.jobId === jobId) return {
                ...item,
                jobStatus: nextStatus,
                ...(nextProgress !== undefined ? { jobProgress: nextProgress } : {}),
                ...(nextError !== undefined ? { jobError: nextError } : {}),
                ...(nextPlan !== undefined ? { jobDirectorPlan: nextPlan } : {}),
              };
              if (logIndexes.has(item.id)) return {
                ...item,
                jobStatus: nextStatus,
                ...(nextProgress !== undefined ? { jobProgress: nextProgress } : {}),
              };
              return item;
            });
            stageLogs.forEach((stageLog, index) => {
              const logId = logIds[index]!;
              if (loggedIds.has(logId)) return;
              messages.push({
                id: logId,
                role: "director",
                speaker: stageLog.speaker,
                text: stageLog.text,
                jobStage: nextStatus,
                jobStatus: nextStatus,
                ...(nextProgress !== undefined ? { jobProgress: nextProgress } : {}),
                ...(nextStatus === "completed" && nextPlan ? { jobDirectorPlan: nextPlan } : {}),
              });
            });
            const nextConversation = { ...conversation, updatedAt: Date.now(), messages };
            const next = [...current];
            next[conversationIndex] = nextConversation;
            return next;
          });
          if (job.status === "completed") attachWorkOutput(jobId, `job-log-${jobId}-completed`);
        } catch {
          // A temporary network failure must not erase the accepted job or its last known progress.
        }
      }));
    };
    void refreshJobs();
    const timer = window.setInterval(() => { void refreshJobs(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversations]);

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
          const payload = await response.json() as { session?: {
            status: ChatMessage["speechCutStatus"];
            suggestions?: NonNullable<ChatMessage["speechCutSuggestions"]>;
            errorMessage?: string | null;
          } };
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
  }, [conversations]);

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
    const request = (async () => {
      const response = await fetch("/api/v1/assets", { method: "POST", credentials: "include", body: formData });
      const payload = await response.json().catch(() => ({})) as { assets?: Array<{ assetId: string }>; error?: { message?: string } };
      if (!response.ok || !payload.assets || payload.assets.length !== batch.length) {
        throw new Error(payload.error?.message || "素材上传失败，请检查登录状态或稍后重试。");
      }
      return payload.assets;
    })();
    batch.forEach((file, index) => {
      const key = fileKey(file);
      uploadPromisesRef.current.set(key, request.then((assets) => {
        const asset = assets[index];
        if (!asset) throw new Error("素材上传结果不完整，请重试。");
        return asset.assetId;
      }).catch((error) => {
        uploadPromisesRef.current.delete(key);
        setFileError(error instanceof Error ? error.message : "素材上传失败，请重试。");
        throw error;
      }));
    });
  }

  function removeFile(index: number) {
    const removed = files[index];
    if (removed) {
      const key = fileKey(removed);
      uploadPromisesRef.current.delete(key);
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
    if (!files.length) { setFileError("请先上传图片或视频素材，导演才能结合实际素材制定方案。"); return; }
    if (!trimmed) { setFileError("请告诉导演你希望这支视频呈现什么内容或效果。"); return; }
    if (!creationScene) { setFileError("请先选择创作场景：带货视频、实体店或个人。"); return; }
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; setIsListening(false); }
    const firstFile = files[0]; if (!firstFile) return;
    const kind = mediaKind(firstFile); if (!kind) return;
    const mode: CreationMode = kind === "image" ? "image-film" : files.length === 1 ? "video-dub" : "storyboard";
    const directorPrompt = `[User-selected creation scene: ${creationScene}. Treat this scene as authoritative; never reclassify it from keywords or filenames. If the request conflicts with the selected scene, ask for clarification.]\n${trimmed}`;
    if (mode === "storyboard" && files.length < 2) { setFileError("分镜成片至少需要两个视频素材。"); return; }
    if (!authUser) {
      setFileError("\u8bf7\u5148\u767b\u5f55\u6216\u6ce8\u518c\uff0c\u518d\u4e0a\u4f20\u7d20\u6750\u5e76\u5f00\u59cb\u521b\u4f5c\u3002");
      setActiveHeaderPanel("login");
      return;
    }
    if (authUser.id !== "local-preview-user" && conversationsOwnerId !== authUser.id) {
      setFileError("正在读取账号历史对话，请稍后再提交，避免覆盖未加载的记录。");
      return;
    }
    const pendingAssetUploads = files.map((file) => uploadPromisesRef.current.get(fileKey(file)));
    setIsDirectorThinking(true); setFileError("");
    const conversationId = activeConversationId ?? (authUser.id !== "local-preview-user" ? crypto.randomUUID() : makeId());
    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text: trimmed,
      creationScene,
      creationMode: mode,
      attachments: files.map((file) => ({ name: file.name, kind: mediaKind(file)!, size: file.size })),
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
      text: authUser.id === "local-preview-user"
        ? "收到，我先整理你的需求，给你排一版导演方案。"
        : "素材我已经收下了。我先把你的需求排成制作方案，然后直接开始做，过程随时跟你汇报。",
    };
    const messagesWithAck = [...baseMessages, ackMessage];
    const conversationWithAck: SavedConversation = {
      ...baseConversation,
      title: makeConversationTitle(messagesWithAck),
      messages: messagesWithAck,
    };
    setConversations((current) => [conversationWithAck, ...current.filter((conversation) => conversation.id !== conversationId)].slice(0, MAX_SAVED_CONVERSATIONS));
    // Move the request into the conversation immediately; keep upload promises locally while clearing the composer.
    setDraft("");
    setCreationScene("");
    setFiles([]);
    uploadPromisesRef.current.clear();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      if (authUser.id !== "local-preview-user") {
        try {
          await saveAccountConversation(conversationWithAck);
        } catch {
          throw new Error("创作需求未能保存到账号数据库，请检查网络后重试。");
        }
        let assetIds: string[];
        try {
          assetIds = await Promise.all(pendingAssetUploads.map((pending) => {
            if (!pending) throw new Error("素材还未上传完成，请稍候再试。");
            return pending;
          }));
        } catch {
          throw new Error("素材上传还没有完成，请在输入框确认素材状态后重新发送。");
        }
        const attachments: Attachment[] = files.map((file, index) => ({
          name: file.name,
          kind: mediaKind(file)!,
          size: file.size,
          assetId: assetIds[index]!,
        }));
        const baseMessagesWithAssets = messagesWithAck.map((message) => message.id === userMessage.id ? { ...message, attachments } : message);
        setConversations((current) => current.map((conversation) => conversation.id === conversationId
          ? { ...conversation, updatedAt: Date.now(), messages: baseMessagesWithAssets }
          : conversation));

        if (mode === "video-dub" && isSpeechCutIntent(trimmed)) {
          const speechResponse = await fetch("/api/v1/speech-cut/analyze", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assetId: assetIds[0] }),
          });
          const speechPayload = await speechResponse.json() as { session?: { id: string; status: string }; error?: { message?: string } };
          if (!speechResponse.ok || !speechPayload.session) throw new Error(speechPayload.error?.message || "语音分析任务创建失败，请稍后重试。");
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
          setCreationScene("");
          setFiles([]);
          if (textareaRef.current) textareaRef.current.style.height = "auto";
          return;
        }

        const response = await fetch("/api/v1/director/plan", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            prompt: directorPrompt,
            aspectRatio: "9:16",
            assetIds,
            assets: attachments.map(({ name, kind, size }) => ({ name, kind, size })),
          }),
        });
        const payload = await response.json() as {
          plan?: {
            title: string;
            concept: string;
            durationSeconds: number;
            scenes: Array<{ order: number; description: string; durationSeconds: number }>;
            style: string;
            soundtrack: string;
            anchor?: string;
            voice_id?: string;
            bgm_emotion?: string;
          };
          batch?: { total?: number };
          error?: { message?: string };
        };
        if (!response.ok || !payload.plan) throw new Error(payload.error?.message || "导演服务暂时不可用，请稍后重试。");
        const plan = payload.plan;
        // 多版成片（批量赛马）：版数来自服务端对用户文字/语音输入的解析，非滑动条
        const batchTotal = Math.max(1, Math.min(10, Math.floor(payload.batch?.total ?? 1)));
        // 方案确认环节已下线：方案生成后直接创建制作任务，进度像聊天一样逐条汇报。
        const jobResponse = await fetch("/api/v1/jobs", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            prompt: directorPrompt,
            aspectRatio: "9:16",
            assetIds,
            directorPlan: plan as Record<string, unknown>,
            idempotencyKey: crypto.randomUUID(),
            ...(batchTotal > 1 ? { versions: batchTotal } : {}),
          }),
        });
        type CreatedJob = { id: string; status: string; progress: number };
        const jobData = await jobResponse.json() as { job?: CreatedJob; jobs?: CreatedJob[]; batch?: { total?: number }; error?: { message?: string } };
        const createdJobs: CreatedJob[] = jobData.jobs ?? (jobData.job ? [jobData.job] : []);
        if (!jobResponse.ok || createdJobs.length === 0) throw new Error(jobData.error?.message || "创建制作任务失败，请稍后重试。");
        refreshWallet();
        const directorRoleLine = creationScene === "online-ecommerce"
          ? "推荐主播：" + (plan.anchor || "未指定") + "（音色气质：" + (plan.voice_id || "温暖亲切") + "）"
          : creationScene === "physical-store"
            ? "推荐实体角色：" + (plan.anchor || "未指定") + "（音色气质：" + (plan.voice_id || "温暖亲切") + "）"
            : null;
        const planList = [
          ...plan.scenes.map((scene) => "镜头 " + scene.order + "（" + scene.durationSeconds + " 秒）：" + scene.description),
          "整体风格：" + plan.style,
          "配乐方向：" + plan.soundtrack,
          ...(directorRoleLine ? [directorRoleLine] : []),
          "BGM 情绪：" + (plan.bgm_emotion || "温和垫底") + "（两段式音量 0.10/0.22 避让人声）",
          "转场效果：0.7 秒柔和叠画（宪法级过渡）",
          "建议成片时长：" + plan.durationSeconds + " 秒",
        ];
        if (batchTotal > 1 && createdJobs.length > 1) {
          // 批量赛马：方案一条 + 每版独立进度卡片（每条各自轮询各自的 jobId）。
          const planMessage: ChatMessage = {
            id: makeId(), role: "director",
            text: "方案排好了：" + plan.title + "。" + plan.concept + " 我会按这条方案产出 " + createdJobs.length + " 版差异化成片（每版走不同的风格路线），合计消耗 " + createdJobs.length * 200 + " 积分，先做完的版本先给你看。",
            plan: planList,
          };
          const versionMessages: ChatMessage[] = createdJobs.map((job, index) => ({
            id: makeId(), role: "director",
            text: "第 " + (index + 1) + "/" + createdJobs.length + " 版开始制作，做好了直接发给你。",
            jobId: job.id,
            jobStatus: job.status,
            jobProgress: job.progress,
            jobDirectorPlan: plan as Record<string, unknown>,
          }));
          const nextMessages = [...baseMessagesWithAssets, planMessage, ...versionMessages];
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : conversation));
        } else {
          const directorMessage: ChatMessage = {
            id: makeId(), role: "director",
            text: "方案排好了：" + plan.title + "。" + plan.concept + " 我现在就开始制作，做好了直接发给你（本次制作消耗 200 积分）。",
            plan: planList,
            jobId: createdJobs[0]!.id,
            jobStatus: createdJobs[0]!.status,
            jobProgress: createdJobs[0]!.progress,
            jobDirectorPlan: plan as Record<string, unknown>,
          };
          const nextMessages = [...baseMessagesWithAssets, directorMessage];
          setConversations((current) => current.map((conversation) => conversation.id === conversationId
            ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : conversation));
        }
      } else {
        const response = await fetch("/api/v1/director/plan", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode,
            prompt: directorPrompt,
            aspectRatio: "9:16",
            assets: files.map((file) => ({ name: file.name, kind: mediaKind(file)!, size: file.size })),
          }),
        });
        const payload = await response.json() as {
          plan?: {
            title: string;
            concept: string;
            durationSeconds: number;
            scenes: Array<{ order: number; description: string; durationSeconds: number }>;
            style: string;
            soundtrack: string;
          };
          error?: { message?: string };
        };
        if (!response.ok || !payload.plan) throw new Error(payload.error?.message || "导演服务暂时不可用，请稍后重试。");
        const plan = payload.plan;
        const directorMessage: ChatMessage = {
          id: makeId(), role: "director",
          text: "方案排好了：" + plan.title + "。" + plan.concept + " 这是预览方案；登录后我就能正式开始制作。",
          plan: [
            ...plan.scenes.map((scene) => "镜头 " + scene.order + "（" + scene.durationSeconds + " 秒）：" + scene.description),
            "整体风格：" + plan.style,
            "配乐方向：" + plan.soundtrack,
            "建议成片时长：" + plan.durationSeconds + " 秒",
          ],
        };
        const nextMessages = [...messagesWithAck, directorMessage];
        setConversations((current) => current.map((conversation) => conversation.id === conversationId
          ? { ...conversation, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
          : conversation));
      }
      setDraft(""); setCreationScene(""); setFiles([]);
      uploadPromisesRef.current.clear();
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (error) {
      const reason = error instanceof Error ? error.message : "创作过程中遇到问题，请稍后重试。";
      setConversations((current) => current.map((conversation) => conversation.id === conversationId
        ? { ...conversation, updatedAt: Date.now(), messages: [...conversation.messages, { id: makeId(), role: "director" as const, text: "这次创作没能继续：" + reason }] }
        : conversation));
    } finally { setIsDirectorThinking(false); }
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
      submitMessage();
    }
  }

  function toggleVoiceInput() {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      setIsListening(false);
      return;
    }

    const speechWindow = window as SpeechWindow;
    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setFileError("当前浏览器暂不支持语音输入，请使用 Chrome 或 Edge。");
      return;
    }

    setFileError("");
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
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
    recognition.onerror = () => {
      setIsListening(false);
      recognitionRef.current = null;
      setFileError("语音输入暂不可用，请检查麦克风权限。");
    };
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };

    try {
      recognitionRef.current = recognition;
      recognition.start();
      setIsListening(true);
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
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
            <div className="welcome-workflows" aria-label="简兮的两种视频创作方式">
              <p className="welcome-workflow">
                <span>出片流 · 自动创作</span><small>上传图片视频素材｜自动生成完整成片</small>
              </p>
              <p className="welcome-workflow">
                <span>剪辑流 · 一句话剪辑</span><small>一句话描述剪辑效果｜自动完成视频剪辑</small>
              </p>
            </div>
          </div>
        ) : (
          <div className="message-thread" aria-live="polite">
            {messages.map((message) => (
              <article className={`message-row message-${message.role}`} key={message.id}>
                <div className="message-content">
                  <div className="message-author">{message.role === "user" ? "你" : (message.speaker || "简兮导演")}</div>
                  <div className="message-bubble">
                    <p>{message.text}</p>
                    {message.jobStage && (
                      <div className={`job-progress-inline ${message.jobStatus === "failed" ? "is-failed" : ""}`}>
                        <div className="job-progress-inline-heading">
                          <span>{message.jobStatus === "completed" ? "制作完成" : message.jobStatus === "failed" ? "制作中断" : "当前进度"}</span>
                          <strong>{message.jobStatus === "failed" ? "未完成" : `${Math.round(Math.max(0, Math.min(100, message.jobProgress ?? 0)))}%`}</strong>
                        </div>
                        {message.jobStatus !== "failed" && (
                          <div
                            className="job-progress-inline-track"
                            role="progressbar"
                            aria-label="制作进度"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(Math.max(0, Math.min(100, message.jobProgress ?? 0)))}
                          >
                            <span style={{ width: `${Math.max(0, Math.min(100, message.jobProgress ?? 0))}%` }} />
                          </div>
                        )}
                      </div>
                    )}

                    {message.jobWorkId && (
                      <div className="job-delivery">
                        <video
                          className="job-delivery-video"
                          src={"/api/v1/works/" + message.jobWorkId + "/stream"}
                          controls
                          playsInline
                          preload="metadata"
                          onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.1; }}
                          aria-label="简兮导演发来的成片，点击播放"
                        />
                        {(() => {
                          const publish = (message.jobDirectorPlan?.publish ?? {}) as Record<string, unknown>;
                          const caption = typeof publish.caption === "string" && publish.caption.trim() ? publish.caption.trim() : "";
                          const fields = [["封面标题", publish.cover_title], ["置顶评论", publish.pinned_comment], ["建议发布时间", publish.post_time]].filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0);
                          if (!caption && !fields.length) return null;
                          return (
                            <div className="job-publish">
                              {caption && (
                                <p className="job-publish-caption">
                                  <span>{caption}</span>
                                  <button
                                    type="button"
                                    className="job-publish-copy"
                                    onClick={() => { if (!navigator.clipboard) { setFileError("当前浏览器不支持一键复制，请手动选择文案。"); return; } void navigator.clipboard.writeText(caption).then(() => setFileError("发布文案已复制。")).catch(() => setFileError("复制失败，请手动选择文案。")); }}
                                  >复制</button>
                                </p>
                              )}
                              {fields.length > 0 && (
                                <div className="job-publish-fields">
                                  {fields.map(([label, value]) => <p key={label}><span>{label}</span>{value}</p>)}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {message.plan && (
                      <div className="director-plan">
                        <div className="plan-heading">导演构思 · 创作方案</div>
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
                                    {message.speechCutSubmitting ? "正在提交…" : "确认精剪并开始制作（200 积分）"}
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
          </div>
        )}
      </section>

      <footer className="composer-dock">
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
                  </div>



                  <div className="pending-controls">
                    <button type="button" className="pending-remove" aria-label={`移除 ${file.name}`} onClick={() => removeFile(index)}>×</button>
                  </div>
                </article>
              ))}
            </div>
          )}
          {fileError && <p className="composer-error" role="alert">{fileError}</p>}
          <div className="creation-scene-picker" role="group" aria-label={"\u9009\u62e9\u521b\u4f5c\u573a\u666f"}>

            <div className="creation-scene-options">
              <button type="button" className={creationScene === "online-ecommerce" ? "is-selected" : ""} aria-pressed={creationScene === "online-ecommerce"} onClick={() => { setCreationScene("online-ecommerce"); setFileError(""); }}>{"\u5e26\u8d27\u89c6\u9891"}</button>
              <button type="button" className={creationScene === "physical-store" ? "is-selected" : ""} aria-pressed={creationScene === "physical-store"} onClick={() => { setCreationScene("physical-store"); setFileError(""); }}>{"\u95e8\u5e97\u83b7\u5ba2"}</button>
              <button type="button" className={creationScene === "personal-creation" ? "is-selected" : ""} aria-pressed={creationScene === "personal-creation"} onClick={() => { setCreationScene("personal-creation"); setFileError(""); }}>{"\u4e2a\u4eba\u521b\u4f5c"}</button>
            </div>
          </div>
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
              placeholder={scenePlaceholders[creationScene]}
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
                aria-label={isListening ? "停止语音输入" : "语音输入"}
                title={isListening ? "停止语音输入" : "语音输入"}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="12" rx="3" />
                  <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" />
                </svg>
              </button>
              <button className="send-button" type="submit" disabled={isDirectorThinking || (!draft.trim() && files.length === 0)} aria-label={isDirectorThinking ? "导演正在构思" : "发送消息"} title={isDirectorThinking ? "导演正在构思" : "发送"}>
                {isDirectorThinking ? <span className="send-loading" aria-hidden="true">···</span> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}
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
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("recharge"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></svg>
                <span>算力积分</span>
                {walletCredits !== null && <span className="drawer-credit-value">{String(walletCredits)}分</span>}
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("orders"); }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 2-1.5Z" /><path d="M14.5 3.5V8H19M8 12h8M8 16h8" /></svg>
                <span>订单记录</span>
              </button>
              <button
                className="drawer-credit-link"
                type="button"
                onClick={() => { setIsSidebarOpen(false); setActiveHeaderPanel("ledger"); }}
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
          <AdminConsole onClose={() => setActiveHeaderPanel(null)} />
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
              ) : (
                <AuthPanel
                  user={authUser}
                  onSuccess={(user) => { setAuthUser(user); setActiveHeaderPanel(null); }}
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

type AuthUser = { id: string; email?: string; phone?: string; displayName: string | null; createdAt: string };

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
  const [displayNameError, setDisplayNameError] = useState("");
  const [code, setCode] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
  const [growthNotice, setGrowthNotice] = useState("");
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

  if (user) return <>
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

type WorkItem = {
  id: string;
  jobId: string;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
};

function WorksPanel({ user, onNew }: { user: AuthUser | null; onNew: () => void }) {
  const [works, setWorks] = useState<WorkItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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

  if (!user) {
    return (
      <>
        <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v4m4-4v4m4-4v4M8 15h8" /></svg></div>
        <h2 id="header-panel-title">我的成片</h2>
        <p className="header-panel-copy">请先登录，即可查看你生成的所有商业短视频成片。</p>
        <button className="panel-primary-action" type="button" onClick={onNew}>开始创作</button>
      </>
    );
  }

  return (
    <>
      <div className="panel-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M8 5v4m4-4v4m4-4v4M8 15h8" /></svg></div>
      <h2 id="header-panel-title">我的成片</h2>
      <p className="header-panel-copy">已制作完成的视频成片集中保存在这里（成片文件将保留 24 小时）。</p>
      {error && <p className="composer-error" role="alert">{error}</p>}
      {loading ? (
        <p style={{ textAlign: "center", color: "#666", padding: "24px 0" }}>正在加载作品库…</p>
      ) : works.length > 0 ? (
        <div className="works-list" style={{ display: "flex", flexDirection: "column", gap: "12px", maxHeight: "360px", overflowY: "auto", margin: "16px 0" }}>
          {works.map((work) => (
            <article key={work.id} style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: "8px", padding: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{works.filter((item) => item.jobId === work.jobId).length > 1 ? `\u5207\u7247 ${works.filter((item) => item.jobId === work.jobId).findIndex((item) => item.id === work.id) + 1}/${works.filter((item) => item.jobId === work.jobId).length}` : "\u6210\u7247 MP4"}</strong>
                <span style={{ fontSize: "12px", color: "#888" }}>{(work.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
              </div>
              <video src={`/api/v1/works/${work.id}/stream`} controls style={{ width: "100%", maxHeight: "200px", borderRadius: "4px", backgroundColor: "#000" }} preload="metadata" />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: "#666" }}>
                <span>生成时间: {new Date(work.createdAt).toLocaleDateString()}</span>
                <a href={`/api/v1/works/${work.id}/stream?download=1`} download={works.filter((item) => item.jobId === work.jobId).length > 1 ? `jansee-slice-${String(works.filter((item) => item.jobId === work.jobId).findIndex((item) => item.id === work.id) + 1).padStart(2, "0")}-of-${works.filter((item) => item.jobId === work.jobId).length}.mp4` : `jansee-${work.id}.mp4`} style={{ color: "#1a73e8", textDecoration: "none", fontWeight: 500 }}>下载成片</a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel-empty-state">
          <span className="panel-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 10 6-10 6z" /></svg></span>
          <strong>暂无成片</strong>
          <span>你还没有制作成片，快去让简兮导演为你制作第一支商业视频吧！</span>
        </div>
      )}
      <button className="panel-primary-action" type="button" onClick={onNew}>开始新创作</button>
    </>
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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pricingCatalog, setPricingCatalog] = useState<{ members: { id: string; priceYuan: number; strikeYuan: string }[]; boostPacks: { id: string; priceYuan: number; strikeYuan: string }[] } | null>(null);

  useEffect(() => {
    let active = true;
    const refreshPricing = () => {
      fetch("/api/v1/pricing", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) return null;
        return await response.json() as { members?: { id: string; priceYuan: number; strikeYuan: string }[]; boostPacks?: { id: string; priceYuan: number; strikeYuan: string }[] };
      }).then((data) => { if (active && data?.members && data?.boostPacks) setPricingCatalog(data as NonNullable<typeof pricingCatalog>); }).catch(() => {});
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
        <small>每生成 1 条成片消耗 200 积分</small>
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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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

function SiteInboxPanel({ user, onLogin }: { user: AuthUser | null; onLogin: () => void }) {
  const [messages, setMessages] = useState<SiteInboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subject, setSubject] = useState("产品建议");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");

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
