import type { CSSProperties } from "react";

// Голая печенька без хвостика реплики из знака Cukii Chat: в строке чата он лишний.
// Тот же силуэт, надкус и крошки, что в activity bar (media/cukii-cookie.svg).
// Vite копирует SVG в GUI bundle, поэтому webview не зависит от пути к extension media.
const activityIcon = new URL(
  "../../../../extensions/vscode/media/cukii-cookie.svg",
  import.meta.url,
).href;

const glyphMask = {
  WebkitMask: `url("${activityIcon}") center / contain no-repeat`,
  mask: `url("${activityIcon}") center / contain no-repeat`,
} as CSSProperties;

export function CukiiThinkingGlyph({ active = true }: { active?: boolean }) {
  return (
    <span
      className={`cukii-thinking-glyph ${
        active ? "cukii-thinking-glyph-active" : "cukii-thinking-glyph-inactive"
      }`}
      style={glyphMask}
      aria-hidden="true"
    />
  );
}
