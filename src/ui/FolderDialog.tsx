import { useState } from "preact/hooks";
import { Dialog, Field } from "./components";

/** Names a new folder, or renames one. */
export function FolderNameDialog({
  title,
  initial = "",
  action,
  note,
  onApply,
  onClose,
}: {
  title: string;
  initial?: string;
  action: string;
  note?: string;
  onApply: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const ok = name.trim() !== "";
  const apply = () => {
    if (!ok) return;
    onApply(name.trim());
    onClose();
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button class="rb-btn rb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="rb-btn rb-btn-primary" disabled={!ok} onClick={apply}>
            {action}
          </button>
        </>
      }
    >
      <Field label="Folder name">
        <input
          class="rb-input"
          value={name}
          maxLength={60}
          placeholder="e.g. Christmas set"
          ref={(el) => el?.focus()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
      </Field>
      {note && <p class="rb-muted rb-small">{note}</p>}
    </Dialog>
  );
}
