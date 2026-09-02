import { useEffect } from "react";

export interface CukiiMessageContextMenuState {
  x: number;
  y: number;
  text: string;
}

interface CukiiMessageContextMenuProps {
  state: CukiiMessageContextMenuState | null;
  onClose: () => void;
}

/** Right-click menu for transcript capsules; mirrors the Claude Code
 *  "Copy Message" entry the owner uses as reference. */
export function CukiiMessageContextMenu({
  state,
  onClose,
}: CukiiMessageContextMenuProps) {
  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      className="cukii-message-context-menu"
      role="menu"
      style={{ left: state.x, top: state.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="cukii-menu-item"
        data-testid="cukii-copy-message"
        onClick={() => {
          void navigator.clipboard.writeText(state.text);
          onClose();
        }}
      >
        Cukii: Copy Message
      </button>
    </div>
  );
}
