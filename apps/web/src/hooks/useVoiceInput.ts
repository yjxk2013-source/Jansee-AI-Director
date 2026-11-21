import { useState, useRef, useCallback } from "react";

export type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export type SpeechWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  JanseeVoice?: { start: () => void; cancel: () => void };
  __janseeVoiceResult?: ((text: string) => void) | undefined;
  __janseeVoiceError?: ((message: string) => void) | undefined;
};

export function voiceErrorMessage(code?: string) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "麦克风权限未开启，请在浏览器或系统设置里允许简兮使用麦克风后重试。";
    case "no-speech":
      return "没有听到声音，请靠近麦克风再试一次。";
    case "audio-capture":
      return "没有找到可用的麦克风，请检查设备后重试。";
    case "network":
      return "语音服务暂时连不上，请检查网络后重试。";
    default:
      return "语音输入暂不可用，请检查麦克风权限后重试。";
  }
}

export interface UseVoiceInputOptions {
  onAppendDraft: (text: string) => void;
  onError: (msg: string) => void;
}

export function useVoiceInput({ onAppendDraft, onError }: UseVoiceInputOptions) {
  const [isListening, setIsListening] = useState(false);
  const [listeningRemainingSeconds, setListeningRemainingSeconds] = useState(60);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceTimerRef = useRef<number | null>(null);

  const stopVoiceInput = useCallback(() => {
    if (voiceTimerRef.current) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    const speechWindow = window as SpeechWindow;
    speechWindow.JanseeVoice?.cancel();
    speechWindow.__janseeVoiceResult = undefined;
    speechWindow.__janseeVoiceError = undefined;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // no-op
      }
      recognitionRef.current = null;
    }
    setIsListening(false);
    setListeningRemainingSeconds(60);
  }, []);

  const beginVoiceSession = useCallback(() => {
    setIsListening(true);
    setListeningRemainingSeconds(60);
    if (voiceTimerRef.current) window.clearInterval(voiceTimerRef.current);
    voiceTimerRef.current = window.setInterval(() => {
      setListeningRemainingSeconds((prev) => {
        if (prev <= 1) {
          stopVoiceInput();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
  }, [stopVoiceInput]);

  const toggleVoiceInput = useCallback(() => {
    if (recognitionRef.current || isListening) {
      stopVoiceInput();
      return;
    }

    const speechWindow = window as SpeechWindow;
    if (speechWindow.JanseeVoice) {
      onError("");
      speechWindow.__janseeVoiceResult = (text) => {
        const transcript = text.trim();
        if (transcript) {
          onAppendDraft(transcript);
        }
        stopVoiceInput();
      };
      speechWindow.__janseeVoiceError = (message) => {
        stopVoiceInput();
        if (message.trim()) onError(message);
      };
      try {
        beginVoiceSession();
        speechWindow.JanseeVoice.start();
      } catch {
        stopVoiceInput();
        onError("无法启动语音输入，请检查麦克风权限。");
      }
      return;
    }

    const SpeechRecognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      onError("当前浏览器不支持语音输入，可以点输入框后用系统键盘的麦克风按钮听写。");
      return;
    }

    onError("");
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.platform)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    recognition.continuous = !isIOS;
    recognition.onresult = (event) => {
      let finalText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) finalText += result[0].transcript;
      }
      if (finalText.trim()) {
        onAppendDraft(finalText.trim());
      }
    };
    recognition.onerror = (event) => {
      stopVoiceInput();
      onError(voiceErrorMessage(event.error));
    };
    recognition.onend = () => {
      stopVoiceInput();
    };

    try {
      recognitionRef.current = recognition;
      beginVoiceSession();
      recognition.start();
    } catch {
      stopVoiceInput();
      onError("无法启动语音输入，请检查浏览器麦克风权限。");
    }
  }, [isListening, stopVoiceInput, beginVoiceSession, onAppendDraft, onError]);

  return {
    isListening,
    listeningRemainingSeconds,
    toggleVoiceInput,
    stopVoiceInput,
  };
}

