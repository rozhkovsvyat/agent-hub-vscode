import { XMarkIcon } from "@heroicons/react/24/outline";
import type { Editor } from "@tiptap/core";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface ComposerImage {
  displaySrc: string;
  name: string;
  /** Document position of the node, used to delete exactly this attachment. */
  pos: number;
  src: string;
}

function collectImages(editor: Editor): ComposerImage[] {
  const images: ComposerImage[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "image") return;
    const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    if (!src) return;
    const displaySrc =
      (typeof node.attrs.originalSrc === "string" && node.attrs.originalSrc) ||
      (typeof node.attrs.displaySrc === "string" && node.attrs.displaySrc) ||
      src;
    const label =
      (typeof node.attrs.title === "string" && node.attrs.title) ||
      (typeof node.attrs.alt === "string" && node.attrs.alt) ||
      `image-${images.length + 1}.png`;
    images.push({ displaySrc, name: label, pos, src });
  });
  return images;
}

/**
 * The composer used to render every pasted picture as a full-size card, so two
 * screenshots pushed the text field off the panel. Attachments now read as the
 * same single scrollable pill row the sent capsule uses; the inline nodes stay
 * in the document (they are what actually gets sent) but are hidden.
 *
 * Unlike the capsule's read-only strip, every pill here can be removed, which
 * is why this is a separate component rather than a flag on that one.
 */
export function CukiiComposerImageStrip({ editor }: { editor: Editor | null }) {
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [preview, setPreview] = useState<ComposerImage>();
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!editor) {
      setImages([]);
      return;
    }
    const sync = () => setImages(collectImages(editor));
    sync();
    editor.on("update", sync);
    return () => {
      editor.off("update", sync);
    };
  }, [editor]);

  useEffect(() => {
    if (!preview) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPreview(undefined);
        requestAnimationFrame(() => openerRef.current?.focus());
      } else if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  if (!editor || images.length === 0) return null;

  const remove = (image: ComposerImage) => {
    const node = editor.state.doc.nodeAt(image.pos);
    if (!node || node.type.name !== "image") return;
    editor.view.dispatch(
      editor.state.tr.delete(image.pos, image.pos + node.nodeSize),
    );
  };

  return (
    <>
      <div
        aria-label="Attached images"
        className="cukii-user-attachment-strip cukii-composer-attachment-strip"
        onClick={(event: ReactMouseEvent<HTMLDivElement>) =>
          event.stopPropagation()
        }
        role="list"
      >
        {images.map((image) => (
          <span
            className="cukii-user-attachment-card cukii-composer-attachment-card"
            key={`${image.pos}-${image.src.slice(0, 32)}`}
            role="listitem"
          >
            <button
              aria-label={`Preview ${image.name}`}
              className="cukii-composer-attachment-open"
              onClick={(event) => {
                openerRef.current = event.currentTarget;
                setPreview(image);
              }}
              title={image.name}
              type="button"
            >
              <img alt="" aria-hidden="true" src={image.displaySrc} />
              <span className="cukii-user-attachment-label">{image.name}</span>
            </button>
            <button
              aria-label={`Remove ${image.name}`}
              className="cukii-composer-attachment-remove"
              onClick={() => remove(image)}
              title="Remove attachment"
              type="button"
            >
              <XMarkIcon aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      {preview &&
        createPortal(
          <div
            className="cukii-image-lightbox"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setPreview(undefined);
                requestAnimationFrame(() => openerRef.current?.focus());
              }
            }}
          >
            <section
              aria-label="Image preview"
              aria-modal="true"
              className="cukii-image-lightbox-dialog"
              role="dialog"
            >
              <img alt={preview.name} src={preview.displaySrc} />
              <button
                aria-label="Close image preview"
                onClick={() => {
                  setPreview(undefined);
                  requestAnimationFrame(() => openerRef.current?.focus());
                }}
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
