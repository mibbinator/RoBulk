import { useEffect, useState } from "preact/hooks";
import { BadgesTab } from "./BadgesTab";
import { CreateTab } from "./CreateTab";
import { EarningsTab } from "./EarningsTab";
import { HistoryTab } from "./HistoryTab";
import { ItemsTab } from "./ItemsTab";
import { OptionsTab } from "./OptionsTab";
import { PayoutsTab } from "./PayoutsTab";
import { WorkspaceContext, creatorKey, useWorkspaceState, type Opening } from "./workspace";

export type TabId = "items" | "earnings" | "create" | "badges" | "history" | "payouts" | "options";

const TABS: { id: TabId; label: string }[] = [
  { id: "items", label: "Items" },
  { id: "earnings", label: "Earnings report" },
  { id: "create", label: "Create & copy" },
  { id: "badges", label: "Badges" },
  { id: "history", label: "History" },
  { id: "payouts", label: "Payouts" },
  { id: "options", label: "Options" },
];

export function Shell({
  onClose,
  initialTab = "items",
  initialUniverseId = null,
  opening,
  onOpenOverview,
}: {
  onClose: () => void;
  /** Opens the account overview instead (not shown on the preview page). */
  onOpenOverview?: () => void;
  initialTab?: TabId;
  initialUniverseId?: number | null;
  opening?: Opening;
}) {
  const ws = useWorkspaceState(initialUniverseId, opening);
  const [tab, setTab] = useState<TabId>(initialTab);
  const [busy, setBusy] = useState(false);
  const { creators, creator, experiences, universeId, edits } = ws;

  const confirmDiscard = (action: string) => edits.size === 0 || confirm(`${action}? Your unsaved changes will be lost.`);

  const requestClose = () => {
    if (busy || !confirmDiscard("Close RoBulk")) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const tabAvailable = (id: TabId) =>
    id === "create" || id === "badges" ? creator?.access.experiences !== false : id === "payouts" ? creator?.type === "Group" : true;

  return (
    <WorkspaceContext.Provider value={ws}>
      <div class="rb-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <div class="rb-panel" role="dialog" aria-label="RoBulk">
          <header class="rb-header">
            <div class="rb-title">
              <span class="rb-brand">RoBulk</span>
            </div>
            <div class="rb-header-controls">
              <select
                class="rb-select"
                aria-label="Creator"
                value={creator ? creatorKey(creator) : ""}
                disabled={!creators || busy}
                onChange={(e) => {
                  const next = creators?.find((c) => creatorKey(c) === e.currentTarget.value);
                  if (!next) return;
                  if (!confirmDiscard("Switch creator")) {
                    e.currentTarget.value = creator ? creatorKey(creator) : "";
                    return;
                  }
                  ws.setCreator(next);
                }}
              >
                {!creators && <option>Loading…</option>}
                {creators?.map((c) => (
                  <option key={creatorKey(c)} value={creatorKey(c)}>
                    {c.type === "Group" ? `Group: ${c.name}` : `Me: ${c.name}`}
                  </option>
                ))}
              </select>
              <select
                class="rb-select"
                aria-label="Experience"
                value={universeId == null ? "" : String(universeId)}
                disabled={experiences.length === 0 || busy}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  const hasExperienceEdits = [...edits.keys()].some((k) => !k.startsWith("avatar:"));
                  if (hasExperienceEdits && !confirm("Switch experience? Unsaved game pass and product changes will be lost.")) {
                    e.currentTarget.value = universeId == null ? "" : String(universeId);
                    return;
                  }
                  ws.setEdits((prev) => new Map([...prev].filter(([k]) => k.startsWith("avatar:"))));
                  ws.setUniverseId(raw === "" ? null : Number(raw));
                }}
              >
                <option value="">{experiences.length === 0 ? "No experiences" : "No experience selected"}</option>
                {experiences.map((x) => (
                  <option key={x.universeId} value={String(x.universeId)}>
                    Experience: {x.name}
                  </option>
                ))}
              </select>
              {onOpenOverview && (
                <button class="rb-btn rb-btn-ghost" disabled={busy} onClick={() => confirmDiscard("Open the account overview") && onOpenOverview()}>
                  Account overview
                </button>
              )}
              <button class="rb-icon-btn" title="Close (Esc)" onClick={requestClose} disabled={busy}>
                ✕
              </button>
            </div>
          </header>

          <nav class="rb-tabs" role="tablist">
            {TABS.filter((t) => tabAvailable(t.id)).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                class={tab === t.id ? "is-active" : ""}
                disabled={busy && tab !== t.id}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === "items" && edits.size > 0 && <span class="rb-tab-badge">{edits.size}</span>}
              </button>
            ))}
          </nav>

          {ws.notice && <div class="rb-banner">{ws.notice}</div>}

          {tab === "items" && <ItemsTab onBusy={setBusy} />}
          {tab === "earnings" && <EarningsTab />}
          {tab === "create" && <CreateTab onBusy={setBusy} />}
          {tab === "badges" && <BadgesTab onBusy={setBusy} />}
          {tab === "history" && <HistoryTab onRestore={() => setTab("items")} />}
          {tab === "payouts" && <PayoutsTab />}
          {tab === "options" && <OptionsTab />}

          {/* The Earnings report shows its own progress. */}
          {ws.sales.loading && tab !== "earnings" && (
            <div class="rb-loadbar" role="status">
              <div class={`rb-progress-bar ${ws.sales.fraction == null ? "is-indeterminate" : ""}`}>
                <div style={{ width: ws.sales.fraction == null ? undefined : `${Math.round(ws.sales.fraction * 100)}%` }} />
              </div>
              <span title={ws.sales.progress ?? undefined}>{ws.sales.progress} You can keep using RoBulk while it loads.</span>
              <button class="rb-link-btn" onClick={ws.stopSales}>
                Stop
              </button>
              {tab !== "options" && (
                <button class="rb-link-btn" disabled={busy} onClick={() => setTab("options")}>
                  Options
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
