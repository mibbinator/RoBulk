import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { listCreators } from "../api/account";
import { listCreatorItems } from "../api/catalog";
import { updateSale } from "../api/collectibles";
import { createClient } from "../api/http";
import { getAssetThumbnails } from "../api/thumbnails";
import type { AvatarItem, Creator } from "../api/types";
import { CATEGORIES, categoryForAssetType, type CategoryId } from "../core/categories";
import { applyAction, effective, pendingChanges, setEdit, type BulkAction, type Edit, type PendingChange } from "../core/edits";
import { runPaced } from "../core/queue";

const client = createClient();

type SaleFilter = "all" | "onSale" | "offSale";
type RowStatus = { state: "saving" | "saved" | "failed"; error?: string };

interface SaveProgress {
  done: number;
  total: number;
  failed: number;
  running: boolean;
}

const creatorKey = (c: Creator) => `${c.type}:${c.id}`;

function initialCreator(creators: Creator[]): Creator {
  const groupId = Number(new URLSearchParams(location.search).get("groupId"));
  return creators.find((c) => c.type === "Group" && c.id === groupId) ?? creators[0];
}

export function Panel({ onClose }: { onClose: () => void }) {
  const [creators, setCreators] = useState<Creator[] | null>(null);
  const [creator, setCreator] = useState<Creator | null>(null);
  const [items, setItems] = useState<AvatarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Map<number, string>>(new Map());

  const [edits, setEdits] = useState<Map<number, Edit>>(new Map());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rowStatus, setRowStatus] = useState<Map<number, RowStatus>>(new Map());
  const [filter, setFilter] = useState<SaleFilter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<CategoryId>>(new Set());
  const [bulkPrice, setBulkPrice] = useState("");
  const [progress, setProgress] = useState<SaveProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastClicked = useRef<number | null>(null);

  // Who can we manage items for?
  useEffect(() => {
    listCreators(client)
      .then((list) => {
        setCreators(list);
        setCreator(initialCreator(list));
      })
      .catch((e) => {
        setError(`Couldn't load your account: ${e.message}. Make sure you're logged in to Roblox.`);
        setLoading(false);
      });
  }, []);

  // Load that creator's items.
  const loadItems = async (c: Creator) => {
    setLoading(true);
    setError(null);
    setItems([]);
    setEdits(new Map());
    setSelected(new Set());
    setRowStatus(new Map());
    setProgress(null);
    try {
      const list = await listCreatorItems(client, c);
      setItems(list);
      getAssetThumbnails(client, list.map((i) => i.assetId)).then(setThumbs).catch(() => {});
    } catch (e) {
      setError(`Couldn't load items: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (creator) loadItems(creator);
  }, [creator]);

  const saving = progress?.running ?? false;

  const requestClose = () => {
    if (saving) return;
    if (edits.size > 0 && !confirm("Close RoBulk? Your unsaved changes will be lost.")) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Visible items, grouped by category.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (q && !item.name.toLowerCase().includes(q)) return false;
      const { onSale } = effective(item, edits.get(item.assetId));
      return filter === "all" || (filter === "onSale" ? onSale : !onSale);
    });
  }, [items, edits, filter, query]);

  const groups = useMemo(
    () =>
      CATEGORIES.map((cat) => ({
        ...cat,
        items: visible.filter((i) => categoryForAssetType(i.assetType) === cat.id),
      })).filter((g) => g.items.length > 0),
    [visible],
  );

  const flatVisible = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.assetId)), [items, selected]);
  const changes = useMemo(() => pendingChanges(items, edits), [items, edits]);
  const problems = useMemo(() => new Map(changes.filter((c) => c.problem).map((c) => [c.item.assetId, c.problem!])), [changes]);
  const saveable = changes.filter((c) => !c.problem);

  // Selection
  const toggleRow = (item: AvatarItem, shiftKey: boolean) => {
    const next = new Set(selected);
    const turnOn = !selected.has(item.assetId);
    const idx = flatVisible.findIndex((i) => i.assetId === item.assetId);
    const anchor = flatVisible.findIndex((i) => i.assetId === lastClicked.current);
    const range = shiftKey && anchor >= 0 ? flatVisible.slice(Math.min(anchor, idx), Math.max(anchor, idx) + 1) : [item];
    for (const i of range) turnOn ? next.add(i.assetId) : next.delete(i.assetId);
    lastClicked.current = item.assetId;
    setSelected(next);
  };

  const setMany = (list: AvatarItem[], on: boolean) => {
    const next = new Set(selected);
    for (const i of list) on ? next.add(i.assetId) : next.delete(i.assetId);
    setSelected(next);
  };

  // Edits
  const bulk = (action: BulkAction) => setEdits(applyAction(edits, selectedItems, action));
  const bulkPriceValue = Number(bulkPrice);
  const bulkPriceOk = bulkPrice.trim() !== "" && Number.isInteger(bulkPriceValue) && bulkPriceValue >= 0;

  const editPrice = (item: AvatarItem, raw: string) => {
    const trimmed = raw.trim();
    setEdits(setEdit(edits, item, { price: trimmed === "" ? (item.price ?? undefined) : Number(trimmed) }));
  };

  // Saving
  const save = async () => {
    if (saveable.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ done: 0, total: saveable.length, failed: 0, running: true });
    setRowStatus((prev) => {
      const next = new Map(prev);
      for (const c of saveable) next.set(c.item.assetId, { state: "saving" });
      return next;
    });

    let failed = 0;
    await runPaced<PendingChange>(saveable, (c) => updateSale(client, c.item.collectibleItemId!, c.settings), {
      signal: controller.signal,
      onResult: (r, done, total) => {
        const id = r.task.item.assetId;
        if (r.ok) {
          // Roblox accepted it: treat the new values as the item's real state.
          setItems((prev) => prev.map((i) => (i.assetId === id ? { ...i, ...r.task.settings } : i)));
          setEdits((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        } else failed++;
        setRowStatus((prev) => new Map(prev).set(id, r.ok ? { state: "saved" } : { state: "failed", error: r.error }));
        setProgress({ done, total, failed, running: done < total });
      },
    });

    setProgress((p) => (p ? { ...p, running: false } : p));
    setRowStatus((prev) => {
      // Rows that never ran because the user stopped the save.
      const next = new Map(prev);
      for (const [id, s] of next) if (s.state === "saving") next.delete(id);
      return next;
    });
    abortRef.current = null;
  };

  return (
    <div class="rb-overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div class="rb-panel" role="dialog" aria-label="RoBulk bulk editor">
        <header class="rb-header">
          <div class="rb-title">
            <span class="rb-brand">RoBulk</span>
            <span class="rb-subtitle">Bulk sale &amp; pricing</span>
          </div>
          <div class="rb-header-controls">
            <select
              class="rb-select"
              value={creator ? creatorKey(creator) : ""}
              disabled={!creators || saving}
              onChange={(e) => {
                const next = creators?.find((c) => creatorKey(c) === e.currentTarget.value);
                if (!next) return;
                if (edits.size > 0 && !confirm("Switch creator? Your unsaved changes will be lost.")) {
                  e.currentTarget.value = creator ? creatorKey(creator) : "";
                  return;
                }
                setCreator(next);
              }}
            >
              {creators?.map((c) => (
                <option key={creatorKey(c)} value={creatorKey(c)}>
                  {c.type === "Group" ? `Group: ${c.name}` : `Me: ${c.name}`}
                </option>
              ))}
            </select>
            <button class="rb-icon-btn" title="Close (Esc)" onClick={requestClose} disabled={saving}>
              ✕
            </button>
          </div>
        </header>

        <div class="rb-toolbar">
          <input
            class="rb-input rb-search"
            type="search"
            placeholder="Search items"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <div class="rb-segmented" role="group" aria-label="Filter by sale status">
            {(
              [
                ["all", "All"],
                ["onSale", "On sale"],
                ["offSale", "Off sale"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} class={filter === value ? "is-active" : ""} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-ghost" disabled={flatVisible.length === 0} onClick={() => setMany(flatVisible, true)}>
            Select all
          </button>
          <button class="rb-btn rb-btn-ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          <button class="rb-btn rb-btn-ghost" disabled={!creator || loading || saving} onClick={() => creator && loadItems(creator)}>
            Refresh
          </button>
        </div>

        <main class="rb-body">
          {loading && <div class="rb-empty">Loading items…</div>}
          {!loading && error && <div class="rb-empty rb-error">{error}</div>}
          {!loading && !error && items.length === 0 && <div class="rb-empty">No avatar items found for this creator.</div>}
          {!loading && !error && items.length > 0 && groups.length === 0 && (
            <div class="rb-empty">No items match your search or filter.</div>
          )}

          {groups.map((group) => {
            const selectedCount = group.items.filter((i) => selected.has(i.assetId)).length;
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
                      key={item.assetId}
                      item={item}
                      edit={edits.get(item.assetId)}
                      thumb={thumbs.get(item.assetId)}
                      selected={selected.has(item.assetId)}
                      status={rowStatus.get(item.assetId)}
                      problem={problems.get(item.assetId)}
                      disabled={saving}
                      onToggle={(shift) => toggleRow(item, shift)}
                      onPrice={(raw) => editPrice(item, raw)}
                    />
                  ))}
              </section>
            );
          })}
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
                    : `Saved ${progress.done} of ${progress.total}.`}
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
                value={bulkPrice}
                onInput={(e) => setBulkPrice(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && bulkPriceOk && selected.size > 0 && bulk({ kind: "setPrice", price: bulkPriceValue })}
              />
            </div>
            <button
              class="rb-btn"
              disabled={saving || selected.size === 0 || !bulkPriceOk}
              onClick={() => bulk({ kind: "setPrice", price: bulkPriceValue })}
            >
              Set price
            </button>
            <button class="rb-btn" disabled={saving || selected.size === 0} onClick={() => bulk({ kind: "putOnSale" })}>
              Put on sale
            </button>
            <button class="rb-btn" disabled={saving || selected.size === 0} onClick={() => bulk({ kind: "takeOffSale" })}>
              Take off sale
            </button>

            <div class="rb-spacer" />

            {saving ? (
              <button class="rb-btn rb-btn-danger" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <>
                <button class="rb-btn rb-btn-ghost" disabled={edits.size === 0} onClick={() => setEdits(new Map())}>
                  Discard changes
                </button>
                <button class="rb-btn rb-btn-primary" disabled={saveable.length === 0} onClick={save}>
                  {saveable.length === 0 ? "No changes" : `Save ${saveable.length} change${saveable.length === 1 ? "" : "s"}`}
                </button>
              </>
            )}
          </div>
          {problems.size > 0 && !saving && (
            <div class="rb-note">{problems.size} change{problems.size === 1 ? "" : "s"} can't be saved yet; see the warnings on those rows.</div>
          )}
        </footer>
      </div>
    </div>
  );
}

interface RowProps {
  item: AvatarItem;
  edit: Edit | undefined;
  thumb: string | undefined;
  selected: boolean;
  status: RowStatus | undefined;
  problem: string | undefined;
  disabled: boolean;
  onToggle: (shiftKey: boolean) => void;
  onPrice: (raw: string) => void;
}

function Row({ item, edit, thumb, selected, status, problem, disabled, onToggle, onPrice }: RowProps) {
  const { price, onSale } = effective(item, edit);
  const saleChanged = edit?.onSale !== undefined;
  const priceChanged = edit?.price !== undefined;

  return (
    <div class={`rb-row ${selected ? "is-selected" : ""} ${edit ? "is-edited" : ""}`}>
      <input
        type="checkbox"
        class="rb-check"
        checked={selected}
        disabled={disabled}
        onClick={(e) => onToggle(e.shiftKey)}
        aria-label={`Select ${item.name}`}
      />
      <div class="rb-thumb">{thumb && <img src={thumb} alt="" loading="lazy" />}</div>
      <div class="rb-name">
        <a href={`https://www.roblox.com/catalog/${item.assetId}`} target="_blank" rel="noreferrer">
          {item.name}
        </a>
        {problem && <span class="rb-warning">⚠ {problem}</span>}
        {status?.state === "failed" && <span class="rb-warning">✕ {status.error}</span>}
      </div>
      <div class="rb-sale">
        {saleChanged && <span class={`rb-pill rb-pill-was ${item.onSale ? "on" : "off"}`}>{item.onSale ? "On sale" : "Off sale"}</span>}
        {saleChanged && <span class="rb-arrow">→</span>}
        <span class={`rb-pill ${onSale ? "on" : "off"} ${saleChanged ? "is-changed" : ""}`}>{onSale ? "On sale" : "Off sale"}</span>
      </div>
      <div class="rb-price">
        <div class={`rb-price-field ${priceChanged ? "is-changed" : ""}`}>
          <span class="rb-robux">R$</span>
          <input
            class="rb-input"
            inputMode="numeric"
            key={`${item.assetId}:${price}`}
            defaultValue={price == null ? "" : String(price)}
            disabled={disabled}
            onChange={(e) => onPrice(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            aria-label={`Price for ${item.name}`}
          />
        </div>
        {priceChanged && <span class="rb-was">was {item.price ?? "—"}</span>}
      </div>
      <div class="rb-status" title={status?.error}>
        {status?.state === "saving" && <span class="rb-spinner" />}
        {status?.state === "saved" && <span class="rb-ok">✓</span>}
        {status?.state === "failed" && <span class="rb-fail">!</span>}
      </div>
    </div>
  );
}
