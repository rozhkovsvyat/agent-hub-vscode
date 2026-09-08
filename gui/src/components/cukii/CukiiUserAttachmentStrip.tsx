import { DocumentTextIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ContextItemWithId } from "core";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import FileIcon from "../FileIcon";
import { openContextItem } from "../mainInput/belowMainInput/ContextItemsPeek";
import { isFileAttachmentContextItem } from "./userAttachments";

interface ImageAttachment {
  kind: "image";
  key: string;
  name: string;
  /** Transport copy — downscaled to fit the vendor channel. */
  src: string;
  /**
   * What the user actually sees. Broker transport shrinks pictures to 384px,
   * so previewing `src` showed an unreadable thumbnail instead of the picture
   * that was attached.
   */
  previewSrc: string;
}

interface FileAttachment {
  contextItem: ContextItemWithId;
  kind: "file";
  key: string;
  name: string;
}

type UserAttachment = FileAttachment | ImageAttachment;

function ImageAttachmentPill({
  attachment,
  onPreview,
}: {
  attachment: ImageAttachment;
  onPreview: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const [dimensions, setDimensions] = useState<string>();
  return (
    <button
      aria-label={`Preview ${attachment.name}`}
      className="cukii-user-attachment-card"
      onClick={onPreview}
      role="listitem"
      title={attachment.name}
      type="button"
    >
      <img
        alt=""
        aria-hidden="true"
        onLoad={(event) => {
          const image = event.currentTarget;
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            setDimensions(`${image.naturalWidth}×${image.naturalHeight}`);
          }
        }}
        src={attachment.previewSrc}
      />
      <span className="cukii-user-attachment-label">{attachment.name}</span>
      {dimensions && (
        <span className="cukii-user-attachment-meta">{dimensions}</span>
      )}
    </button>
  );
}

function imageExtension(src: string): string {
  const mime = /^data:image\/([^;,]+)/i.exec(src)?.[1]?.toLowerCase();
  if (mime) {
    if (mime === "jpeg") return "jpg";
    if (mime === "svg+xml") return "svg";
    return mime.replace(/[^a-z0-9]/g, "") || "png";
  }
  try {
    const basename = decodeURIComponent(
      new URL(src).pathname.split("/").pop() ?? "",
    );
    const extension = basename.split(".").pop();
    return extension && extension !== basename ? extension : "png";
  } catch {
    return "png";
  }
}

function imageDisplayName(
  src: string,
  index: number,
  explicitName?: unknown,
): string {
  if (typeof explicitName === "string" && explicitName.trim()) {
    return explicitName.trim();
  }
  if (!src.startsWith("data:")) {
    try {
      const basename = decodeURIComponent(
        new URL(src).pathname.split("/").pop() ?? "",
      );
      if (basename) return basename;
    } catch {
      // The fallback below is deliberately stable for non-URL webview sources.
    }
  }
  return `image-${index + 1}.${imageExtension(src)}`;
}

function collectEditorAttachments(value: unknown): UserAttachment[] {
  const attachments: UserAttachment[] = [];
  let imageIndex = 0;

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    if (record.type === "imageUrl") {
      const imageUrl = record.imageUrl as Record<string, unknown> | undefined;
      const src = typeof imageUrl?.url === "string" ? imageUrl.url : "";
      if (src) {
        const name = imageDisplayName(src, imageIndex, imageUrl?.name);
        attachments.push({
          kind: "image",
          key: `image-${imageIndex}-${src.slice(0, 48)}`,
          name,
          previewSrc: src,
          src,
        });
        imageIndex += 1;
      }
      return;
    }

    if (record.type === "image") {
      const attrs = record.attrs as Record<string, unknown> | undefined;
      const src = typeof attrs?.src === "string" ? attrs.src : "";
      if (src) {
        const name = imageDisplayName(
          src,
          imageIndex,
          attrs?.title ?? attrs?.alt,
        );
        const displaySrc =
          typeof attrs?.displaySrc === "string" && attrs.displaySrc
            ? attrs.displaySrc
            : src;
        attachments.push({
          kind: "image",
          key: `image-${imageIndex}-${src.slice(0, 48)}`,
          name,
          previewSrc: displaySrc,
          src,
        });
        imageIndex += 1;
      }
      return;
    }

    if (record.type === "code-block") {
      const attrs = record.attrs as Record<string, unknown> | undefined;
      const item = attrs?.item as ContextItemWithId | undefined;
      if (item && isFileAttachmentContextItem(item)) {
        attachments.push({
          contextItem: item,
          kind: "file",
          key: `file-${item.id.providerTitle}-${item.id.itemId}`,
          name: item.name,
        });
      }
      return;
    }

    visit(record.content);
  };

  visit(value);
  return attachments;
}

