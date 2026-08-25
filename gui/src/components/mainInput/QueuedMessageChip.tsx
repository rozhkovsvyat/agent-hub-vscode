import { XMarkIcon } from "@heroicons/react/24/outline";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  clearQueuedMessage,
  setMainEditorContentTrigger,
} from "../../redux/slices/sessionSlice";

export function QueuedMessageChip() {
  const dispatch = useAppDispatch();
  const queuedMessage = useAppSelector((state) => state.session.queuedMessage);

  if (!queuedMessage) {
    return null;
  }

  return (
    <div
      className="text-description mb-1 flex min-w-0 items-center gap-1 rounded-md px-2 py-1"
      data-testid="queued-message-chip"
    >
      <button
        type="button"
        className="hover:text-foreground min-w-0 flex-1 truncate text-left text-xs"
        onClick={() => {
          dispatch(setMainEditorContentTrigger(queuedMessage.editorState));
          dispatch(clearQueuedMessage());
        }}
      >
        <span className="text-description-muted mr-1.5">В очереди</span>
        {queuedMessage.preview}
      </button>
      <button
        type="button"
        aria-label="Убрать из очереди"
        className="hover:text-foreground flex-shrink-0 p-0.5"
        onClick={(event) => {
          event.stopPropagation();
          dispatch(clearQueuedMessage());
        }}
      >
        <XMarkIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
