import {
  ClipboardDocumentIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyImageToClipboard } from "../../util/copyImageToClipboard";

export function CukiiImageLightbox({
  name,
  onClose,
  source,
}: {
  name: string;
  onClose: () => void;
  source: string;
}) {
  const copyRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState<string>();

  const copy = async () => {
    setCopyStatus(undefined);
    try {
      await copyImageToClipboard(source);
      setCopyStatus("Copied");
    } catch (error) {
      setCopyStatus(
        error instanceof Error ? error.message : "Could not copy image.",
      );
    }
  };

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copy();
        return;
      }
      if (event.key !== "Tab") return;
      event.preventDefault();
      if (event.shiftKey) {
        (document.activeElement === copyRef.current
          ? closeRef
          : copyRef
        ).current?.focus();
      } else {
        (document.activeElement === closeRef.current
          ? copyRef
          : closeRef
        ).current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  return createPortal(
    <div
      className="cukii-image-lightbox"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-label="Image preview"
        aria-modal="true"
        className="cukii-image-lightbox-dialog"
        role="dialog"
      >
        <img alt={name} src={source} />
        <div className="cukii-image-lightbox-actions">
          <button
            aria-label="Copy image"
            onClick={() => void copy()}
            ref={copyRef}
            title="Copy image (Ctrl/Cmd+C)"
            type="button"
          >
            <ClipboardDocumentIcon aria-hidden="true" />
          </button>
          <button
            aria-label="Close image preview"
            onClick={onClose}
            ref={closeRef}
            title="Close preview (Esc)"
            type="button"
          >
            <XMarkIcon aria-hidden="true" />
          </button>
        </div>
        {copyStatus && (
          <span className="cukii-image-copy-status" role="status">
            {copyStatus}
          </span>
        )}
      </section>
    </div>,
    document.body,
  );
}