function mergeAttachments(
  editorState: unknown,
  contextItems: ContextItemWithId[],
): UserAttachment[] {
  const merged = collectEditorAttachments(editorState);
  const fileKeys = new Set(
    merged
      .filter((item): item is FileAttachment => item.kind === "file")
      .map((item) => item.key),
  );
  for (const item of contextItems) {
    if (item.hidden || !isFileAttachmentContextItem(item)) continue;
    const key = `file-${item.id.providerTitle}-${item.id.itemId}`;
    if (fileKeys.has(key)) continue;
    fileKeys.add(key);
    merged.push({ contextItem: item, kind: "file", key, name: item.name });
  }
  return merged;
}

export function CukiiUserAttachmentStrip({
  contextItems,
  editorState,
}: {
  contextItems: ContextItemWithId[];
  editorState: unknown;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const attachments = useMemo(
    () => mergeAttachments(editorState, contextItems),
    [contextItems, editorState],
  );
  const [preview, setPreview] = useState<ImageAttachment>();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const closePreview = () => {
    setPreview(undefined);
    requestAnimationFrame(() => openerRef.current?.focus());
  };

  useEffect(() => {
    if (!preview) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  if (!attachments.length) return null;

  const stopBubbleInteraction = (
    event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
  ) => event.stopPropagation();

  return (
    <>
      <div
        aria-label="Message attachments"
        className="cukii-user-attachment-strip"
        onClick={stopBubbleInteraction}
        onKeyDown={stopBubbleInteraction}
        role="list"
      >
        {attachments.map((attachment) => {
          if (attachment.kind === "image") {
            return (
              <ImageAttachmentPill
                attachment={attachment}
                key={attachment.key}
                onPreview={(event) => {
                  openerRef.current = event.currentTarget;
                  setPreview(attachment);
                }}
              />
            );
          }
          return (
            <button
              aria-label={`Open ${attachment.name}`}
              className="cukii-user-attachment-card cukii-user-attachment-card--file"
              key={attachment.key}
              onClick={() =>
                openContextItem(attachment.contextItem, ideMessenger)
              }
              role="listitem"
              title={attachment.name}
              type="button"
            >
              <span
                className="cukii-user-attachment-file-icon"
                aria-hidden="true"
              >
                {attachment.name ? (
                  <FileIcon
                    filename={attachment.name}
                    height="12px"
                    width="12px"
                  />
                ) : (
                  <DocumentTextIcon />
                )}
              </span>
              <span className="cukii-user-attachment-label">
                {attachment.name}
              </span>
            </button>
          );
        })}
      </div>
      {preview &&
        createPortal(
          <div
            className="cukii-image-lightbox"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closePreview();
            }}
          >
            <section
              aria-label="Image preview"
              aria-modal="true"
              className="cukii-image-lightbox-dialog"
              role="dialog"
            >
              <img alt={preview.name} src={preview.previewSrc} />
              <button
                aria-label="Close image preview"
                onClick={closePreview}
                ref={closeRef}
                title="Close preview (Esc)"
                type="button"
              >
                <XMarkIcon aria-hidden="true" />
              </button>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
