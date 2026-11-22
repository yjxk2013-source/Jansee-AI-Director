import { useState, useRef, useCallback } from "react";

export interface UseVoiceInputOptions {
  onAppendDraft: (text: string) => void;
  onError: (msg: string) => void;
}

export function useVoiceInput({ onAppendDraft, onError }: UseVoiceInputOptions) {
  const [isListening, setIsListening] = useState(false);
  const [listeningRemainingSeconds, setListeningRemainingSeconds] = useState(60);
  const [isCancelling, setIsCancelling] = useState(false);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const isCancelledRef = useRef<boolean>(false);

  // 释放硬件麦克风资源
  const releaseHardware = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // no-op
        }
      });
      mediaStreamRef.current = null;
    }
    mediaRecorderRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (voiceTimerRef.current) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }, []);

  // 上传录音文件至后端本地 Whisper 进行转写
  const sendAudioToWhisper = useCallback(async (audioBlob: Blob) => {
    try {
      // 1. 如果用户未登录/未初始化会话，先自动获取访客 session，避免 401 报错
      try {
        await fetch("/api/v1/auth/guest", { method: "POST", credentials: "include" });
      } catch {
        // ignore
      }

      const formData = new FormData();
      // 根据 blob 类型自适应文件拓展名
      let ext = "webm";
      if (audioBlob.type.includes("mp4") || audioBlob.type.includes("aac") || audioBlob.type.includes("m4a")) {
        ext = "mp4";
      } else if (audioBlob.type.includes("wav")) {
        ext = "wav";
      }
      formData.append("audio", audioBlob, `recording.${ext}`);

      const response = await fetch("/api/v1/voice/transcribe", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        throw new Error(errorPayload?.error?.message || `语音识别失败（HTTP ${response.status}）`);
      }

      const result = await response.json() as { text?: string };
      const transcript = (result?.text || "").trim();
      if (transcript) {
        onAppendDraft(transcript);
      } else {
        onError("未识别到清晰语音，请靠近麦克风重试。");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "语音识别失败，请检查网络后重试。";
      onError(msg);
    }
  }, [onAppendDraft, onError]);

  const stopVoiceInput = useCallback((cancel = false) => {
    isCancelledRef.current = cancel;
    clearTimer();
    const duration = Date.now() - recordingStartTimeRef.current;
    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        releaseHardware();
      }
    } else {
      releaseHardware();
    }

    setIsListening(false);
    setIsCancelling(false);
    setListeningRemainingSeconds(60);

    // 非手动取消但说话过短时，提示用户
    if (!cancel && duration > 0 && duration < 500) {
      onError("说话时间太短");
    }
  }, [clearTimer, onError, releaseHardware]);

  const beginVoiceSession = useCallback(() => {
    setIsListening(true);
    setIsCancelling(false);
    setListeningRemainingSeconds(60);
    clearTimer();
    recordingStartTimeRef.current = Date.now();
    isCancelledRef.current = false;

    // 微信同款：轻微触感震动反馈（如果设备支持）
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(15);
      } catch {
        // no-op
      }
    }

    voiceTimerRef.current = window.setInterval(() => {
      setListeningRemainingSeconds((prev) => {
        if (prev <= 1) {
          stopVoiceInput(false);
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
  }, [clearTimer, stopVoiceInput]);

  const startVoiceInput = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      onError("当前浏览器不支持录音功能，请直接使用输入法键盘的语音麦克风。");
      return;
    }

    try {
      onError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      let mimeType = "";
      if (typeof MediaRecorder !== "undefined") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        }
      }

      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const recordedBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        audioChunksRef.current = [];
        releaseHardware();

        // 如果用户上滑取消，或者按键时间太短（<500ms），直接废弃丢弃
        const duration = Date.now() - recordingStartTimeRef.current;
        if (isCancelledRef.current || duration < 500) {
          return;
        }

        if (recordedBlob.size > 1000) {
          void sendAudioToWhisper(recordedBlob);
        }
      };

      recorder.onerror = () => {
        stopVoiceInput(true);
        onError("录音过程发生异常，请重试。");
      };

      recorder.start(300); // 300ms 分片切片
      beginVoiceSession();
    } catch (err) {
      releaseHardware();
      setIsListening(false);
      setIsCancelling(false);
      const errorName = (err as Error)?.name || "";
      if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
        onError("麦克风权限未开启，请在浏览器或手机系统设置里允许使用麦克风后重试。");
      } else if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
        onError("未找到可用的麦克风设备。");
      } else {
        onError("无法启动录音，请检查麦克风权限。");
      }
    }
  }, [beginVoiceSession, onError, releaseHardware, sendAudioToWhisper, stopVoiceInput]);

  const toggleVoiceInput = useCallback(() => {
    if (isListening || mediaRecorderRef.current) {
      stopVoiceInput(false);
      return;
    }
    void startVoiceInput();
  }, [isListening, startVoiceInput, stopVoiceInput]);

  return {
    isListening,
    isCancelling,
    setIsCancelling,
    listeningRemainingSeconds,
    startVoiceInput,
    stopVoiceInput,
    toggleVoiceInput,
  };
}
