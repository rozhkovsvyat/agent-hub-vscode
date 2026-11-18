import type { CukiiClaudePermissionRequest } from "core/protocol/ideWebview";
import { useContext, useEffect, useRef } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  enqueueClaudePermission,
  removeClaudePermission,
} from "../../redux/slices/sessionSlice";

function key(request: CukiiClaudePermissionRequest): string {
  return `${request.runId}:${request.requestId}`;
}

/**
 * Native Claude permission prompts. The broker revalidates every response;
 * this component only renders the already-bound request and never supplies
 * tool input back to the extension.
 */
export function ClaudePermissionPrompt() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const sessionId = useAppSelector((state) => state.session.id);
  const pending = useAppSelector(
    (state) => state.session.pendingClaudePermissions,
  );
  const request = Object.values(pending)[0];
  const pendingRef = useRef(pending);
  const allowButtonRef = useRef<HTMLButtonElement>(null);
  pendingRef.current = pending;

  useEffect(() => {
    allowButtonRef.current?.focus();
  }, [request?.runId, request?.requestId]);

  const deny = (item: CukiiClaudePermissionRequest) => {
    ideMessenger.post("cukii/respondClaudePermission", {
      runId: item.runId,
      requestId: item.requestId,
      sessionId: item.sessionId,
      inputFingerprint: item.inputFingerprint,
      decision: "deny",
    });
    dispatch(
      removeClaudePermission({ runId: item.runId, requestId: item.requestId }),
    );
  };

  const decide = (
    item: CukiiClaudePermissionRequest,
    decision: "allow" | "deny",
  ) => {
    ideMessenger.post("cukii/respondClaudePermission", {
      runId: item.runId,
      requestId: item.requestId,
      sessionId: item.sessionId,
      inputFingerprint: item.inputFingerprint,
      decision,
    });
    dispatch(
      removeClaudePermission({ runId: item.runId, requestId: item.requestId }),
    );
  };

  useWebviewListener(
    "cukii/claudePermissionRequested",
    async (item) => {
      // A delayed notification after the panel has moved to another session is
      // an explicit denial, never a modal attached to the wrong conversation.
      if (item.sessionId !== sessionId) {
        ideMessenger.post("cukii/respondClaudePermission", {
          runId: item.runId,
          requestId: item.requestId,
          sessionId: item.sessionId,
          inputFingerprint: item.inputFingerprint,
          decision: "deny",
        });
        return { accepted: false };
      }
      dispatch(enqueueClaudePermission(item));
      return { accepted: true };
    },
    [dispatch, ideMessenger, sessionId],
  );

  useEffect(() => {
    return () => {
      // Closing/replacing the webview must fail closed for every outstanding
      // tool request. The native broker verifies the run/session again.
      for (const item of Object.values(pendingRef.current)) deny(item);
    };
    // Intentionally unmount-only; changing pending must not deny existing work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!request) return null;
  const preview = JSON.stringify(request.input, null, 2);
  return (
    <section
      aria-label="Permission request"
      aria-modal="true"
      className="cukii-permission-request fixed bottom-5 right-5 z-[2000] w-[min(420px,calc(100vw-2rem))]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          decide(request, "deny");
        }
        if (event.key === "Enter" && event.target === event.currentTarget) {
          event.preventDefault();
          decide(request, "allow");
        }
      }}
      role="dialog"
    >
      <div className="cukii-permission-request-title">
        Allow Cukii to run {request.toolName}?
      </div>
      <pre className="cukii-permission-request-preview" tabIndex={0}>
        {preview}
      </pre>
      <div className="cukii-permission-request-actions">
        <button
          type="button"
          className="cukii-permission-request-deny"
          onClick={() => decide(request, "deny")}
        >
          Deny
        </button>
        <button
          type="button"
          className="cukii-permission-request-allow"
          onClick={() => decide(request, "allow")}
          ref={allowButtonRef}
        >
          Allow
        </button>
      </div>
    </section>
  );
}
