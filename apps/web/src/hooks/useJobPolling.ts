import { useEffect } from "react";
import type { SavedConversation, WorkItem, ChatMessage } from "../types/client.js";

interface UseJobPollingOptions {
  conversations: SavedConversation[];
  setConversations: React.Dispatch<React.SetStateAction<SavedConversation[]>>;
}

export function useJobPolling({ conversations, setConversations }: UseJobPollingOptions) {
  // Keep accepted generation jobs live in the conversation until the server confirms a terminal state.
  useEffect(() => {
    const pending = conversations.flatMap((conversation: SavedConversation) => conversation.messages)
      .filter((message: ChatMessage) => message.jobId && (
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
          const work = (payload.works ?? []).find((item: WorkItem) => item.jobId === jobId);
          if (!work) return;
          // 创作者端到端极速开播：静默轻量预热视频头 512KB，用户点击秒出画面
          fetch(`/api/v1/works/${work.id}/stream`, {
            credentials: "include",
            headers: { Range: "bytes=0-524287" },
          }).catch(() => undefined);
          setConversations((current: SavedConversation[]) => current.map((conversation: SavedConversation) => ({
            ...conversation,
            messages: conversation.messages.map((item: ChatMessage) => item.id === logMessageId ? { ...item, jobWorkId: work.id } : item),
          })));
        })
        .catch(() => undefined);
    };

    const refreshJobs = async () => {
      await Promise.all(pending.map(async (message: ChatMessage) => {
        const jobId = message.jobId!;
        try {
          if (message.jobStatus === "completed") {
            const completionLog = conversations.flatMap((conversation: SavedConversation) => conversation.messages)
              .find((item: ChatMessage) => item.jobId === jobId);
            attachWorkOutput(jobId, completionLog?.id ?? message.id);
            return;
          }
          const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
          if (!response.ok) return;
          const payload = await response.json() as { job?: { status?: string; progress?: number; errorMessage?: string | null; directorPlan?: Record<string, unknown> | null } };
          if (!active || !payload.job) return;
          const job = payload.job;
          let matchedAnchorId: string | undefined;
          setConversations((current: SavedConversation[]) => {
            const conversationIndex = current.findIndex((conversation: SavedConversation) => conversation.messages.some((item: ChatMessage) => item.jobId === jobId));
            if (conversationIndex < 0) return current;
            const conversation = current[conversationIndex]!;
            const anchor = conversation.messages.find((item: ChatMessage) => item.jobId === jobId);
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

            const messages = conversation.messages.map((item: ChatMessage) => {
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
    const hasRenderingJob = pending.some((m: ChatMessage) => m.jobStatus === "rendering" || m.jobStatus === "quality-check" || (typeof m.jobProgress === "number" && m.jobProgress >= 70));
    const pollInterval = hasRenderingJob ? 600 : 2_000;
    const timer = window.setInterval(() => { void refreshJobs(); }, pollInterval);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversations.map((conversation: SavedConversation) => conversation.messages
    .filter((message: ChatMessage) => message.jobId && message.jobStatus !== 'preview' && (!['completed', 'failed', 'cancelled'].includes(message.jobStatus ?? '') || (message.jobStatus === 'completed' && !message.jobWorkId)))
    .map((message: ChatMessage) => `${message.jobId}:${message.jobStatus ?? ''}:${message.jobWorkId ?? ''}`).join('|'))]);

  // Speech-cut analysis poll
  useEffect(() => {
    const pending = conversations.flatMap((conversation: SavedConversation) => conversation.messages)
      .filter((message: ChatMessage) => message.speechCutSessionId && message.speechCutStatus === "analyzing");
    if (!pending.length) return;
    let active = true;

    const refreshSpeechCuts = async () => {
      await Promise.all(pending.map(async (message: ChatMessage) => {
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
          setConversations((current: SavedConversation[]) => current.map((conversation: SavedConversation) => ({
            ...conversation,
            messages: conversation.messages.map((item: ChatMessage) => {
              if (item.id !== message.id) return item;
              const suggestions = session.suggestions ?? [];
              const selectedIds = item.speechCutSelectedIds ?? suggestions.map((suggestion: { id: string }) => suggestion.id);
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
          // Keep last state during temporary failure
        }
      }));
    };

    void refreshSpeechCuts();
    const timer = window.setInterval(() => { void refreshSpeechCuts(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversations.map((conversation: SavedConversation) => conversation.messages
    .filter((message: ChatMessage) => message.speechCutSessionId && message.speechCutStatus === 'analyzing')
    .map((message: ChatMessage) => message.speechCutSessionId).join('|'))]);
}
