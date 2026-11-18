import type { CreationMode } from "@jansee/contracts";
import type { AssetRecord } from "./assets.js";
import type { LocalObjectStorage } from "./storage-local.js";
import type { MediaRenderer } from "./renderer.js";
import type { GenerationJobRecord } from "./jobs.js";

/**
 * Internal production-engine catalogue.
 * These IDs describe executable production capabilities, not UI tools.
 * A DirectorPlan may combine several capabilities in one user request.
 */
export const ENGINE_CATALOG = {
  "image-film": {
    id: "image-film",
    modes: ["image-film"] as const,
    source: "@jansee/image-film",
    responsibilities: ["image sequencing", "motion/layout", "voiceover", "BGM", "intro", "ending", "captions", "AI provenance"],
  },
  "video-dub": {
    id: "video-dub",
    modes: ["video-dub"] as const,
    source: "@jansee/video-dub",
    responsibilities: ["video voiceover", "timed captions", "BGM ducking", "intro", "ending", "AI provenance"],
  },
  storyboard: {
    id: "storyboard",
    modes: ["storyboard"] as const,
    source: "@jansee/video-creator/video/storyboard.js",
    responsibilities: ["multi-asset sequencing", "crossfade", "original-audio path", "TTS/ASR subtitle path", "BGM"],
  },
} as const;

export type ProductionEngineId = keyof typeof ENGINE_CATALOG;

export interface EngineExecutionContext {
  jobId: string;
  userId: string;
  mode: CreationMode;
  prompt: string;
  aspectRatio: string;
  assetIds: readonly string[];
  assets: readonly AssetRecord[];
  storage: LocalObjectStorage;
  taskDir: string;
  directorPlan: Record<string, unknown>;
  job: GenerationJobRecord;
  renderer: MediaRenderer;
}

export interface EngineExecutionResult {
  outputPath?: string;
  storageKey?: string;
  sizeBytes?: number;
  mimeType?: "video/mp4";
  ttsDurationMs?: number;
  ffmpegDurationMs?: number;
  durationMs: number;
  width?: number;
  height?: number;
  warnings?: string[];
  subtitleTimeline?: Array<{ start: number; end: number }>;
}

export interface ProductionEngine {
  readonly id: ProductionEngineId;
  execute(context: EngineExecutionContext): Promise<EngineExecutionResult>;
}

export interface ProductionEngineRegistry {
  resolve(mode: CreationMode): ProductionEngine;
  list(): readonly ProductionEngineId[];
}

export function createProductionEngineRegistry(
  engines: readonly ProductionEngine[],
): ProductionEngineRegistry {
  const byId = new Map<ProductionEngineId, ProductionEngine>();
  for (const engine of engines) {
    if (!(engine.id in ENGINE_CATALOG)) throw new Error(`Unknown production engine: ${engine.id}`);
    if (byId.has(engine.id)) throw new Error(`Duplicate production engine: ${engine.id}`);
    byId.set(engine.id, engine);
  }

  return {
    resolve(mode) {
      const engine = byId.get(mode);
      if (!engine) throw new Error(`PRODUCTION_ENGINE_UNAVAILABLE: ${mode}`);
      return engine;
    },
    list() {
      return [...byId.keys()];
    },
  };
}

/** Maps the current public creation modes to their dedicated production engines. */
export function engineIdForMode(mode: CreationMode): ProductionEngineId {
  return mode;
}
