import { KeyboardEvent, ReactNode, useLayoutEffect, useRef } from "react";

interface ModalProps {
  className: string;
  label?: string;
  /** While true, neither Esc nor the backdrop can dismiss it. */
  locked?: boolean;
  /** Focus the panel rather than its first control. */
  focusSelf?: boolean;
  onClose: () => void;
  /** Esc does this instead of closing, e.g. stepping back. */
  onEscape?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
  children: ReactNode;
}

/**
 * A native modal dialog, open for as long as it's mounted. The parent closes it
 * by unmounting; closing first is what hands focus back to the opener.
 */
export function Modal({ className, label, locked, focusSelf, onClose, onEscape, onKeyDown, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    el.showModal();
    if (focusSelf) el.focus();
    return () => el.close();
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const escape = () => {
    if (!locked) (onEscape ?? onClose)();
  };

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={label}
      // clicks on plain content land focus here, so Esc always reaches onKeyDown
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        escape();
      }}
      onClick={(e) => e.target === e.currentTarget && !locked && onClose()}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return onKeyDown?.(e);
        // webviews ignore preventDefault on repeat cancels, so stop Esc before it becomes one
        e.preventDefault();
        e.stopPropagation();
        escape();
      }}
    >
      {children}
    </dialog>
  );
}

/** A Modal that slides in from the right. */
export function Drawer({
  className,
  children,
  sidebarToggle,
  ...modal
}: Omit<ModalProps, "focusSelf" | "onEscape" | "onKeyDown"> & { sidebarToggle: ReactNode }) {
  return (
    <Modal className="viewer-backdrop drawer-backdrop" focusSelf {...modal}>
      {sidebarToggle}
      <aside className={`drawer ${className}`}>{children}</aside>
    </Modal>
  );
}
