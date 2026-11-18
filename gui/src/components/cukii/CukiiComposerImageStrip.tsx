import { XMarkIcon } from "@heroicons/react/24/outline";
import type { Editor } from "@tiptap/core";
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { CukiiImageLightbox } from "./CukiiImageLightbox";

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
      {preview && (
        <CukiiImageLightbox
          name={preview.name}
          source={preview.displaySrc}
          onClose={() => {
            setPreview(undefined);
            requestAnimationFrame(() => openerRef.current?.focus());
          }}
        />
      )}
    </>
  );
}
