import { useState, useCallback, type FormEvent } from "react";
import type { CreationMode } from "@jansee/contracts";
import type {
  Attachment,
  AuthUser,
  ChatMessage,
  SavedConversation,
} from "../types/client.js";
import {
  fileKey,
  isSpeechCutIntent,
  makeId,
  mediaKind,
} from "../utils/clientPlatform.js";
import {
  makeConversationTitle,
  saveActiveConversationId,
  MAX_SAVED_CONVERSATIONS,
} from "../utils/conversationStorage.js";

export interface UseDirectorWorkflowOptions {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  files: File[];
  setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  creationScene: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  isAnyFileUploading: boolean;
  isGuestViewer: boolean;
  authUser: AuthUser | null;
  setAuthUser: React.Dispatch<React.SetStateAction<AuthUser | null>>;
  conversations: SavedConversation[];
  setConversations: React.Dispatch<React.SetStateAction<SavedConversation[]>>;
  activeConversationId: string | null;
  setActiveConversationId: React.Dispatch<React.SetStateAction<string | null>>;
  conversationsOwnerId: string | null;
  uploadPromisesRef: React.MutableRefObject<Map<string, Promise<string>>>;
  startUploads: (batch: File[]) => void;
  saveAccountConversation: (conversation: SavedConversation) => void;
  refreshWallet: () => void;
  guideGuestToRegister: (sceneName: string) => void;
  setFileError: (msg: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  stopVoiceInput: () => void;
}

export function useDirectorWorkflow(options: UseDirectorWorkflowOptions) {
  const {
    draft,
    setDraft,
    files,
    setFiles,
    creationScene,
    isAnyFileUploading,
    isGuestViewer,
    authUser,
    setAuthUser,
    conversations,
    setConversations,
    activeConversationId,
    setActiveConversationId,
    conversationsOwnerId,
    uploadPromisesRef,
    startUploads,
    saveAccountConversation,
    refreshWallet,
    guideGuestToRegister,
    setFileError,
    textareaRef,
    stopVoiceInput,
  } = options;

  const [isDirectorThinking, setIsDirectorThinking] = useState(false);

  const messages = conversations.find((c) => c.id === activeConversationId)?.messages ?? [];

  const submitMessage = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = draft.trim();
    if (isDirectorThinking) return;
    if (isAnyFileUploading) {
      setFileError("素材还在上传中，请稍候片刻…");
      return;
    }
    if (isGuestViewer && (creationScene === "online-ecommerce" || creationScene === "physical-store")) {
      guideGuestToRegister(creationScene === "online-ecommerce" ? "带货视频" : "门店获客");
      return;
    }
    if (!files.length) {
      setFileError("请先上传图片或视频素材，导演才能结合实际素材制定方案。");
      return;
    }
    if (!trimmed) {
      setFileError("请告诉导演你希望这支视频呈现什么内容或效果。");
      return;
    }
    stopVoiceInput();
    const firstFile = files[0];
    if (!firstFile) return;
    const kind = mediaKind(firstFile);
    if (!kind) return;
    const mode: CreationMode = kind === "image" ? "image-film" : files.length === 1 ? "video-dub" : "storyboard";
    const directorPrompt = trimmed;
    if (mode === "storyboard" && files.length < 2) {
      setFileError("分镜成片至少需要两个视频素材。");
      return;
    }
    let currentAuthUser = authUser;
    if (!currentAuthUser) {
      try {
        const guestRes = await fetch("/api/v1/auth/guest", { method: "POST", credentials: "include" });
        if (guestRes.ok) {
          const payload = await guestRes.json() as { user: AuthUser };
          currentAuthUser = payload.user;
          setAuthUser(payload.user);
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
    setIsDirectorThinking(true);
    setFileError("");
    const conversationId = activeConversationId ?? (currentAuthUser.id !== "local-preview-user" ? crypto.randomUUID() : makeId());
    const userMessage: ChatMessage = {
      id: makeId(),
      role: "user",
      text: submittingDraft,
      creationScene: submittingScene,
      creationMode: submittingMode,
      attachments: submittingFiles.map((file) => ({
        name: file.name,
        kind: mediaKind(file)!,
        size: file.size,
        previewUrl: URL.createObjectURL(file),
      })),
      isWorkbench: true,
    };
    const baseMessages = [...messages, userMessage];
    const baseConversation: SavedConversation = {
      id: conversationId,
      title: makeConversationTitle(baseMessages),
      updatedAt: Date.now(),
      messages: baseMessages,
    };
    setConversations((current) => [baseConversation, ...current.filter((c) => c.id !== conversationId)].slice(0, MAX_SAVED_CONVERSATIONS));
    saveActiveConversationId(conversationId);
    setActiveConversationId(conversationId);

    const messagesWithAck = baseMessages;
    const conversationWithAck: SavedConversation = {
      ...baseConversation,
      title: makeConversationTitle(messagesWithAck),
      messages: messagesWithAck,
    };
    setConversations((current) => [conversationWithAck, ...current.filter((c) => c.id !== conversationId)].slice(0, MAX_SAVED_CONVERSATIONS));
    setDraft("");
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsDirectorThinking(false);

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
        void saveAccountConversation(conversationWithAck);
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

        let attachments: Attachment[] = submittingFiles.map((file, index) => {
          const prior = (messagesWithAck.find((m) => m.id === userMessage.id)?.attachments?.[index]) as Record<string, unknown> | undefined;
          return {
            name: file.name,
            kind: mediaKind(file)!,
            size: file.size,
            assetId: assetIds[index]!,
            ...(typeof prior?.previewUrl === "string" ? { previewUrl: prior.previewUrl } : {}),
          };
        });
        const baseMessagesWithAssets = messagesWithAck.map((m) => m.id === userMessage.id ? { ...m, attachments } : m);
        setConversations((current) => current.map((c) => c.id === conversationId
          ? { ...c, updatedAt: Date.now(), messages: baseMessagesWithAssets }
          : c));

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
          setConversations((current) => current.map((c) => c.id === conversationId
            ? { ...c, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
            : c));
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
          plans?: PlanPayload[];
          batch?: { total?: number };
          error?: { code?: string; message?: string };
        };

        if (!response.ok && payload.error?.code === "ASSET_NOT_FOUND") {
          submittingFiles.forEach((file) => uploadPromisesRef.current.delete(fileKey(file)));
          assetIds = await ensureUploads(submittingFiles);
          attachments = submittingFiles.map((file, index) => {
            const prior = (messagesWithAck.find((m) => m.id === userMessage.id)?.attachments?.[index]) as Record<string, unknown> | undefined;
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
        const plans = (payload.plans && payload.plans.length ? payload.plans : [plan]) as PlanPayload[];
        const batchTotal = Math.max(1, Math.min(10, Math.floor(payload.batch?.total ?? 1)));

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

        const directorRoleLine = plan.voice_id ? "导演选定音色：" + plan.voice_id : null;
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

        const baseMessagesForWorkbench = baseMessagesWithAssets.map((m) =>
          m.id === userMessage.id ? { ...m, isWorkbench: false } : m);
        const workbenchAttachments: Attachment[] = attachments.map((att) => ({
          ...att,
          ...(att.assetId
            ? { previewUrl: `/api/v1/assets/${encodeURIComponent(att.assetId)}/preview` }
            : (att.previewUrl ? { previewUrl: att.previewUrl } : {})),
        }));

        if (batchTotal > 1 && createdJobs.length > 1) {
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
          setConversations((current) => current.map((c) => {
            if (c.id === conversationId) {
              const updated = { ...c, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages };
              void saveAccountConversation(updated);
              return updated;
            }
            return c;
          }));
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
          setConversations((current) => current.map((c) => {
            if (c.id === conversationId) {
              const updated = { ...c, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages };
              void saveAccountConversation(updated);
              return updated;
            }
            return c;
          }));
        }
      } else {
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
        setConversations((current) => current.map((c) => c.id === conversationId
          ? { ...c, title: makeConversationTitle(nextMessages), updatedAt: Date.now(), messages: nextMessages }
          : c));
        setDraft("");
        setFiles([]);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        return;
      }
      setDraft("");
      setFiles([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "创作过程中遇到问题，请稍后重试。";
      const isTimeout = /timed out|TIMEOUT|超时|不可用|DIRECTOR_ALL_MODELS_FAILED/i.test(rawMessage);
      const friendlyNotice = isTimeout ? "网络偶发超时，点击下方重试" : ("这次创作没能继续：" + rawMessage);
      setConversations((current) => current.map((c) => {
        if (c.id !== conversationId) return c;
        const updatedMessages = c.messages.map((m) =>
          m.id === userMessage.id ? { ...m, isWorkbench: true, jobStatus: "failed", jobError: friendlyNotice } : m);
        return {
          ...c,
          updatedAt: Date.now(),
          messages: [
            ...updatedMessages,
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
  }, [
    draft,
    isDirectorThinking,
    isAnyFileUploading,
    isGuestViewer,
    creationScene,
    files,
    stopVoiceInput,
    authUser,
    conversationsOwnerId,
    activeConversationId,
    messages,
    textareaRef,
    setConversations,
    setActiveConversationId,
    setDraft,
    setFiles,
    setAuthUser,
    guideGuestToRegister,
    setFileError,
    saveAccountConversation,
    uploadPromisesRef,
    startUploads,
    refreshWallet,
  ]);

  const toggleSpeechCutSuggestion = useCallback((messageId: string, suggestionId: string, checked: boolean) => {
    setConversations((current) => current.map((c) => c.id !== activeConversationId ? c : {
      ...c,
      messages: c.messages.map((message) => {
        if (message.id !== messageId) return message;
        const selected = new Set(message.speechCutSelectedIds ?? []);
        if (checked) selected.add(suggestionId);
        else selected.delete(suggestionId);
        return { ...message, speechCutSelectedIds: [...selected] };
      }),
    }));
  }, [activeConversationId, setConversations]);

  const confirmSpeechCut = useCallback(async (messageId: string, sessionId: string, suggestionIds: string[]) => {
    setConversations((current) => current.map((c) => ({
      ...c,
      messages: c.messages.map((message) => message.id === messageId ? { ...message, speechCutSubmitting: true, speechCutError: "" } : message),
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
      setConversations((current) => current.map((c) => ({
        ...c,
        messages: c.messages.map((message) => message.id === messageId ? {
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
      setConversations((current) => current.map((c) => ({
        ...c,
        messages: c.messages.map((item) => item.id === messageId ? { ...item, speechCutSubmitting: false, speechCutError: message } : item),
      })));
    }
  }, [refreshWallet, setConversations]);

  return {
    isDirectorThinking,
    submitMessage,
    toggleSpeechCutSuggestion,
    confirmSpeechCut,
  };
}
