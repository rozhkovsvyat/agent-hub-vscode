import type { CSSProperties } from "react";

const activityIcon = new URL(
  "../../../../extensions/vscode/media/cukii-activity.svg",
  import.meta.url,
).href;

/** Static cookie mark. The thinking glyph is a smaller animated copy of the same SVG. */
export function CukiiMark({ size = 56 }: { size?: number }) {
  const style = {
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    background: "#e3a867",
    WebkitMask: `url("${activityIcon}") center / contain no-repeat`,
    mask: `url("${activityIcon}") center / contain no-repeat`,
  } as CSSProperties;

  return (
    <span className="cukii-mark" style={style} role="img" aria-label="Cukii" />
  );
}
