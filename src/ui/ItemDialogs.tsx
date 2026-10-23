import { useEffect, useMemo, useState } from "preact/hooks";
import type { SellableItem } from "../api/types";
import { CATEGORIES, categoryFor } from "../core/categories";
import { effective, type Edit, type Edits, type SaleSchedule } from "../core/edits";
import { toLuaModule } from "../core/luaExport";
import { lastPriceChange, priceImpact, type PriceChange } from "../core/priceImpact";
import { cacheCovers } from "../core/salesCache";
import { applyPriceRule, type PriceOperation, type Rounding } from "../core/priceRules";
import { DESCRIPTION_LIMIT, NAME_LIMIT, applyTextOperation, type TextOperation } from "../core/textRules";
import { BarChart, StatTile, robux } from "./charts";
import { Dialog, Field, Segmented, copyText, downloadText, fileSafe } from "./components";
import { creatorKey, rangeLabel, useWorkspace } from "./workspace";

type Patches = { item: SellableItem; patch: Edit }[];

const PREVIEW_ROWS = 6;

function Preview({ rows }: { rows: { name: string; before: string; after: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <div class="rb-preview">
      <div class="rb-preview-title">Preview</div>
      <table class="rb-table">
        <tbody>
          {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
            <tr key={i}>
              <td class="rb-preview-name">{r.name}</td>
              <td class="rb-muted">{r.before}</td>
              <td>→</td>
              <td>
                <strong>{r.after}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > PREVIEW_ROWS && <div class="rb-muted rb-small">…and {rows.length - PREVIEW_ROWS} more</div>}
    </div>
  );
}

const OPERATIONS: readonly (readonly [PriceOperation["kind"], string])[] = [
  ["set", "Set to"],
  ["increasePercent", "Raise by %"],
  ["decreasePercent", "Lower by %"],
  ["increaseBy", "Raise by R$"],
  ["decreaseBy", "Lower by R$"],
];

const ROUNDINGS: readonly (readonly [Rounding, string])[] = [
  ["none", "Whole Robux"],
  ["end9", "Ends in 9 (49, 99)"],
  ["end99", "Ends in 99 (199, 299)"],
  ["multiple5", "Multiple of 5"],
  ["multiple10", "Multiple of 10"],
];

export function PriceRuleDialog({ targets, edits, onApply, onClose }: { targets: SellableItem[]; edits: Edits; onApply: (p: Patches) => void; onClose: () => void }) {
  const [kind, setKind] = useState<PriceOperation["kind"]>("increasePercent");
  const [value, setValue] = useState("10");
  const [rounding, setRounding] = useState<Rounding>("none");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");

  const num = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(num) && num >= 0;
  const results = useMemo(() => {
    if (!valid) return [];
    const rule = { operation: { kind, value: num } as PriceOperation, rounding, min: min ? Number(min) : undefined, max: max ? Number(max) : undefined };
    return targets.map((item) => {
      const current = effective(item, edits.get(item.key)).price;
      return { item, current, next: applyPriceRule(current, rule) };
    });
  }, [targets, edits, kind, num, rounding, min, max, valid]);
  const changes = results.filter((r) => r.next != null && r.next !== r.current);
  const skipped = results.filter((r) => r.next == null).length;

  return (
    <Dialog
      title={`Price rule for ${targets.length} item${targets.length === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <>
          <button class="rb-btn rb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            class="rb-btn rb-btn-primary"
            disabled={changes.length === 0}
            onClick={() => {
              onApply(changes.map((r) => ({ item: r.item, patch: { price: r.next! } })));
              onClose();
            }}
          >
            Stage {changes.length} price change{changes.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <div class="rb-form-row">
        <Field label="Change">
          <select class="rb-select" value={kind} onChange={(e) => setKind(e.currentTarget.value as PriceOperation["kind"])}>
            {OPERATIONS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label={kind.endsWith("Percent") ? "Percent" : "Robux"}>
          <input class="rb-input" inputMode="decimal" value={value} onInput={(e) => setValue(e.currentTarget.value)} />
        </Field>
      </div>
      <Field label="Round to">
        <select class="rb-select" value={rounding} onChange={(e) => setRounding(e.currentTarget.value as Rounding)}>
          {ROUNDINGS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <div class="rb-form-row">
        <Field label="Never below (optional)">
          <input class="rb-input" inputMode="numeric" placeholder="e.g. 5" value={min} onInput={(e) => setMin(e.currentTarget.value)} />
        </Field>
        <Field label="Never above (optional)">
          <input class="rb-input" inputMode="numeric" value={max} onInput={(e) => setMax(e.currentTarget.value)} />
        </Field>
      </div>
      {skipped > 0 && <p class="rb-note">{skipped} item{skipped === 1 ? " has" : "s have"} no price yet and will be skipped.</p>}
      <Preview rows={changes.map((r) => ({ name: r.item.name, before: r.current == null ? "—" : robux(r.current), after: robux(r.next!) }))} />
    </Dialog>
  );
}

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function ScheduleDialog({ count, skipped, onApply, onClose }: { count: number; skipped: number; onApply: (s: SaleSchedule) => void; onClose: () => void }) {
  const [start, setStart] = useState(toLocalInput(new Date(Date.now() + 3600000).toISOString()));
  const [end, setEnd] = useState("");
  const startIso = start ? new Date(start).toISOString() : null;
  const endIso = end ? new Date(end).toISOString() : null;
  const invalid = (!startIso && !endIso) || (startIso && endIso && endIso <= startIso);

  return (
    <Dialog
      title={`Schedule a sale for ${count} item${count === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <>
          <button
            class="rb-btn rb-btn-ghost"
            onClick={() => {
              onApply({ start: null, end: null });
              onClose();
            }}
          >
            Remove existing schedule
          </button>
          <div class="rb-spacer" />
          <button
            class="rb-btn rb-btn-primary"
            disabled={!!invalid}
            onClick={() => {
              onApply({ start: startIso, end: endIso });
              onClose();
            }}
          >
            Stage schedule
          </button>
        </>
      }
    >
      <p class="rb-muted">Roblox puts the items on sale and takes them off at these times, even when your computer is off. Times are in your local time zone.</p>
      <div class="rb-form-row">
        <Field label="Goes on sale">
          <input class="rb-input" type="datetime-local" value={start} onInput={(e) => setStart(e.currentTarget.value)} />
        </Field>
        <Field label="Goes off sale (optional)">
          <input class="rb-input" type="datetime-local" value={end} onInput={(e) => setEnd(e.currentTarget.value)} />
        </Field>
      </div>
      {startIso && endIso && endIso <= startIso && <p class="rb-note">The end has to be after the start.</p>}
      {skipped > 0 && (
        <p class="rb-note">
          {skipped} selected game pass{skipped === 1 ? "" : "es"}/product{skipped === 1 ? "" : "s"} will be skipped: Roblox only supports scheduled sales for avatar items.
        </p>
      )}
    </Dialog>
  );
}

type TextMode = TextOperation["kind"];

export function TextDialog({
  field,
  targets,
  edits,
  onApply,
  onClose,
}: {
  field: "name" | "description";
  targets: SellableItem[];
  edits: Edits;
  onApply: (p: Patches) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<TextMode>(field === "name" ? "prefix" : "template");
  const [text, setText] = useState(field === "name" ? "" : "{current}");
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const limit = field === "name" ? NAME_LIMIT : DESCRIPTION_LIMIT;

  const op: TextOperation =
    mode === "replace" ? { kind: "replace", find, replaceWith } : mode === "template" ? { kind: "template", template: text } : { kind: mode, text };

  const results = targets.map((item, index) => {
    const eff = effective(item, edits.get(item.key));
    const current = field === "name" ? eff.name : eff.description;
    const next = applyTextOperation(op, { current, name: eff.name, index, price: eff.price, id: item.id });
    return { item, current, next };
  });
  const changes = results.filter((r) => r.next !== r.current);
  const tooLong = changes.filter((r) => r.next.length > limit);
  const empty = changes.filter((r) => field === "name" && !r.next.trim());

  return (
    <Dialog
      title={field === "name" ? `Rename ${targets.length} item${targets.length === 1 ? "" : "s"}` : `Edit descriptions of ${targets.length} item${targets.length === 1 ? "" : "s"}`}
      width={560}
      onClose={onClose}
      footer={
        <>
          <button class="rb-btn rb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            class="rb-btn rb-btn-primary"
            disabled={changes.length === 0 || tooLong.length > 0 || empty.length > 0}
            onClick={() => {
              onApply(changes.map((r) => ({ item: r.item, patch: { [field]: r.next } })));
              onClose();
            }}
          >
            Stage {changes.length} change{changes.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <Segmented
        label="How to change"
        value={mode}
        onChange={setMode}
        options={[
          ["prefix", "Add prefix"],
          ["suffix", "Add suffix"],
          ["replace", "Find & replace"],
          ["template", "Template"],
        ]}
      />
      {mode === "replace" ? (
        <div class="rb-form-row">
          <Field label="Find">
            <input class="rb-input" value={find} onInput={(e) => setFind(e.currentTarget.value)} />
          </Field>
          <Field label="Replace with">
            <input class="rb-input" value={replaceWith} onInput={(e) => setReplaceWith(e.currentTarget.value)} />
          </Field>
        </div>
      ) : field === "description" && mode === "template" ? (
        <Field label="Description template" hint="{current} keeps the existing text. Also: {name}, {n}, {price}, {id}">
          <textarea class="rb-input rb-textarea" rows={5} value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </Field>
      ) : (
        <Field
          label={mode === "template" ? "Name template" : mode === "prefix" ? "Prefix" : "Suffix"}
          hint={mode === "template" ? "{name} is the current name, {n} counts 1, 2, 3…, {price} and {id} also work" : undefined}
        >
          <input class="rb-input" value={text} placeholder={mode === "prefix" ? "[Brand] " : mode === "suffix" ? " [+]" : "{name}"} onInput={(e) => setText(e.currentTarget.value)} />
        </Field>
      )}
      {tooLong.length > 0 && <p class="rb-note">{tooLong.length} result{tooLong.length === 1 ? " is" : "s are"} longer than Roblox's {limit}-character limit.</p>}
      {empty.length > 0 && <p class="rb-note">Names can't be empty.</p>}
      <Preview rows={changes.map((r) => ({ name: field === "name" ? "" : r.item.name, before: r.current.slice(0, 60), after: r.next.slice(0, 60) }))} />
    </Dialog>
  );
}

export function LuaDialog({ onClose }: { onClose: () => void }) {
  const { experienceItems, experience } = useWorkspace();
  const [includePrices, setIncludePrices] = useState(false);
  const [copied, setCopied] = useState(false);
  const name = experience?.name ?? "Experience";
  const lua = toLuaModule(experienceItems, { experienceName: name, includePrices });

  return (
    <Dialog
      title="Export ids as Lua"
      width={620}
      onClose={onClose}
      footer={
        <>
          <label class="rb-checkbox">
            <input type="checkbox" checked={includePrices} onChange={(e) => setIncludePrices(e.currentTarget.checked)} /> Include prices
          </label>
          <div class="rb-spacer" />
          <button class="rb-btn" onClick={() => downloadText(`${fileSafe(name)}-ids.lua`, lua)}>
            Download .lua
          </button>
          <button
            class="rb-btn rb-btn-primary"
            onClick={async () => {
              setCopied(await copyText(lua));
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied" : "Copy to clipboard"}
          </button>
        </>
      }
    >
      <p class="rb-muted">Paste this into a ModuleScript (for example ReplicatedStorage.MonetizationIds) and use it from your scripts.</p>
      <pre class="rb-code">{lua}</pre>
    </Dialog>
  );
}

export function ImportResultDialog({ staged, warnings, onClose }: { staged: number; warnings: string[]; onClose: () => void }) {
  return (
    <Dialog
      title="Spreadsheet imported"
      onClose={onClose}
      footer={
        <button class="rb-btn rb-btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <p>
        {staged === 0 ? "No changes found." : `Staged changes for ${staged} item${staged === 1 ? "" : "s"}.`} Nothing is saved to Roblox until you click Save.
      </p>
      {warnings.length > 0 && (
        <ul class="rb-warning-list">
          {warnings.slice(0, 20).map((w, i) => (
            <li key={i}>{w}</li>
          ))}
          {warnings.length > 20 && <li>…and {warnings.length - 20} more</li>}
        </ul>
      )}
    </Dialog>
  );
}

const longDate = (d: Date) => d.toLocaleDateString(undefined, { dateStyle: "medium" });
const percentChange = (before: number, after: number) => (before === 0 ? null : (after - before) / before);

/** Experimental: how the item sold before and after its last price change. */
function PriceImpactSection({ item }: { item: SellableItem }) {
  const { history, creator, salesEntry, loadSalesSince } = useWorkspace();
  const [change, setChange] = useState<PriceChange | null | undefined>(undefined);

  useEffect(() => {
    if (!creator) return;
    // Passes and products are snapshotted per experience.
    const key = item.kind === "avatar" ? creatorKey(creator) : `${creatorKey(creator)}:universe:${item.universeId}`;
    Promise.all([history.snapshots(key), history.log()]).then(([snapshots, log]) => setChange(lastPriceChange(item.key, snapshots, log)));
  }, [item.key]);

  const now = useMemo(() => new Date(), [salesEntry]);
  const impact = change && salesEntry ? priceImpact(item.key, change, salesEntry.sales, now) : null;
  const covered = !impact || (salesEntry ? cacheCovers(salesEntry, impact.needsSalesSince) : false);
  useEffect(() => {
    if (impact && !covered) loadSalesSince(impact.needsSalesSince);
  }, [impact?.needsSalesSince.getTime(), covered]);

  if (change === undefined) return null;
  return (
    <section class="rb-impact">
      <h3 class="rb-subhead">
        Price vs. sales <span class="rb-chip">Experimental</span>
      </h3>
      {change === null && <p class="rb-muted rb-small">No price change RoBulk knows of yet. It learns prices from its daily snapshots and from the changes you save.</p>}
      {change && (
        <p class="rb-small">
          The price went from {robux(change.from)} to {robux(change.to)} {change.approximate ? "around" : "on"} {longDate(change.at)}
          {change.approximate ? " (changed outside RoBulk, so the day is approximate)" : ""}.
        </p>
      )}
      {change && !impact && <p class="rb-muted rb-small">That's too recent to compare yet. Check back in a day or so.</p>}
      {impact && !covered && <p class="rb-muted rb-small">Loading sales back to {longDate(impact.needsSalesSince)} to compare…</p>}
      {impact && covered && (
        <>
          <p class="rb-muted rb-small">
            The {Math.round(impact.after.days)} days after, compared with the {Math.round(impact.before.days)} days before:
          </p>
          <div class="rb-stats-row">
            <StatTile
              label="Sales a day"
              value={`${impact.before.salesPerDay.toFixed(1)} → ${impact.after.salesPerDay.toFixed(1)}`}
              delta={percentChange(impact.before.salesPerDay, impact.after.salesPerDay)}
            />
            <StatTile
              label="Earned a day"
              value={`${robux(impact.before.robuxPerDay)} → ${robux(impact.after.robuxPerDay)}`}
              delta={percentChange(impact.before.robuxPerDay, impact.after.robuxPerDay)}
            />
          </div>
          <p class="rb-muted rb-small">Other things change sales too (seasons, events, trends), so treat this as a hint rather than proof.</p>
        </>
      )}
    </section>
  );
}

export function ItemStatsDialog({ item, onClose }: { item: SellableItem; onClose: () => void }) {
  const { sales, loadSales, earningsPerSale, thumbs, settings } = useWorkspace();
  useEffect(() => {
    if (!sales.loadedAt && !sales.loading) loadSales(sales.range);
  }, []);
  const stats = sales.current?.perItem.get(item.key);
  const prev = sales.previous?.perItem.get(item.key);
  const perSale = earningsPerSale(item, item.price);
  const category = CATEGORIES.find((c) => c.id === categoryFor(item))?.label;

  return (
    <Dialog title={item.name} width={640} onClose={onClose}>
      <div class="rb-item-head">
        <div class="rb-thumb rb-thumb-lg">{thumbs.get(item.key) && <img src={thumbs.get(item.key)} alt="" />}</div>
        <div>
          <div class="rb-muted">{category}</div>
          <div>
            {item.price == null ? "No price" : robux(item.price)} · {item.onSale ? "On sale" : "Off sale"}
          </div>
          {perSale != null && <div class="rb-muted">You get about {robux(perSale)} per sale</div>}
        </div>
      </div>
      {sales.error && <p class="rb-note">{sales.error}</p>}
      {sales.loading && <p class="rb-muted">{sales.progress}</p>}
      {sales.current && (
        <>
          <div class="rb-stats-row">
            <StatTile label={`Earned, ${rangeLabel(sales.range)}`} value={robux(stats?.robux ?? 0)} delta={prev ? (prev.robux ? ((stats?.robux ?? 0) - prev.robux) / prev.robux : null) : undefined} />
            <StatTile label="Sales" value={(stats?.sales ?? 0).toLocaleString()} />
          </div>
          <h3 class="rb-subhead">{sales.current.bucket === "week" ? "Weekly earnings" : "Daily earnings"}</h3>
          <BarChart
            labels={(stats?.daily ?? sales.current.daily).map((d) => (sales.current!.bucket === "week" ? d.date : d.date.slice(5)))}
            values={(stats?.daily ?? sales.current.daily).map((d) => (stats ? d.robux : 0))}
            height={180}
          />
        </>
      )}
      {settings.priceImpact && <PriceImpactSection item={item} />}
    </Dialog>
  );
}
