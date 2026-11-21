import type { ChatMessage, SavedConversation } from "../types/client";

export const CONVERSATION_STORAGE_KEY = "jansee.v4.guest-conversations.v1";
export const ACTIVE_CONVERSATION_STORAGE_KEY = "jansee.v4.active-conversation.v1";
export const MAX_SAVED_CONVERSATIONS = 30;
export const PENDING_CONVERSATION_PREFIX = "jansee.v4.pending-conversation.v1:";

export function pendingConversationKey(userId: string) {
  return `${PENDING_CONVERSATION_PREFIX}${userId}`;
}

export function savePendingConversation(userId: string, conversation: SavedConversation) {
  try {
    window.localStorage.setItem(pendingConversationKey(userId), JSON.stringify(conversation));
  } catch {
    /* local recovery is best effort */
  }
}

export function loadPendingConversations(userId: string): SavedConversation[] {
  try {
    const raw = window.localStorage.getItem(pendingConversationKey(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const item = parsed as Partial<SavedConversation>;
    return typeof item.id === "string" &&
      typeof item.title === "string" &&
      typeof item.updatedAt === "number" &&
      Array.isArray(item.messages)
      ? [item as SavedConversation]
      : [];
  } catch {
    return [];
  }
}

export function clearPendingConversationIfMatches(userId: string, conversation: SavedConversation) {
  try {
    const pending = loadPendingConversations(userId)[0];
    if (pending?.id === conversation.id && pending.updatedAt <= conversation.updatedAt) {
      window.localStorage.removeItem(pendingConversationKey(userId));
    }
  } catch {
    /* local recovery is best effort */
  }
}

export async function saveConversationToServer(conversation: SavedConversation): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(conversation.id)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: conversation.title, messages: conversation.messages }),
      });
      lastResponse = response;
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => window.setTimeout(resolve, attempt * 250));
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("conversation save failed");
}

export function loadActiveConversationId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveConversationId(conversationId: string | null) {
  try {
    if (conversationId) window.localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, conversationId);
    else window.localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
  } catch {
    // The active view preference must never block creating or opening a conversation.
  }
}

export function resolveActiveConversationId(conversations: SavedConversation[]): string | null {
  const savedId = loadActiveConversationId();
  return savedId && conversations.some((conversation) => conversation.id === savedId && conversation.messages.length > 0)
    ? savedId
    : null;
}

export function loadSavedConversations(): SavedConversation[] {
  try {
    const raw = window.localStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is SavedConversation =>
          Boolean(item) &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.updatedAt === "number" &&
          Array.isArray(item.messages)
      )
      .slice(0, MAX_SAVED_CONVERSATIONS);
  } catch {
    return [];
  }
}

export function persistSavedConversations(conversations: SavedConversation[]) {
  try {
    window.localStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify(conversations.slice(0, MAX_SAVED_CONVERSATIONS))
    );
  } catch {
    // Private browsing or a full storage quota must not break the chat.
  }
}

export function makeConversationTitle(messages: ChatMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  return (firstUserMessage?.text || "新对话").replace(/\s+/g, " ").slice(0, 34);
}

