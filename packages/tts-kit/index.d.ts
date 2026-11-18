export type TencentVoiceGender = "male" | "female";
export type TencentVoiceLanguage = "zh" | "zh-en" | "en" | "yue";
export interface TencentVoiceCandidate {
  voiceType: number;
  gender: TencentVoiceGender;
  language: TencentVoiceLanguage;
  label: string;
}
export interface TencentVoiceHealthRow {
  voiceType: number;
  status: "healthy" | "unavailable" | "unknown";
}
export interface TencentVoiceIntent {
  explicitGender: TencentVoiceGender | null;
  isCantonese: boolean;
  cantoneseDialect: { name: string; stylePrompt: string; voiceType: number } | null;
  isEnglish: boolean;
  englishVoice: unknown | null;
  explicitTemperament: string | null;
}
export interface TencentTemperamentOption {
  key: string;
  label: string;
  gender: TencentVoiceGender;
  voiceType: number;
}
export const TENCENT_VOICE_CANDIDATES: TencentVoiceCandidate[];
export const TEMPERAMENT_TENCENT: Record<string, number>;
export const ACTIVE_TEMPERAMENT_TENCENT: Record<string, number>;
export const TEMPERAMENTS: Record<string, { label: string; gender: TencentVoiceGender }>;
export const CANTONESE_DIALECT: { name: string; stylePrompt: string; voiceType: number };
export const ENGLISH_VOICES: { stylePrompt: string };
export function applyTencentVoiceHealthSnapshot(rows?: TencentVoiceHealthRow[]): Record<string, number>;
export function registerTencentVoiceUnavailableHandler(handler: ((event: { voiceType: number; reason: string }) => void | Promise<void>) | null): void;
export function probeTencentVoiceType(voiceType: number, language?: string): Promise<{
  ok: boolean;
  bytes?: number;
  requestId?: string | null;
  errorCode?: string;
  reason?: string;
  latencyMs: number;
}>;
export function detectUserVoiceIntent(text?: string): TencentVoiceIntent;
export function getAvailableEnglishVoice(gender: TencentVoiceGender): number | null;
export function getAvailableCantoneseVoice(): number | null;
export function getAvailableTencentVoiceCandidates(options?: { language?: "zh" | "en" | "yue"; gender?: TencentVoiceGender | null; limit?: number; preferredTemperament?: string | null }): TencentVoiceCandidate[];
export function isTencentVoiceAvailable(voiceType: number): boolean;
export function getAvailableTemperamentOptions(): TencentTemperamentOption[];
export function mapVoiceFor(providerName: string, voiceId: string): number;
export function buildTtsAudio(cwd: string, text: string, voiceId: string, options?: {
  speed?: number;
  targetSpanSec?: number;
}): Promise<{
  audioFile: string;
  cues: Array<{ content: string; audioStart: number; audioEnd: number }>;
  durationSec: number;
}>;
