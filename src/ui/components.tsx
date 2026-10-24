import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div class="rb-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="rb-dialog" role="dialog" aria-label={title} style={{ width: `min(${width}px, 100%)` }}>
        <header class="rb-dialog-header">
          <h2>{title}</h2>
          <button class="rb-icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div class="rb-dialog-body">{children}</div>
        {footer && <footer class="rb-dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
  divider?: boolean;
}

/** A button that opens a small list of actions. */
export function Menu({ label, items, disabled, align = "left", up = false }: { label: string; items: MenuItem[]; disabled?: boolean; align?: "left" | "right"; up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!e.composedPath().includes(ref.current!)) setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);

  return (
    <div class="rb-menu" ref={ref}>
      <button class="rb-btn" disabled={disabled} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {label} <span class="rb-caret">▾</span>
      </button>
      {open && (
        <div class={`rb-menu-list ${align === "right" ? "is-right" : ""} ${up ? "is-up" : ""}`} role="menu">
          {items.map((item, i) =>
            item.divider ? (
              <div key={i} class="rb-menu-divider" />
            ) : (
              <button
                key={i}
                role="menuitem"
                class="rb-menu-item"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: string }) {
  return (
    <label class="rb-field">
      <span class="rb-field-label">{label}</span>
      {children}
      {hint && <span class="rb-field-hint">{hint}</span>}
    </label>
  );
}

/** `options` are [value, label] pairs, with an optional extra class for that option. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string] | readonly [T, string, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div class="rb-segmented" role="group" aria-label={label}>
      {options.map(([v, text, extra]) => (
        <button key={v} class={`${value === v ? "is-active" : ""} ${extra ?? ""}`.trim()} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Saves text as a file via a temporary link. */
export function downloadText(filename: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "robulk";
