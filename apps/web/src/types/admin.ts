export interface AdminPricingPlan {
  id: string;
  name: string;
  priceYuan: number;
  strikeYuan: string;
}

export interface AdminPricingCatalog {
  members: AdminPricingPlan[];
  boostPacks: AdminPricingPlan[];
  sync?: {
    status: string;
    source: string;
    lastSyncedAt: string | null;
    productName?: string;
    priceVersions?: Record<string, number>;
    message?: string;
  };
}

export interface AdminOverviewStats {
  totalUsers: number;
  todayRevenueYuan: number;
  todayNewUsers: number;
  todayCompletedJobs: number;
  todayFailedJobs: number;
  jobSuccessRate: number;
  avgE2eDurationSec: number;
  p50E2eDurationSec: number;
  p90E2eDurationSec: number;
  p99E2eDurationSec: number;
  avgLlmDurationSec: number;
  avgTtsDurationSec: number;
  avgFfmpegDurationSec: number;
  avgRendererDurationSec: number;
  avgSceneScore: number;
  sceneScoreDataAvailable: boolean;
  totalJobs: number;
  failedJobs: number;
  directorTelemetryAvailable: boolean;
  directorCalls: number;
  primaryModelSuccessRate: number;
  fallbackModelRate: number;
  heuristicFallbackRate: number;
  totalTokensUsed: number;
  tokenUsageRecords: number;
  totalTtsChars: number;
  qualityCheckedJobs: number;
  qualityPassedJobs: number;
  qualityPassRate: number;
  totalCostEstimateYuan: number;
  variantHitRate: number;
  revenueDataAvailable?: boolean;
  costDataAvailable?: boolean;
  databaseDataAvailable?: boolean;
}

export interface DirectorJobInsight {
  jobId: string;
  userId: string;
  status: "queued" | "inspecting" | "planning" | "rendering" | "quality-check" | "completed" | "failed";
  aspectRatio: string;
  e2eDurationMs: number;
  llmDurationMs: number;
  ffmpegDurationMs: number;
  rendererDurationMs: number;
  ttsDurationMs: number;
  variantDirectorHit: boolean;
  variantType: string;
  variantTemplate: string;
  lockedVariant: string;
  variantMatched: boolean | null;
  voiceId: string;
  scene: string;
  sceneSource: string;
  sceneType: string;
  sceneScore: number;
  sceneAlignmentReason: string;
  tokensUsed: number;
  ttsChars: number;
  costEstimateYuan: number;
  tokenUsageAvailable: boolean;
  providerMode: string;
  requestedModel: string;
  selectedModel: string;
  modelsAttempted: string[];
  modelAttempts: Array<{ model: string; durationMs: number; ok: boolean; error?: string }>;
  costSource: string;
  qualityPassed: boolean;
  failureStage: string;
  creditsCharged: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  finishedAt?: string | null;
}

export interface PartnerPayoutProfile {
  userId: string;
  channel: string;
  accountLast4: string;
  displayName: string;
  contact: string;
  province: string | null;
  city: string | null;
  updatedAt: string;
}

export interface CityPartner {
  userId: string;
  displayName: string;
  contact: string;
  province: string | null;
  city: string | null;
  activatedAt: string;
  directInvites: number;
  secondLevelInvites: number;
  pendingCommissionYuan: number;
  settledCommissionYuan: number;
  reservedWithdrawalYuan: number;
  withdrawableYuan: number;
  payoutVerificationStatus: string;
  payoutAccountLast4: string | null;
}

export interface PartnerWithdrawal {
  id: string;
  userId: string;
  displayName: string;
  contact: string;
  amountYuan: number;
  feeYuan: number;
  netAmountYuan: number;
  status: string;
  note: string | null;
  externalReference: string | null;
  payoutChannel: string;
  accountLast4: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface SupportMessage {
  id: string;
  userId: string;
  orderId: string | null;
  displayName: string;
  contact: string;
  subject: string;
  message: string;
  status: "unread" | "read" | "resolved";
  createdAt: string;
}

export interface AdminInboxMessage {
  id: string;
  subject: string;
  body: string;
  category: "welcome" | "features" | "notice";
  status: "draft" | "published";
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface UserAnalyticsData {
  summary: {
    totalUsers: number;
    activeUsers: number;
    todayNewUsers: number;
    last7Days: number;
    last30Days: number;
    geoUsers: number;
    unknownRegionUsers: number;
  };
  trend: { day: string; registrations: number; completedJobs: number; revenueYuan: number }[];
  regions: { province: string; users: number; cities: { city: string; users: number }[] }[];
  users: {
    id: string;
    displayName: string;
    contact: string;
    status: string;
    createdAt: string;
    province: string | null;
    city: string | null;
    region: string;
    credits: number;
    completedJobs: number;
    downloads: number;
  }[];
  total: number;
  limit: number;
  offset: number;
  regionDataAvailable: boolean;
}

export interface SiteAnalyticsData {
  summary: { pv: number; uv: number; days: number };
  series: { day: string; pv: number; uv: number }[];
  dimensions: {
    pages: Record<string, number>;
    sources: Record<string, number>;
    regions: Record<string, number>;
    devices: Record<string, number>;
    browsers: Record<string, number>;
  };
  note: string;
}

export interface ServerHealthData {
  sampledAt: string;
  host: { platform: string; architecture: string; hostname: string; cpuCores: number; uptimeSeconds: number };
  cpu: { usagePercent: number | null; loadAverage: number[] };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
  };
  disk: { totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number | null } | null;
  cloudStorage?: {
    todayCdnBytes: number;
    todayDirectCosBytes: number;
    todayCdnOriginBytes: number;
    accountBalanceYuan: number | null;
    estimatedCostTodayYuan: number;
    isDirectCosLeak: boolean;
    sampledAt: string;
  };
  mediaStorage?: {
    driver: string;
    bucket: string | null;
    region: string | null;
    activeOutputsCount: number;
    activeOutputsBytes: number;
    activeAssetsCount: number;
    activeAssetsBytes: number;
    totalBytes: number;
  } | null;
  services: Record<string, { status: string; detail: string }>;
}

export interface AdminConsoleProps {
  onClose: () => void;
}

