import type { useToast } from "../hooks/useToast";

type ToastState = ReturnType<typeof useToast>["toast"];

interface ToastProps {
  toast: ToastState;
  onDismiss: () => void;
}

// Bottom-of-window banner rendered from `useToast`'s state. `toast.undo`
// (when present) surfaces the same action as `u`/⌘Z; dismissing just hides
// the banner — the retained undo (see useToast) still works after.
export function Toast({ toast, onDismiss }: ToastProps) {
  return (
    toast && (
      <div className="toast">
        <span className="toast-message">{toast.message}</span>
        {toast.undo && (
          <button
            type="button"
            className="toast-undo"
            title="Undo (u)"
            onClick={() => toast.undo?.()}
          >
            Undo
          </button>
        )}
        <button
          type="button"
          className="toast-dismiss ghost"
          title="Dismiss"
          onClick={onDismiss}
        >
          ✕
        </button>
      </div>
    )
  );
}
