import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Нижня шторка поверх усього застосунку (портал у #sheet-root всередині .app). */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const [root, setRoot] = useState<Element | null>(null);
  useEffect(() => setRoot(document.getElementById("sheet-root")), []);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!root) return null;
  return createPortal(
    <>
      <div className={"scrim" + (open ? " on" : "")} onClick={onClose} />
      <div className={"sheet" + (open ? " on" : "")} role="dialog" aria-modal="true" aria-label={title} aria-hidden={!open}>
        <h2>{title}</h2>
        {open && children}
      </div>
    </>,
    root,
  );
}
