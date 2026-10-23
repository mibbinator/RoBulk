import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { SellableItem } from "../api/types";
import { CATEGORIES, categoryFor, type CategoryId } from "../core/categories";
import { csvToPatches, toCsv } from "../core/csv";
import { applyAction, effective, pendingChanges, setEdit, setEdits, type BulkAction, type Edit, type PendingChange } from "../core/edits";
import { describeChanges, snapshotOf, type LogEntry } from "../core/history";
import { runPaced } from "../core/queue";
import { saveChange } from "../core/save";
import { robux } from "./charts";
import { Menu, Segmented, downloadText, fileSafe } from "./components";
import { ImportResultDialog, ItemStatsDialog, LuaDialog, PriceRuleDialog, ScheduleDialog, TextDialog } from "./ItemDialogs";
import { creatorKey, useWorkspace } from "./workspace";

type SaleFilter = "all" | "onSale" | "offSale";
type SortKey = "default" | "name" | "priceHigh" | "priceLow" | "sales" | "earned";
type RowStatus = { state: "saving" | "saved" | "failed"; error?: string };
type DialogState =
  | { kind: "priceRule" }
  | { kind: "schedule" }
  | { kind: "text"; field: "name" | "description" }
  | { kind: "lua" }
  | { kind: "import"; staged: number; warnings: string[] }
  | { kind: "stats"; item: SellableItem }
  | null;

interface SaveProgress {
  done: number;
  total: number;
  failed: number;
  running: boolean;
}

function itemLink(item: SellableItem): string {
  switch (item.kind) {
    case "avatar":
      return `https://www.roblox.com/catalog/${item.id}`;
    case "gamePass":
      return `https://www.roblox.com/game-pass/${item.id}`;
    case "devProduct":
      return `https://create.roblox.com/dashboard/creations/experiences/${item.universeId}/developer-products/${item.id}/configure`;
  }
}

