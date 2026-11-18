import { z } from "zod";

export const CreationModeSchema = z.enum(["image-film", "video-dub", "storyboard"]);
export type CreationMode = z.infer<typeof CreationModeSchema>;
export const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:3"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const CreateDirectorRequestSchema = z.object({
  mode: CreationModeSchema,
  prompt: z.string().trim().min(1).max(2_000),
  assetIds: z.array(z.string().uuid()).min(1).max(9)
    .refine((ids) => new Set(ids).size === ids.length, "素材不能重复"),
  aspectRatio: AspectRatioSchema.default("9:16"),
  idempotencyKey: z.string().uuid(),
}).strict().superRefine((request, context) => {
  if (request.mode === "video-dub" && request.assetIds.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["assetIds"],
      message: "视频配音必须且只能选择一个视频素材",
    });
  }
  if (request.mode === "storyboard" && request.assetIds.length < 2) {
    context.addIssue({
      code: "custom",
      path: ["assetIds"],
      message: "多视频分镜合成至少需要两个视频素材",
    });
  }
});

export type CreateDirectorRequest = z.infer<typeof CreateDirectorRequestSchema>;

export const JobStatusSchema = z.enum([
  "queued", "inspecting", "planning", "rendering",
  "quality-check", "completed", "failed", "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CAPABILITIES = [
  {
    id: "image-film",
    label: "图片成片",
    description: "几张实拍图，交给导演完成一支完整视频",
    acceptedMedia: ["image"],
    minAssets: 1,
    maxAssets: 9,
  },
  {
    id: "video-dub",
    label: "视频配音",
    description: "一段原始视频，自动完成旁白、字幕、音乐与收束",
    acceptedMedia: ["video"],
    minAssets: 1,
    maxAssets: 1,
  },
  {
    id: "storyboard",
    label: "多视频分镜合成",
    description: "多段视频素材，自动整理节奏与叙事顺序",
    acceptedMedia: ["video"],
    minAssets: 2,
    maxAssets: 9,
  },
] as const satisfies ReadonlyArray<{
  id: CreationMode;
  label: string;
  description: string;
  acceptedMedia: readonly ("image" | "video")[];
  minAssets: number;
  maxAssets: number;
}>;

export function getCapability(mode: CreationMode) {
  return CAPABILITIES.find((item) => item.id === mode)!;
}
