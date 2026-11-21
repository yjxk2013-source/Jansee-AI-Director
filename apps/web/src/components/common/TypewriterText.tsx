import { useEffect, useState } from "react";

export function TypewriterText({ text, messageId, isNew }: { text: string; messageId: string; isNew: boolean }) {
  const [displayedLength, setDisplayedLength] = useState(() => (isNew ? 0 : text.length));

  useEffect(() => {
    if (!isNew) {
      setDisplayedLength(text.length);
      return;
    }
    setDisplayedLength(0);
    let current = 0;
    const speed = Math.max(12, Math.min(26, Math.floor(1000 / (text.length || 1))));
    const timer = setInterval(() => {
      current += 1;
      setDisplayedLength(current);
      if (current >= text.length) {
        clearInterval(timer);
      }
    }, speed);
    return () => clearInterval(timer);
  }, [text, isNew]);

  const isTyping = isNew && displayedLength < text.length;

  return (
    <span>
      {text.slice(0, displayedLength)}
      {isTyping && <span className="typewriter-cursor" aria-hidden="true" />}
    </span>
  );
}

