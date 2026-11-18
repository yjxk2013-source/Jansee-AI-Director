import type { Pool } from "pg";

export type SpeechCutStatus =
  | "analyzing"
  | "awaiting_confirmation"
  | "producing"
  | "consumed"
  | "failed"
  | "expired";

export interface SpeechCutSuggestion {
  id: string;
  start: number;
  end: number;
  word: string;
  reason: "filler" | "repeat" | "phrase" | "pause";
}

export interface SpeechCutSession {
  id: string;
  userId: string;
  assetId: string;
  status: SpeechCutStatus;
  durationSec: number | null;
  transcript: string;
  words: Array<{ word: string; start: number; end: number; is_filler?: boolean }>;
  suggestions: SpeechCutSuggestion[];
  selectedSuggestionIds: string[] | null;
  jobId: string | null;
  errorMessage: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SpeechCutStore {
  createSession(userId: string, assetId: string): Promise<SpeechCutSession>;
  completeAnalysis(userId: string, sessionId: string, result: {
    durationSec: number;
    transcript: string;
    words: SpeechCutSession["words"];
    suggestions: SpeechCutSuggestion[];
  }): Promise<void>;
  failAnalysis(userId: string, sessionId: string, message: string): Promise<void>;
  findSession(userId: string, sessionId: string): Promise<SpeechCutSession | null>;
  claimForProduction(userId: string, sessionId: string, suggestionIds: string[]): Promise<boolean>;
  attachJob(userId: string, sessionId: string, jobId: string): Promise<void>;
  releaseClaim(userId: string, sessionId: string): Promise<void>;
}

interface SpeechCutRow {
  id: string;
  user_id: string;
  asset_id: string;
  status: SpeechCutStatus;
  duration_sec: string | number | null;
  transcript: string;
  words: SpeechCutSession["words"];
  suggestions: SpeechCutSuggestion[];
  selected_suggestion_ids: string[] | null;
  job_id: string | null;
  error_message: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapSession(row: SpeechCutRow): SpeechCutSession {
  return {
    id: row.id,
    userId: row.user_id,
    assetId: row.asset_id,
    status: row.status,
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    transcript: row.transcript,
    words: Array.isArray(row.words) ? row.words : [],
    suggestions: Array.isArray(row.suggestions) ? row.suggestions : [],
    selectedSuggestionIds: Array.isArray(row.selected_suggestion_ids) ? row.selected_suggestion_ids : null,
    jobId: row.job_id,
    errorMessage: row.error_message,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPgSpeechCutStore(pool: Pool): SpeechCutStore {
  return {
    async createSession(userId, assetId) {
      const result = await pool.query<SpeechCutRow>(
        `INSERT INTO speech_cut_sessions (user_id, asset_id)
         VALUES ($1, $2)
         RETURNING *`,
        [userId, assetId],
      );
      return mapSession(result.rows[0]!);
    },

    async completeAnalysis(userId, sessionId, result) {
      await pool.query(
        `UPDATE speech_cut_sessions
         SET status = 'awaiting_confirmation',
             duration_sec = $1,
             transcript = $2,
             words = $3::jsonb,
             suggestions = $4::jsonb,
             error_message = NULL,
             updated_at = now()
         WHERE user_id = $5 AND id = $6 AND status = 'analyzing'`,
        [result.durationSec, result.transcript, JSON.stringify(result.words), JSON.stringify(result.suggestions), userId, sessionId],
      );
    },

    async failAnalysis(userId, sessionId, message) {
      await pool.query(
        `UPDATE speech_cut_sessions
         SET status = 'failed', error_message = $1, updated_at = now()
         WHERE user_id = $2 AND id = $3 AND status = 'analyzing'`,
        [message.slice(0, 500), userId, sessionId],
      );
    },

    async findSession(userId, sessionId) {
      const result = await pool.query<SpeechCutRow>(
        `SELECT * FROM speech_cut_sessions
         WHERE user_id = $1 AND id = $2 AND expires_at > now()`,
        [userId, sessionId],
      );
      return result.rows[0] ? mapSession(result.rows[0]) : null;
    },

    async claimForProduction(userId, sessionId, suggestionIds) {
      const result = await pool.query(
        `UPDATE speech_cut_sessions
         SET status = 'producing',
             selected_suggestion_ids = $1::jsonb,
             updated_at = now()
         WHERE user_id = $2 AND id = $3 AND status = 'awaiting_confirmation'
           AND expires_at > now()`,
        [JSON.stringify(suggestionIds), userId, sessionId],
      );
      return (result.rowCount ?? 0) === 1;
    },

    async attachJob(userId, sessionId, jobId) {
      await pool.query(
        `UPDATE speech_cut_sessions
         SET status = 'consumed', job_id = $1, updated_at = now()
         WHERE user_id = $2 AND id = $3 AND status = 'producing'`,
        [jobId, userId, sessionId],
      );
    },

    async releaseClaim(userId, sessionId) {
      await pool.query(
        `UPDATE speech_cut_sessions
         SET status = 'awaiting_confirmation', selected_suggestion_ids = NULL, updated_at = now()
         WHERE user_id = $1 AND id = $2 AND status = 'producing' AND job_id IS NULL`,
        [userId, sessionId],
      );
    },
  };
}
