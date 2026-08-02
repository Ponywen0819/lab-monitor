import { useEffect, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: (() => void) | null;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!onClose) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={() => onClose?.()}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          {onClose && (
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
