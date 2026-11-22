import { useState, useRef, useCallback, useEffect } from "react";

export interface UseVoiceInputOptions {
  onAppendDraft: (text: string) => void;
  onError: (msg: string) => void;
}

export function useVoiceInput({ onAppendDraft, onError }: UseVoiceInputOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [listeningRemainingSeconds, setListeningRemainingSeconds] = useState(60);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const isCancelledRef = useRef<boolean>(false);
  const sessionSeqRef = useRef<number>(0);
  const isPendingCancelRef = useRef<boolean>(false);

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
    setIsTranscribing(true);
    try {
      // 1. 如果用户未登录/未初始化会话，先自动获取访客 session，避免 401 报错
      try {
        await fetch("/api/v1/auth/guest", { method: "POST", credentials: "include" });
      } catch {
        // ignore
      }

      const formData = new FormData();
      // 根据 blob 类型自适应文件拓展名（iOS 默认为 mp4/aac，安卓等默认为 webm）
      let ext = "mp4";
      if (audioBlob.type.includes("webm")) {
        ext = "webm";
      } else if (audioBlob.type.includes("wav")) {
        ext = "wav";
      } else if (audioBlob.type.includes("ogg")) {
        ext = "ogg";
      } else if (audioBlob.type.includes("mp3") || audioBlob.type.includes("mpeg")) {
        ext = "mp3";
      } else if (audioBlob.type.includes("aac")) {
        ext = "aac";
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

      const result = (await response.json()) as { text?: string };
      const transcript = (result?.text || "").trim();
      if (transcript) {
        onAppendDraft(transcript);
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try {
            navigator.vibrate(25);
          } catch {
            // no-op
          }
        }
      } else {
        onError("未识别到清晰语音，请靠近麦克风重试。");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "语音识别失败，请检查网络后重试。";
      onError(msg);
    } finally {
      setIsTranscribing(false);
    }
  }, [onAppendDraft, onError]);

  const stopVoiceInput = useCallback((cancel = false) => {
    isCancelledRef.current = cancel;
    isPendingCancelRef.current = true;
    clearTimer();

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        releaseHardware();
        setIsRecording(false);
        setIsCancelling(false);
      }
    } else {
      releaseHardware();
      setIsRecording(false);
      setIsCancelling(false);
      setListeningRemainingSeconds(60);
    }
  }, [clearTimer, releaseHardware]);

  const beginVoiceSession = useCallback(() => {
    setIsRecording(true);
    setIsCancelling(false);
    setListeningRemainingSeconds(60);
    clearTimer();
    recordingStartTimeRef.current = Date.now();
    isCancelledRef.current = false;

    // 轻微触感震动反馈（如果设备支持）
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

    if (isRecording || isTranscribing || mediaStreamRef.current) {
      return;
    }

    const currentSession = ++sessionSeqRef.current;
    isPendingCancelRef.current = false;
    isCancelledRef.current = false;
    onError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // 核心防竞态：如果在请求授权期间用户已松开取消或重置，立即释放并不启动录制
      if (sessionSeqRef.current !== currentSession || isPendingCancelRef.current) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // no-op
          }
        });
        return;
      }

      mediaStreamRef.current = stream;

      // 自适应探测浏览器支持的最佳音频格式，iOS Safari 优先采用 mp4 / aac
      let chosenMime = "";
      if (typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function") {
        const candidates = [
          "audio/mp4",
          "audio/mp4;codecs=mp4a.40.2",
          "audio/webm;codecs=opus",
          "audio/webm",
          "audio/aac",
          "audio/ogg",
          "audio/wav",
        ];
        for (const cand of candidates) {
          if (MediaRecorder.isTypeSupported(cand)) {
            chosenMime = cand;
            break;
          }
        }
      }

      const recorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const mime = recorder.mimeType || chosenMime || "audio/mp4";
        const recordedBlob = new Blob(audioChunksRef.current, { type: mime });
        audioChunksRef.current = [];
        releaseHardware();

        const duration = Date.now() - recordingStartTimeRef.current;
        const cancelled = isCancelledRef.current;
        setIsRecording(false);
        setIsCancelling(false);
        setListeningRemainingSeconds(60);

        if (cancelled) {
          return;
        }

        if (duration < 300 || recordedBlob.size === 0) {
          onError("说话时间太短");
          return;
        }

        void sendAudioToWhisper(recordedBlob);
      };

      recorder.onerror = () => {
        releaseHardware();
        setIsRecording(false);
        setIsCancelling(false);
        onError("录音过程发生异常，请重试。");
      };

      // 关键：不传 timeslice（严禁 start(300)），避免破坏 iOS Safari MP4 container header
      recorder.start();
      beginVoiceSession();
    } catch (err) {
      releaseHardware();
      setIsRecording(false);
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
  }, [beginVoiceSession, isRecording, isTranscribing, onError, releaseHardware, sendAudioToWhisper]);

  const toggleVoiceInput = useCallback(() => {
    if (isRecording || isTranscribing || mediaRecorderRef.current) {
      stopVoiceInput(false);
      return;
    }
    void startVoiceInput();
  }, [isRecording, isTranscribing, startVoiceInput, stopVoiceInput]);

  useEffect(() => {
    return () => {
      clearTimer();
      releaseHardware();
    };
  }, [clearTimer, releaseHardware]);

  const isListening = isRecording || isTranscribing;

  return {
    isListening,
    isRecording,
    isTranscribing,
    isCancelling,
    setIsCancelling,
    listeningRemainingSeconds,
    startVoiceInput,
    stopVoiceInput,
    toggleVoiceInput,
  };
}
