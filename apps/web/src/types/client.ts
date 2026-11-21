import type { CreationMode } from "@jansee/contracts";

export type ClientPlatform = "ios" | "android" | "desktop";

export type Attachment = {
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

export type ChatMessage = {
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

export type AuthUser = {
  id: string;
  email?: string;
  phone?: string;
  displayName: string | null;
  createdAt: string;
  isGuest?: boolean;
};

export type SavedConversation = {
  id: string;
  title: string;
  updatedAt: number;
  creationMode?: CreationMode;
  creationScene?: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  messages: ChatMessage[];
  pendingOrder?: {
    orderId: string;
    payUrl: string;
    qrImageUrl: string;
    packageName: string;
    amountYuan: number;
    credits: number;
    expiresAt?: string;
    createdAt?: number;
  } | null;
};

export type BillingHistoryKind = "orders" | "ledger";

export type BillingOrder = {
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

export type BillingLedgerEntry = {
  id: string;
  jobId?: string;
  orderId?: string;
  type: "grant" | "hold" | "settle" | "refund" | "recharge" | "compensation";
  amount: number;
  description: string;
  createdAt: string;
};

export type SiteInboxMessage = {
  id: string;
  subject: string;
  body: string;
  category: "welcome" | "features" | "notice";
  publishedAt: string | null;
  readAt: string | null;
};

export interface JobDeliveryVideoPlayerProps {
  workId: string;
  activeId: string | null;
  onPlay: (id: string) => void;
  onPause: () => void;
}