export function ItemsTab({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const ws = useWorkspace();
  const { client, history, creator, items, edits, setEdits: setWsEdits, thumbs, sales, loading, loadingExperience, error } = ws;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStatus, setRowStatus] = useState<Map<string, RowStatus>>(new Map());
  const [filter, setFilter] = useState<SaleFilter>("all");
  const [sort, setSort] = useState<SortKey>("default");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<CategoryId>>(new Set());
  const [bulkPrice, setBulkPrice] = useState("");
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastClicked = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const saving = progress?.running ?? false;

  // Look up the creator share for every price on screen, including staged ones.
  useEffect(() => {
    ws.ensureSplits(items.map((item) => ({ item, price: effective(item, edits.get(item.key)).price })));
  }, [items, edits]);
  const perItemSales = sales.current?.perItem;

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  };

  // Visible items, sorted and grouped by category.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = items.filter((item) => {
      const eff = effective(item, edits.get(item.key));
      if (q && !eff.name.toLowerCase().includes(q) && !String(item.id).includes(q)) return false;
      // Filter on the saved status, so staged items stay in view for review until saved.
      return filter === "all" || (filter === "onSale" ? item.onSale : !item.onSale);
    });
    const salesOf = (i: SellableItem) => perItemSales?.get(i.key);
    const sorters: Record<SortKey, ((a: SellableItem, b: SellableItem) => number) | null> = {
      default: null,
      name: (a, b) => a.name.localeCompare(b.name),
      priceHigh: (a, b) => (b.price ?? -1) - (a.price ?? -1),
      priceLow: (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity),
      sales: (a, b) => (salesOf(b)?.sales ?? 0) - (salesOf(a)?.sales ?? 0),
      earned: (a, b) => (salesOf(b)?.robux ?? 0) - (salesOf(a)?.robux ?? 0),
    };
    const sorter = sorters[sort];
    return sorter ? [...list].sort(sorter) : list;
  }, [items, edits, filter, query, sort, perItemSales]);

  const groups = useMemo(
    () => CATEGORIES.map((cat) => ({ ...cat, items: visible.filter((i) => categoryFor(i) === cat.id) })).filter((g) => g.items.length > 0),
    [visible],
  );

  const flatVisible = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.key)), [items, selected]);
  const changes = useMemo(() => pendingChanges(items, edits), [items, edits]);
  const problems = useMemo(() => new Map(changes.filter((c) => c.problem).map((c) => [c.item.key, c.problem!])), [changes]);
  const saveable = changes.filter((c) => !c.problem);
  const selectedPassesOrProducts = selectedItems.filter((i) => i.kind !== "avatar");
  const selectedAvatar = selectedItems.filter((i) => i.kind === "avatar");

  // Selection
  const toggleRow = (item: SellableItem, shiftKey: boolean) => {
    const next = new Set(selected);
    const turnOn = !selected.has(item.key);
    const idx = flatVisible.findIndex((i) => i.key === item.key);
    const anchor = flatVisible.findIndex((i) => i.key === lastClicked.current);
    const range = shiftKey && anchor >= 0 ? flatVisible.slice(Math.min(anchor, idx), Math.max(anchor, idx) + 1) : [item];
    for (const i of range) turnOn ? next.add(i.key) : next.delete(i.key);
    lastClicked.current = item.key;
    setSelected(next);
  };

  const setMany = (list: SellableItem[], on: boolean) => {
    const next = new Set(selected);
    for (const i of list) on ? next.add(i.key) : next.delete(i.key);
    setSelected(next);
  };

  // Edits
  const bulk = (action: BulkAction) => setWsEdits(applyAction(edits, selectedItems, action));
  const stagePatches = (patches: { item: SellableItem; patch: Edit }[]) => setWsEdits(setEdits(edits, patches));
  const bulkPriceValue = Number(bulkPrice);
  const bulkPriceOk = bulkPrice.trim() !== "" && Number.isInteger(bulkPriceValue) && bulkPriceValue >= 0;

  const editPrice = (item: SellableItem, raw: string) => {
    const trimmed = raw.trim();
    setWsEdits(setEdit(edits, item, { price: trimmed === "" ? (item.price ?? undefined) : Number(trimmed) }));
  };

  // Import / export
  const exportCsv = (list: SellableItem[]) => {
    const name = creator ? fileSafe(creator.name) : "robulk";
    downloadText(`${name}-items-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(list), "text/csv");
  };

  const importCsv = async (file: File) => {
    const { patches, warnings } = csvToPatches(await file.text(), items);
    const next = setEdits(edits, patches);
    const staged = [...next.keys()].filter((k) => JSON.stringify(next.get(k)) !== JSON.stringify(edits.get(k))).length;
    setWsEdits(next);
    setDialog({ kind: "import", staged, warnings });
  };

  const snapshotNow = async () => {
    if (!creator) return;
    await history.addSnapshot(creatorKey(creator), "manual", snapshotOf(items, true));
    flash(`Snapshot saved (${items.length} items). Find it in the History tab.`);
  };

  // Saving
  const save = async () => {
    if (saveable.length === 0 || !creator) return;
    const key = creatorKey(creator);
    const controller = new AbortController();
    abortRef.current = controller;
    onBusy(true);
    setProgress({ done: 0, total: saveable.length, failed: 0, running: true });
    setRowStatus((prev) => {
      const next = new Map(prev);
      for (const c of saveable) next.set(c.item.key, { state: "saving" });
      return next;
    });
    // Remember the "before" state so this save can be undone from History.
    await history.addSnapshot(key, "beforeSave", snapshotOf(saveable.map((c) => c.item), true)).catch(() => {});

    const log: LogEntry[] = [];
    let failed = 0;
    await runPaced<PendingChange>(saveable, (c) => saveChange(client, c), {
      signal: controller.signal,
      onResult: (r, done, total) => {
        const { item, changed } = r.task;
        log.push({ at: new Date().toISOString(), creatorKey: key, itemKey: item.key, itemName: item.name, changes: describeChanges(item, changed), ok: r.ok, error: r.error });
        if (r.ok) {
          // Roblox accepted it: treat the new values as the item's real state.
          const { schedule: _schedule, ...fields } = changed;
          const update = (list: SellableItem[]) => list.map((i) => (i.key === item.key ? { ...i, ...fields } : i));
          item.kind === "avatar" ? ws.setAvatarItems(update) : ws.setExperienceItems(update);
          setWsEdits((prev) => {
            const next = new Map(prev);
            next.delete(item.key);
            return next;
          });
        } else failed++;
        setRowStatus((prev) => new Map(prev).set(item.key, r.ok ? { state: "saved" } : { state: "failed", error: r.error }));
        setProgress({ done, total, failed, running: done < total });
      },
    });

    await history.appendLog(log).catch(() => {});
    setProgress((p) => (p ? { ...p, running: false } : p));
    setRowStatus((prev) => {
      const next = new Map(prev);
      for (const [k, s] of next) if (s.state === "saving") next.delete(k);
      return next;
    });
    abortRef.current = null;
    onBusy(false);
  };

  const sortOptions: [SortKey, string][] = [
    ["default", "Recently updated"],
    ["name", "Name"],
    ["priceHigh", "Price: high to low"],
    ["priceLow", "Price: low to high"],
    ...(perItemSales ? ([["sales", "Best sellers"], ["earned", "Most earned"]] as [SortKey, string][]) : []),
  ];

  return (
    <>
      <div class="rb-toolbar">
        <input class="rb-input rb-search" type="search" placeholder="Search name or id" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        <Segmented
          label="Filter by sale status"
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "All"],
            ["onSale", "On sale"],
            ["offSale", "Off sale"],
          ]}
        />
        <select class="rb-select" aria-label="Sort" value={sort} onChange={(e) => setSort(e.currentTarget.value as SortKey)}>
          {sortOptions.map(([k, l]) => (
            <option key={k} value={k}>
              Sort: {l}
            </option>
          ))}
        </select>
        <div class="rb-spacer" />
        <button class="rb-btn rb-btn-ghost" disabled={flatVisible.length === 0} onClick={() => setMany(flatVisible, true)}>
          Select all
        </button>
        <button class="rb-btn rb-btn-ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          Clear
        </button>
        <Menu
          label="Import / export"
          align="right"
          items={[
            { label: "Export all items (.csv)", onSelect: () => exportCsv(items), disabled: items.length === 0 },
            { label: `Export selected (${selected.size}) (.csv)`, onSelect: () => exportCsv(selectedItems), disabled: selected.size === 0 },
            { label: "Import spreadsheet (.csv)…", onSelect: () => fileInput.current?.click(), disabled: saving },
            { label: "", onSelect: () => {}, divider: true },
            {
              label: "Export pass & product ids as Lua…",
              onSelect: () => setDialog({ kind: "lua" }),
              disabled: ws.experienceItems.length === 0,
              hint: ws.experienceItems.length === 0 ? "Pick an experience with passes or products first" : undefined,
            },
          ]}
        />
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) importCsv(file);
          }}
        />
        <button
          class="rb-btn rb-btn-ghost"
          disabled={!creator || loading || saving}
          onClick={() => (edits.size === 0 || confirm("Refresh? Your unsaved changes will be lost.")) && ws.reloadCreator()}
        >
          Refresh
        </button>
      </div>

      {creator?.access.earnings && !sales.current && (
        <div class="rb-strip">
          {sales.loading ? (
            <span>{sales.progress}</span>
          ) : (
            <>
              <span>See how many of each item sold and what it earned.</span>
              <button class="rb-link-btn" onClick={() => ws.loadSales(sales.range)}>
                Load sales for the last {sales.range} days
              </button>
            </>
          )}
        </div>
      )}

      <main class="rb-body">
        {loading && items.length === 0 && <div class="rb-empty">Loading items…</div>}
        {!loading && error && <div class="rb-empty rb-error">{error}</div>}
        {!loading && !error && items.length === 0 && <div class="rb-empty">No items found for this creator.</div>}
        {!loading && !error && items.length > 0 && groups.length === 0 && <div class="rb-empty">No items match your search or filter.</div>}

        {groups.map((group) => {
          const selectedCount = group.items.filter((i) => selected.has(i.key)).length;
          const allOn = selectedCount === group.items.length;
          const isCollapsed = collapsed.has(group.id);
          return (
            <section class="rb-group" key={group.id}>
              <div class="rb-group-header">
                <input
                  type="checkbox"
                  class="rb-check"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedCount > 0 && !allOn;
                  }}
                  onChange={() => setMany(group.items, !allOn)}
                  aria-label={`Select all ${group.label}`}
                />
                <button
                  class="rb-group-toggle"
                  onClick={() => {
                    const next = new Set(collapsed);
                    isCollapsed ? next.delete(group.id) : next.add(group.id);
                    setCollapsed(next);
                  }}
                >
                  <span class={`rb-chevron ${isCollapsed ? "is-collapsed" : ""}`}>▾</span>
                  {group.label}
                  <span class="rb-count">{group.items.length}</span>
                  {selectedCount > 0 && <span class="rb-count rb-count-accent">{selectedCount} selected</span>}
                </button>
              </div>

              {!isCollapsed &&
                group.items.map((item) => (
                  <Row
                    key={item.key}
                    item={item}
                    edit={edits.get(item.key)}
                    thumb={thumbs.get(item.key)}
                    selected={selected.has(item.key)}
                    status={rowStatus.get(item.key)}
                    problem={problems.get(item.key)}
                    disabled={saving}
                    sales={perItemSales ? (perItemSales.get(item.key) ?? { robux: 0, sales: 0 }) : undefined}
                    perSale={ws.earningsPerSale(item, effective(item, edits.get(item.key)).price)}
                    onToggle={(shift) => toggleRow(item, shift)}
                    onPrice={(raw) => editPrice(item, raw)}
                    onManaged={(enabled) => setWsEdits(setEdit(edits, item, { managedPricing: enabled }))}
                    onStats={() => setDialog({ kind: "stats", item })}
                  />
                ))}
            </section>
          );
        })}
        {loadingExperience && items.length > 0 && <div class="rb-empty">Loading game passes and developer products…</div>}
      </main>

      <footer class="rb-footer">
        {progress && (
          <div class={`rb-progress ${progress.failed ? "has-failures" : ""}`}>
            <div class="rb-progress-bar">
              <div style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
            <span>
              {progress.running
                ? `Saving ${progress.done} of ${progress.total}…`
                : progress.failed
                  ? `Saved ${progress.done - progress.failed} of ${progress.total}. ${progress.failed} failed: they're still marked, so you can fix them or save again to retry.`
                  : `Saved ${progress.done} of ${progress.total}. You can undo this from the History tab.`}
            </span>
          </div>
        )}

        <div class="rb-actions">
          <span class="rb-selection">{selected.size} selected</span>
          <div class="rb-price-field">
            <span class="rb-robux">R$</span>
            <input
              class="rb-input"
              inputMode="numeric"
              placeholder="Price"
              aria-label="Price for selected items"
              value={bulkPrice}
              onInput={(e) => setBulkPrice(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && bulkPriceOk && selected.size > 0 && bulk({ kind: "setPrice", price: bulkPriceValue })}
            />
          </div>
          <button class="rb-btn" disabled={saving || selected.size === 0 || !bulkPriceOk} onClick={() => bulk({ kind: "setPrice", price: bulkPriceValue })}>
            Set price
          </button>
          <button class="rb-btn" disabled={saving || selected.size === 0} onClick={() => bulk({ kind: "putOnSale" })}>
            Put on sale
          </button>
          <button class="rb-btn" disabled={saving || selected.size === 0} onClick={() => bulk({ kind: "takeOffSale" })}>
            Take off sale
          </button>
          <Menu
            label="More"
            up
            disabled={saving}
            items={[
              { label: "Price rule (% change, rounding)…", onSelect: () => setDialog({ kind: "priceRule" }), disabled: selected.size === 0 },
              {
                label: "Schedule a sale…",
                onSelect: () => setDialog({ kind: "schedule" }),
                disabled: selectedAvatar.length === 0,
                hint: "Avatar items only",
              },
              { label: "Rename…", onSelect: () => setDialog({ kind: "text", field: "name" }), disabled: selected.size === 0 },
              { label: "Edit descriptions…", onSelect: () => setDialog({ kind: "text", field: "description" }), disabled: selected.size === 0 },
              { label: "", onSelect: () => {}, divider: true },
              { label: "Turn regional pricing on", onSelect: () => bulk({ kind: "setRegionalPricing", enabled: true }), disabled: selected.size === 0 },
              { label: "Turn regional pricing off", onSelect: () => bulk({ kind: "setRegionalPricing", enabled: false }), disabled: selected.size === 0 },
              {
                label: "Turn managed pricing on",
                onSelect: () => bulk({ kind: "setManagedPricing", enabled: true }),
                disabled: selectedPassesOrProducts.length === 0,
                hint: "Game passes and developer products only",
              },
              {
                label: "Turn managed pricing off",
                onSelect: () => bulk({ kind: "setManagedPricing", enabled: false }),
                disabled: selectedPassesOrProducts.length === 0,
              },
              { label: "", onSelect: () => {}, divider: true },
              { label: "Take a snapshot now", onSelect: snapshotNow, disabled: items.length === 0 },
            ]}
          />

          <div class="rb-spacer" />

          {saving ? (
            <button class="rb-btn rb-btn-danger" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : (
            <>
              <button class="rb-btn rb-btn-ghost" disabled={edits.size === 0} onClick={() => setWsEdits(new Map())}>
                Discard changes
              </button>
              <button class="rb-btn rb-btn-primary" disabled={saveable.length === 0} onClick={save}>
                {saveable.length === 0 ? "No changes" : `Save ${saveable.length} change${saveable.length === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
        {problems.size > 0 && !saving && (
          <div class="rb-note">
            {problems.size} change{problems.size === 1 ? "" : "s"} can't be saved yet; see the warnings on those rows.
          </div>
        )}
      </footer>

      {toast && <div class="rb-toast">{toast}</div>}

      {dialog?.kind === "priceRule" && <PriceRuleDialog targets={selectedItems} edits={edits} onApply={stagePatches} onClose={() => setDialog(null)} />}
      {dialog?.kind === "schedule" && (
        <ScheduleDialog
          count={selectedAvatar.length}
          skipped={selectedPassesOrProducts.length}
          onApply={(schedule) => bulk({ kind: "schedule", schedule })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "text" && <TextDialog field={dialog.field} targets={selectedItems} edits={edits} onApply={stagePatches} onClose={() => setDialog(null)} />}
      {dialog?.kind === "lua" && <LuaDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "import" && <ImportResultDialog staged={dialog.staged} warnings={dialog.warnings} onClose={() => setDialog(null)} />}
      {dialog?.kind === "stats" && <ItemStatsDialog item={dialog.item} onClose={() => setDialog(null)} />}
    </>
  );
}

interface RowProps {
  item: SellableItem;
  edit: Edit | undefined;
  thumb: string | undefined;
  selected: boolean;
  status: RowStatus | undefined;
  problem: string | undefined;
  disabled: boolean;
  sales: { robux: number; sales: number } | undefined;
  perSale: number | null;
  onToggle: (shiftKey: boolean) => void;
  onPrice: (raw: string) => void;
  onManaged: (enabled: boolean) => void;
  onStats: () => void;
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");

function Row({ item, edit, thumb, selected, status, problem, disabled, sales, perSale, onToggle, onPrice, onManaged, onStats }: RowProps) {
  const eff = effective(item, edit);
  const saleChanged = edit?.onSale !== undefined;
  const priceChanged = edit?.price !== undefined;
  const managedChanged = edit?.managedPricing !== undefined;

  return (
    <div class={`rb-row ${selected ? "is-selected" : ""} ${edit ? "is-edited" : ""}`}>
      <input type="checkbox" class="rb-check" checked={selected} disabled={disabled} onClick={(e) => onToggle(e.shiftKey)} aria-label={`Select ${item.name}`} />
      <div class="rb-thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</div>
      <div class="rb-name">
        <div class="rb-name-line">
          <a href={itemLink(item)} target="_blank" rel="noreferrer" class={edit?.name !== undefined ? "is-old" : ""}>
            {item.name}
          </a>
          {edit?.name !== undefined && <span class="rb-new-name">→ {edit.name}</span>}
        </div>
        <div class="rb-meta">
          {sales && (
            <button class="rb-meta-btn" onClick={onStats} title="Sales for this item">
              {sales.sales.toLocaleString()} sold · {robux(sales.robux)}
            </button>
          )}
          {!sales && (
            <button class="rb-meta-btn" onClick={onStats} title="Sales for this item">
              View sales
            </button>
          )}
          {eff.managedPricing !== undefined && (
            <button
              class={`rb-chip ${eff.managedPricing ? "on" : ""} ${managedChanged ? "is-changed" : ""}`}
              disabled={disabled}
              onClick={() => onManaged(!eff.managedPricing)}
              title="Managed pricing lets Roblox adjust this item's price automatically. Click to toggle."
            >
              Managed pricing: {eff.managedPricing ? "On" : "Off"}
            </button>
          )}
          {edit?.regionalPricing !== undefined && <span class="rb-chip is-changed">Regional pricing → {edit.regionalPricing ? "On" : "Off"}</span>}
          {edit?.description !== undefined && <span class="rb-chip is-changed">Description edited</span>}
          {edit?.schedule && (
            <span class="rb-chip is-changed">
              {edit.schedule.start || edit.schedule.end ? `On sale ${fmtDate(edit.schedule.start)} → ${fmtDate(edit.schedule.end)}` : "Schedule removed"}
            </span>
          )}
        </div>
        {problem && <span class="rb-warning">⚠ {problem}</span>}
        {status?.state === "failed" && <span class="rb-warning">✕ {status.error}</span>}
      </div>
      <div class="rb-sale">
        {saleChanged && <span class={`rb-pill rb-pill-was ${item.onSale ? "on" : "off"}`}>{item.onSale ? "On sale" : "Off sale"}</span>}
        {saleChanged && <span class="rb-arrow">→</span>}
        <span class={`rb-pill ${eff.onSale ? "on" : "off"} ${saleChanged ? "is-changed" : ""}`}>{eff.onSale ? "On sale" : "Off sale"}</span>
      </div>
      <div class="rb-price">
        <div class={`rb-price-field ${priceChanged ? "is-changed" : ""}`}>
          <span class="rb-robux">R$</span>
          <input
            class="rb-input"
            inputMode="numeric"
            key={`${item.key}:${eff.price}`}
            defaultValue={eff.price == null ? "" : String(eff.price)}
            disabled={disabled}
            onChange={(e) => onPrice(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label={`Price for ${item.name}`}
          />
        </div>
        <div class="rb-price-notes">
          {priceChanged && <span class="rb-was">was {item.price ?? "—"}</span>}
          {perSale != null && <span class="rb-was" title="Robux you receive from one marketplace sale at this price. Roblox's share is smaller the further your price is above the minimum. Sales made inside an experience pay the base 30%.">you get {robux(perSale)}</span>}
        </div>
      </div>
      <div class="rb-status" title={status?.error}>
        {status?.state === "saving" && <span class="rb-spinner" />}
        {status?.state === "saved" && <span class="rb-ok">✓</span>}
        {status?.state === "failed" && <span class="rb-fail">!</span>}
      </div>
    </div>
  );
}
