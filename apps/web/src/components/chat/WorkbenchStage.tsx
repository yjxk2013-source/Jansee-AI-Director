import type { RefObject } from "react";
import type { ChatMessage } from "../../types/client";
import { JobDeliveryCard } from "./JobDeliveryCard";

interface WorkbenchStageProps {
  chatStageRef: RefObject<HTMLElement | null>;
  isEmpty: boolean;
  messages: ChatMessage[];
  creationScene: "online-ecommerce" | "physical-store" | "personal-creation" | "quick-cut";
  activePlayingVideoId: string | null;
  setActivePlayingVideoId: (id: string | null | ((curr: string | null) => string | null)) => void;
  onRestoreDraft: (text: string) => void;
  toggleSpeechCutSuggestion: (messageId: string, suggestionId: string, checked: boolean) => void;
  confirmSpeechCut: (messageId: string, sessionId: string, selectedIds: string[]) => void;
  onRequestDownload?: ((workId: string, filename: string) => void) | undefined;
  onShowNotice?: ((notice: string) => void) | undefined;
}

export function WorkbenchStage({
  chatStageRef,
  isEmpty,
  messages,
  creationScene,
  activePlayingVideoId,
  setActivePlayingVideoId,
  onRestoreDraft,
  toggleSpeechCutSuggestion,
  confirmSpeechCut,
  onRequestDownload,
  onShowNotice,
}: WorkbenchStageProps) {
  return (
    <section
      ref={chatStageRef as any}
      className={`chat-stage ${isEmpty ? "chat-stage-empty" : "chat-stage-active"}`}
      aria-label="简兮黑曜石工作台"
    >
      {isEmpty ? (
        <div className="welcome-panel">
          <p className="welcome-eyebrow">
            <span>JANSEE</span>
            <i />AI 智能导演
          </p>
          <h1>
            简于形<br />
            <span>胜于效</span>
          </h1>
          <p className="welcome-copy">行至简处，见光影，见山海，见简兮。</p>
        </div>
      ) : (
        <div className="workbench-stream" aria-live="polite">
          {messages.map((message) => {
            const hasJobOrWork = Boolean(message.jobId || message.jobWorkId || message.speechCutSessionId);
            if (!hasJobOrWork) return null;

            return (
              <div className="workbench-card" key={message.id}>
                <JobDeliveryCard
                  message={message}
                  fallbackScene={creationScene}
                  activePlayingVideoId={activePlayingVideoId}
                  setActivePlayingVideoId={setActivePlayingVideoId}
                  onRestoreDraft={onRestoreDraft}
                  onRequestDownload={onRequestDownload}
                  onShowNotice={onShowNotice}
                />

                {message.plan && message.speechCutSessionId && (
                  <div className="director-plan">
                    <div className="plan-heading">
                      {(message.jobDirectorPlan as Record<string, any>)?._providerTelemetry?.selectedModel
                        ? `AI 导演独家构思 · 《${String((message.jobDirectorPlan as Record<string, unknown>).title || "定制商业成片")}》`
                        : "AI 导演独家构思 · 创作方案"}
                    </div>
                    <ol>
                      {message.plan.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                    {message.speechCutSessionId && !message.jobId && (
                      <div
                        className="speech-cut-review"
                        style={{ marginTop: "14px", paddingTop: "12px", borderTop: "1px solid rgba(0,0,0,0.10)" }}
                      >
                        {message.speechCutStatus === "analyzing" && (
                          <p role="status" style={{ margin: 0, color: "#666" }}>
                            正在识别原声与停顿，请稍候…
                          </p>
                        )}
                        {message.speechCutStatus === "failed" && (
                          <p role="alert" style={{ margin: 0, color: "#a33" }}>
                            {message.speechCutError || "语音分析失败，请重新上传素材后再试。"}
                          </p>
                        )}
                        {message.speechCutStatus === "awaiting_confirmation" && (() => {
                          const suggestions = message.speechCutSuggestions ?? [];
                          const selectedIds = message.speechCutSelectedIds ?? [];
                          const reasonLabel = (reason: string) =>
                            reason === "pause"
                              ? "明显停顿"
                              : reason === "repeat"
                              ? "重复表达"
                              : reason === "phrase"
                              ? "冗余语句"
                              : "口头语";
                          return (
                            <div>
                              <strong style={{ display: "block", marginBottom: "8px" }}>识别完成 · 请确认剪辑建议</strong>
                              <p style={{ margin: "0 0 10px", color: "#777", fontSize: "12px" }}>
                                默认勾选建议删除的片段；取消勾选即可保留。简兮不会擅自删除未确认内容。
                              </p>
                              {suggestions.length ? (
                                <div style={{ display: "grid", gap: "6px", maxHeight: "220px", overflowY: "auto" }}>
                                  {suggestions.map((suggestion) => (
                                    <label
                                      key={suggestion.id}
                                      style={{
                                        display: "flex",
                                        gap: "9px",
                                        alignItems: "flex-start",
                                        padding: "8px 10px",
                                        borderRadius: "7px",
                                        background: "rgba(0,0,0,0.035)",
                                        cursor: "pointer",
                                      }}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedIds.includes(suggestion.id)}
                                        onChange={(event) =>
                                          toggleSpeechCutSuggestion(message.id, suggestion.id, event.currentTarget.checked)
                                        }
                                        style={{ marginTop: "3px" }}
                                      />
                                      <span style={{ minWidth: 0, flex: 1 }}>
                                        <span style={{ display: "block", fontSize: "13px" }}>{suggestion.word}</span>
                                        <small style={{ color: "#888" }}>
                                          {reasonLabel(suggestion.reason)} · {suggestion.start.toFixed(1)}s–
                                          {suggestion.end.toFixed(1)}s
                                        </small>
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              ) : (
                                <p style={{ margin: "8px 0", color: "#666", fontSize: "13px" }}>
                                  没有检测到明确需要删除的口头语或停顿，可直接确认保留原声完成包装。
                                </p>
                              )}
                              <button
                                type="button"
                                className="panel-primary-action"
                                style={{ marginTop: "12px", width: "auto", padding: "8px 16px", fontSize: "14px" }}
                                disabled={message.speechCutSubmitting}
                                onClick={() =>
                                  confirmSpeechCut(message.id, message.speechCutSessionId!, selectedIds)
                                }
                              >
                                {message.speechCutSubmitting ? "正在提交…" : "确认精剪并开始制作（免费）"}
                              </button>
                              {message.speechCutError && (
                                <p role="alert" style={{ margin: "8px 0 0", color: "#a33", fontSize: "13px" }}>
                                  {message.speechCutError}
                                </p>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

