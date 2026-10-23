import { useEffect, useState } from "preact/hooks";
import { setEdits } from "../core/edits";
import { restorePatches, snapshotOf, type LogEntry, type Snapshot } from "../core/history";
import { Segmented, downloadText, fileSafe } from "./components";
import { creatorKey, useWorkspace } from "./workspace";

const REASON_LABEL: Record<Snapshot["reason"], string> = {
  auto: "Daily automatic snapshot",
  manual: "Snapshot you took",
  beforeSave: "Before a save",
};

const FIELD_LABEL: Record<string, string> = {
  price: "Price",
  onSale: "On sale",
  managedPricing: "Managed pricing",
  regionalPricing: "Regional pricing",
  name: "Name",
  description: "Description",
  schedule: "Schedule",
};

function show(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value == null || value === "") return "—";
  if (typeof value === "object") {
    const s = value as { start?: string | null; end?: string | null };
    const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
    return `${fmt(s.start)} → ${fmt(s.end)}`;
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

export function HistoryTab({ onRestore }: { onRestore: () => void }) {
  const ws = useWorkspace();
  const { creator, history, items, universeId } = ws;
  const [view, setView] = useState<"snapshots" | "log">("snapshots");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const key = creator ? creatorKey(creator) : "";
  const experienceKey = universeId != null ? `${key}:universe:${universeId}` : null;

  const refresh = async () => {
    if (!creator) return;
    const lists = await Promise.all([history.snapshots(key), experienceKey ? history.snapshots(experienceKey) : Promise.resolve([])]);
    setSnapshots(lists.flat().sort((a, b) => b.takenAt.localeCompare(a.takenAt)));
    setLog(await history.log(key));
  };

  useEffect(() => {
    refresh();
  }, [key, experienceKey]);

  const restore = (snapshot: Snapshot) => {
    const patches = restorePatches(snapshot, items);
    const next = setEdits(ws.edits, patches);
    const staged = [...next.keys()].filter((k) => JSON.stringify(next.get(k)) !== JSON.stringify(ws.edits.get(k))).length;
    ws.setEdits(next);
    if (staged === 0) {
      alert("Everything in this snapshot already matches your items. Nothing to restore.");
      return;
    }
    onRestore();
  };

  const visibleLog = onlyFailed ? log.filter((e) => !e.ok) : log;

  const exportLog = () => {
    const rows = ["time,item,field,from,to,result"];
    for (const e of visibleLog) {
      for (const [field, { from, to }] of Object.entries(e.changes)) {
        const cells = [e.at, e.itemName, FIELD_LABEL[field] ?? field, show(from), show(to), e.ok ? "saved" : `failed: ${e.error ?? ""}`];
        rows.push(cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","));
      }
    }
    downloadText(`${fileSafe(creator?.name ?? "robulk")}-activity.csv`, rows.join("\r\n") + "\r\n", "text/csv");
  };

  return (
    <>
      <div class="rb-toolbar">
        <Segmented
          label="History view"
          value={view}
          onChange={setView}
          options={[
            ["snapshots", "Snapshots & undo"],
            ["log", "Activity log"],
          ]}
        />
        <div class="rb-spacer" />
        {view === "snapshots" ? (
          <button
            class="rb-btn"
            disabled={!creator || items.length === 0}
            onClick={async () => {
              await history.addSnapshot(key, "manual", snapshotOf(ws.avatarItems, true));
              if (experienceKey && ws.experienceItems.length) await history.addSnapshot(experienceKey, "manual", snapshotOf(ws.experienceItems, true));
              refresh();
            }}
          >
            Take snapshot now
          </button>
        ) : (
          <>
            <label class="rb-checkbox">
              <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.currentTarget.checked)} /> Failures only
            </label>
            <button class="rb-btn rb-btn-ghost" disabled={visibleLog.length === 0} onClick={exportLog}>
              Export (.csv)
            </button>
            <button
              class="rb-btn rb-btn-ghost"
              disabled={log.length === 0}
              onClick={async () => {
                if (!confirm("Clear the activity log for this creator?")) return;
                await history.clearLog(key);
                refresh();
              }}
            >
              Clear log
            </button>
          </>
        )}
      </div>

      <main class="rb-body rb-pad">
        {view === "snapshots" && (
          <>
            <p class="rb-muted">
              RoBulk records your prices and sale status once a day when you open it, and right before every save. Restoring stages the old values
              in the Items tab so you can review them before saving. Snapshots are stored only in this browser.
            </p>
            {snapshots.length === 0 && <div class="rb-empty">No snapshots yet.</div>}
            {snapshots.length > 0 && (
              <table class="rb-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th class="num">Items</th>
                    <th class="num">On sale</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((s) => (
                    <tr key={s.id}>
                      <td>{new Date(s.takenAt).toLocaleString()}</td>
                      <td>
                        {REASON_LABEL[s.reason]}
                        {s.creatorKey.includes(":universe:") && <span class="rb-muted"> · passes & products</span>}
                      </td>
                      <td class="num">{s.items.length}</td>
                      <td class="num">{s.items.filter((i) => i.onSale).length}</td>
                      <td class="rb-row-actions">
                        <button class="rb-link-btn" onClick={() => restore(s)}>
                          Restore
                        </button>
                        <button
                          class="rb-link-btn rb-danger-text"
                          onClick={async () => {
                            await history.deleteSnapshot(s.creatorKey, s.id);
                            refresh();
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {view === "log" && (
          <>
            {visibleLog.length === 0 && <div class="rb-empty">{onlyFailed ? "No failed changes." : "Nothing saved through RoBulk yet."}</div>}
            {visibleLog.length > 0 && (
              <table class="rb-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Item</th>
                    <th>Change</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLog.slice(0, 500).map((e, i) => (
                    <tr key={i}>
                      <td class="rb-nowrap">{new Date(e.at).toLocaleString()}</td>
                      <td>{e.itemName}</td>
                      <td>
                        {Object.entries(e.changes).map(([field, { from, to }]) => (
                          <div key={field}>
                            {FIELD_LABEL[field] ?? field}: <span class="rb-muted">{show(from)}</span> → {show(to)}
                          </div>
                        ))}
                      </td>
                      <td>{e.ok ? <span class="rb-ok">Saved</span> : <span class="rb-warning">Failed: {e.error}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {visibleLog.length > 500 && <p class="rb-muted">Showing the latest 500 entries. Export to see everything.</p>}
          </>
        )}
      </main>
    </>
  );
}
