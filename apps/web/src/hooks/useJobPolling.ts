import { useEffect, useRef } from "react";
import type { SavedConversation, WorkItem, ChatMessage } from "../types/client.js";

interface UseJobPollingOptions {
  conversations: SavedConversation[];
  setConversations: React.Dispatch<React.SetStateAction<SavedConversation[]>>;
  saveAccountConversation?: (conversation: SavedConversation) => void;
}

export function useJobPolling({ conversations, setConversations, saveAccountConversation }: UseJobPollingOptions) {
  const activeEventSourcesRef = useRef<Record<string, EventSource>>({});

  // 监听所有进行中的成片生成任务，采用 SSE 毫秒级长连接优先 + 自适应轮询兜底
  useEffect(() => {
    const pending = conversations
      .flatMap((conversation: SavedConversation) => conversation.messages)
      .filter((message: ChatMessage) =>
        message.jobId && (
          (message.jobStatus !== "preview" && !["completed", "failed", "cancelled"].includes(message.jobStatus ?? ""))
          || (message.jobStatus === "completed" && !message.jobWorkId)
        )
      );

    if (!pending.length) {
      // 关闭所有已无任务的 SSE 连接
      for (const [jobId, es] of Object.entries(activeEventSourcesRef.current)) {
        es.close();
        delete activeEventSourcesRef.current[jobId];
      }
      return;
    }

    let active = true;

    const attachWorkOutput = (jobId: string, logMessageId: string) => {
      fetch("/api/v1/works", { credentials: "include" })
        .then(async (response) => (response.ok ? (await response.json()) as { works?: WorkItem[] } : null))
        .then((payload) => {
          if (!active || !payload) return;
          const work = (payload.works ?? []).find((item: WorkItem) => item.jobId === jobId);
          if (!work) return;
          // 创作者端到端极速开播：静默轻量预热视频头 512KB，用户点击秒出画面
          fetch(`/api/v1/works/${work.id}/stream`, {
            credentials: "include",
            headers: { Range: "bytes=0-524287" },
          }).catch(() => undefined);

          setConversations((current: SavedConversation[]) =>
            current.map((conversation: SavedConversation) => {
              const hasTarget = conversation.messages.some((m) => m.id === logMessageId || m.jobId === jobId);
              if (!hasTarget) return conversation;
              const updated = {
                ...conversation,
                updatedAt: Date.now(),
                messages: conversation.messages.map((item: ChatMessage) =>
                  item.id === logMessageId || item.jobId === jobId ? { ...item, jobWorkId: work.id } : item
                ),
              };
              if (saveAccountConversation) void saveAccountConversation(updated);
              return updated;
            })
          );
        })
        .catch(() => undefined);
    };

    const applyJobUpdate = (jobId: string, jobData: {
      status?: string;
      progress?: number;
      errorMessage?: string | null;
      directorPlan?: Record<string, unknown> | null;
      queuePosition?: number;
      estimatedWaitSec?: number;
    }) => {
      let matchedAnchorId: string | undefined;
      setConversations((current: SavedConversation[]) => {
        const conversationIndex = current.findIndex((conversation: SavedConversation) =>
          conversation.messages.some((item: ChatMessage) => item.jobId === jobId)
        );
        if (conversationIndex < 0) return current;
        const conversation = current[conversationIndex]!;
        const anchor = conversation.messages.find((item: ChatMessage) => item.jobId === jobId);
        matchedAnchorId = anchor?.id;

        const nextStatus = jobData.status ?? anchor?.jobStatus;
        const nextProgress = typeof jobData.progress === "number" ? jobData.progress : anchor?.jobProgress;
        const nextError = jobData.errorMessage ?? undefined;
        const nextPlan = jobData.directorPlan ?? anchor?.jobDirectorPlan;
        const nextQueuePos = typeof jobData.queuePosition === "number" ? jobData.queuePosition : anchor?.jobQueuePosition;
        const nextEstWait = typeof jobData.estimatedWaitSec === "number" ? jobData.estimatedWaitSec : anchor?.jobEstimatedWaitSec;

        const unchanged =
          anchor &&
          anchor.jobStatus === nextStatus &&
          anchor.jobProgress === nextProgress &&
          anchor.jobError === nextError &&
          anchor.jobQueuePosition === nextQueuePos &&
          anchor.jobEstimatedWaitSec === nextEstWait &&
          JSON.stringify(anchor.jobDirectorPlan ?? null) === JSON.stringify(nextPlan ?? null);

        if (!nextStatus || unchanged) return current;

        const messages = conversation.messages.map((item: ChatMessage) => {
          if (item.jobId === jobId) {
            return {
              ...item,
              jobStatus: nextStatus,
              ...(nextProgress !== undefined ? { jobProgress: nextProgress } : {}),
              ...(nextError !== undefined ? { jobError: nextError } : {}),
              ...(nextPlan !== undefined ? { jobDirectorPlan: nextPlan } : {}),
              ...(nextQueuePos !== undefined ? { jobQueuePosition: nextQueuePos } : {}),
              ...(nextEstWait !== undefined ? { jobEstimatedWaitSec: nextEstWait } : {}),
            };
          }
          return item;
        });

        const nextConversation = { ...conversation, updatedAt: Date.now(), messages };
        if (saveAccountConversation && (jobData.status === "completed" || jobData.status === "failed")) {
          void saveAccountConversation(nextConversation);
        }
        const next = [...current];
        next[conversationIndex] = nextConversation;
        return next;
      });

      if (jobData.status === "failed") {
        console.warn(`[Jansee-任务监控 | ${jobId.slice(0, 8)}] [FAIL] 任务失败: ${jobData.errorMessage ?? "未知原因"}`);
      } else if (jobData.status === "completed") {
        console.info(`[Jansee-任务监控 | ${jobId.slice(0, 8)}] [SUCCESS] 任务已完成`);
      }

      if (jobData.status === "completed") {
        attachWorkOutput(jobId, matchedAnchorId || jobId);
      }
    };

    // 优先为每个进行中的任务建立 SSE 单向长连接通道
    const supportsSSE = typeof EventSource !== "undefined";

    for (const message of pending) {
      const jobId = message.jobId!;
      if (message.jobStatus === "completed") {
        attachWorkOutput(jobId, message.id);
        continue;
      }

      if (supportsSSE && !activeEventSourcesRef.current[jobId]) {
        try {
          const es = new EventSource(`/api/v1/jobs/${encodeURIComponent(jobId)}/events`, { withCredentials: true });
          es.onmessage = (event) => {
            if (!active) return;
            try {
              const data = JSON.parse(event.data) as {
                job?: {
                  status?: string;
                  progress?: number;
                  errorMessage?: string | null;
                  directorPlan?: Record<string, unknown> | null;
                  queuePosition?: number;
                  estimatedWaitSec?: number;
                };
              };
              if (data.job) {
                applyJobUpdate(jobId, data.job);
                if (["completed", "failed", "cancelled"].includes(data.job.status ?? "")) {
                  es.close();
                  delete activeEventSourcesRef.current[jobId];
                }
              }
            } catch {
              // ignore parse error
            }
          };
          es.onerror = () => {
            // 连接异常时关闭，交由下方轮询兜底
            es.close();
            delete activeEventSourcesRef.current[jobId];
          };
          activeEventSourcesRef.current[jobId] = es;
        } catch {
          // ignore
        }
      }
    }

    // 自适应轮询保底机制（兼顾断线与不支持 SSE 的环境）
    const refreshJobsFallback = async () => {
      await Promise.all(
        pending.map(async (message: ChatMessage) => {
          const jobId = message.jobId!;
          // 若当前任务的 SSE 连接正常活跃，跳过重复 HTTP 轮询
          if (activeEventSourcesRef.current[jobId]?.readyState === EventSource.OPEN) {
            return;
          }
          try {
            if (message.jobStatus === "completed") {
              attachWorkOutput(jobId, message.id);
              return;
            }
            const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { credentials: "include" });
            if (!response.ok) return;
            const payload = (await response.json()) as {
              job?: {
                status?: string;
                progress?: number;
                errorMessage?: string | null;
                directorPlan?: Record<string, unknown> | null;
                queuePosition?: number;
                estimatedWaitSec?: number;
              };
            };
            if (!active || !payload.job) return;
            applyJobUpdate(jobId, payload.job);
          } catch {
            // 保留上次状态
          }
        })
      );
    };

    void refreshJobsFallback();
    const hasRenderingJob = pending.some(
      (m: ChatMessage) =>
        m.jobStatus === "rendering" ||
        m.jobStatus === "quality-check" ||
        (typeof m.jobProgress === "number" && m.jobProgress >= 70)
    );
    const pollInterval = hasRenderingJob ? 1000 : 3000;
    const timer = window.setInterval(() => {
      void refreshJobsFallback();
    }, pollInterval);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    conversations
      .flatMap((conversation: SavedConversation) => conversation.messages)
      .filter(
        (message: ChatMessage) =>
          message.jobId &&
          message.jobStatus !== "preview" &&
          (!["completed", "failed", "cancelled"].includes(message.jobStatus ?? "") ||
            (message.jobStatus === "completed" && !message.jobWorkId))
      )
      .map((message: ChatMessage) => `${message.jobId}:${message.jobStatus ?? ""}:${message.jobWorkId ?? ""}`)
      .join("|"),
  ]);

  // 语音分析任务轻量轮询
  useEffect(() => {
    const pending = conversations
      .flatMap((conversation: SavedConversation) => conversation.messages)
      .filter((message: ChatMessage) => message.speechCutSessionId && message.speechCutStatus === "analyzing");
    if (!pending.length) return;
    let active = true;

    const refreshSpeechCuts = async () => {
      await Promise.all(
        pending.map(async (message: ChatMessage) => {
          try {
            const response = await fetch(`/api/v1/speech-cut/${encodeURIComponent(message.speechCutSessionId!)}`, {
              credentials: "include",
            });
            if (!response.ok) return;
            const payload = (await response.json()) as {
              session?: {
                status: ChatMessage["speechCutStatus"];
                suggestions?: NonNullable<ChatMessage["speechCutSuggestions"]>;
                errorMessage?: string | null;
              };
            };
            if (!active || !payload.session) return;
            const session = payload.session;
            setConversations((current: SavedConversation[]) =>
              current.map((conversation: SavedConversation) => ({
                ...conversation,
                messages: conversation.messages.map((item: ChatMessage) => {
                  if (item.id !== message.id) return item;
                  const suggestions = session.suggestions ?? [];
                  const selectedIds =
                    item.speechCutSelectedIds ?? suggestions.map((suggestion: { id: string }) => suggestion.id);
                  if (
                    item.speechCutStatus === session.status &&
                    JSON.stringify(item.speechCutSuggestions ?? []) === JSON.stringify(suggestions) &&
                    JSON.stringify(item.speechCutSelectedIds ?? []) === JSON.stringify(selectedIds) &&
                    item.speechCutError === (session.errorMessage ?? undefined)
                  ) {
                    return item;
                  }
                  return {
                    ...item,
                    ...(session.status ? { speechCutStatus: session.status } : {}),
                    speechCutSuggestions: suggestions,
                    speechCutSelectedIds: selectedIds,
                    ...(session.errorMessage ? { speechCutError: session.errorMessage } : {}),
                  };
                }),
              }))
            );
          } catch {
            // Keep last state during temporary failure
          }
        })
      );
    };

    void refreshSpeechCuts();
    const timer = window.setInterval(() => {
      void refreshSpeechCuts();
    }, 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [
    conversations
      .flatMap((conversation: SavedConversation) => conversation.messages)
      .filter((message: ChatMessage) => message.speechCutSessionId && message.speechCutStatus === "analyzing")
      .map((message: ChatMessage) => message.speechCutSessionId)
      .join("|"),
  ]);
}
