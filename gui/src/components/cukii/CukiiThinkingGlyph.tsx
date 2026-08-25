import type { CSSProperties } from "react";

// Один источник формы для activity bar и анимированного статуса чата.
// Vite копирует SVG в GUI bundle, поэтому webview не зависит от пути к extension media.
const activityIcon = new URL(
  "../../../../extensions/vscode/media/cukii-activity.svg",
  import.meta.url,
).href;

const glyphMask = {
  WebkitMask: `url("${activityIcon}") center / contain no-repeat`,
  mask: `url("${activityIcon}") center / contain no-repeat`,
} as CSSProperties;

export function CukiiThinkingGlyph() {
  return (
    <span
      className="cukii-thinking-glyph"
      style={glyphMask}
      aria-hidden="true"
    />
  );
}
