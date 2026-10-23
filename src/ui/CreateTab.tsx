import { useEffect, useState } from "preact/hooks";
import { createExperienceItem, fetchIcon, listDevProducts, listGamePasses } from "../api/experiences";
import { getThumbnails } from "../api/thumbnails";
import type { SellableItem } from "../api/types";
import { runPaced } from "../core/queue";
import { TEMPLATES, buildNumberedSeries, validateDraft, type DraftProduct } from "../core/templates";
import { robux } from "./charts";
import { Field, Segmented } from "./components";
import { useWorkspace } from "./workspace";

type Kind = "gamePass" | "devProduct";
type Mode = "create" | "copy";
type RowResult = { ok: boolean; error?: string };

const KIND_LABEL: Record<Kind, string> = { gamePass: "game pass", devProduct: "developer product" };

export function CreateTab({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const [mode, setMode] = useState<Mode>("create");
  return (
    <>
      <div class="rb-toolbar">
        <Segmented
          label="Create or copy"
          value={mode}
          onChange={setMode}
          options={[
            ["create", "Bulk create"],
            ["copy", "Copy between experiences"],
          ]}
        />
      </div>
      {mode === "create" ? <BulkCreate onBusy={onBusy} /> : <CopyItems onBusy={onBusy} />}
    </>
  );
}

function BulkCreate({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const ws = useWorkspace();
  const [kind, setKind] = useState<Kind>("devProduct");
  const [drafts, setDrafts] = useState<DraftProduct[]>([]);
  const [icon, setIcon] = useState<File | null>(null);
  const [results, setResults] = useState<RowResult[]>([]);
  const [running, setRunning] = useState(false);
  const [series, setSeries] = useState({ nameTemplate: "Crate {n}", description: "", count: "5", startPrice: "50", priceStep: "25" });

  const universeId = ws.universeId;
  const problems = drafts.map(validateDraft);
  const ready = drafts.length > 0 && problems.every((p) => !p) && universeId != null && !running;

  const update = (i: number, patch: Partial<DraftProduct>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const create = async () => {
    if (!ready || universeId == null) return;
    setRunning(true);
    onBusy(true);
    setResults([]);
    const out: RowResult[] = [];
    await runPaced(drafts, (d) => createExperienceItem(ws.client, kind, universeId, d, icon ?? undefined).then(() => {}), {
      intervalMs: 1200,
      onResult: (r) => {
        out.push({ ok: r.ok, error: r.error });
        setResults([...out]);
      },
    });
    setRunning(false);
    onBusy(false);
    ws.reloadExperience();
  };

  if (universeId == null) return <main class="rb-body"><div class="rb-empty">Pick an experience at the top to create game passes or developer products in it.</div></main>;

  const created = results.filter((r) => r.ok).length;

  return (
    <>
      <main class="rb-body rb-pad">
        <div class="rb-form-row">
          <Field label="Create">
            <Segmented
              label="Type"
              value={kind}
              onChange={setKind}
              options={[
                ["devProduct", "Developer products"],
                ["gamePass", "Game passes"],
              ]}
            />
          </Field>
          <Field label="In experience">
            <div class="rb-static">{ws.experience?.name}</div>
          </Field>
        </div>

        <h3 class="rb-subhead">Start from a template</h3>
        <div class="rb-template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.id} class="rb-template" onClick={() => setDrafts([...drafts, ...t.build()])}>
              <strong>{t.label}</strong>
              <span>{t.description}</span>
            </button>
          ))}
        </div>

        <details class="rb-details">
          <summary>Or generate a numbered series</summary>
          <div class="rb-form-row">
            <Field label="Name" hint="{n} becomes 1, 2, 3…; {price} the price">
              <input class="rb-input" value={series.nameTemplate} onInput={(e) => setSeries({ ...series, nameTemplate: e.currentTarget.value })} />
            </Field>
            <Field label="How many">
              <input class="rb-input" inputMode="numeric" value={series.count} onInput={(e) => setSeries({ ...series, count: e.currentTarget.value })} />
            </Field>
            <Field label="First price">
              <input class="rb-input" inputMode="numeric" value={series.startPrice} onInput={(e) => setSeries({ ...series, startPrice: e.currentTarget.value })} />
            </Field>
            <Field label="Price step">
              <input class="rb-input" inputMode="numeric" value={series.priceStep} onInput={(e) => setSeries({ ...series, priceStep: e.currentTarget.value })} />
            </Field>
          </div>
          <button
            class="rb-btn"
            onClick={() =>
              setDrafts([
                ...drafts,
                ...buildNumberedSeries({
                  nameTemplate: series.nameTemplate,
                  description: series.description,
                  count: Number(series.count) || 0,
                  startPrice: Number(series.startPrice) || 0,
                  priceStep: Number(series.priceStep) || 0,
                  onSale: true,
                }),
              ])
            }
          >
            Add series
          </button>
        </details>

        <div class="rb-subhead-row">
          <h3 class="rb-subhead">
            {drafts.length} {KIND_LABEL[kind]}
            {drafts.length === 1 ? "" : "s"} to create
          </h3>
          <button class="rb-link-btn" onClick={() => setDrafts([...drafts, { name: "", description: "", price: 0, onSale: true }])}>
            + Add row
          </button>
          {drafts.length > 0 && (
            <button class="rb-link-btn" disabled={running} onClick={() => (setDrafts([]), setResults([]))}>
              Clear all
            </button>
          )}
        </div>

        {drafts.length > 0 && (
          <table class="rb-table rb-edit-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th class="num">Price</th>
                <th>On sale</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {drafts.map((d, i) => (
                <tr key={i}>
                  <td>
                    <input class="rb-input" value={d.name} disabled={running} onInput={(e) => update(i, { name: e.currentTarget.value })} />
                    {problems[i] && <div class="rb-warning">⚠ {problems[i]}</div>}
                    {results[i] && (results[i].ok ? <div class="rb-ok rb-small">✓ Created</div> : <div class="rb-warning">✕ {results[i].error}</div>)}
                  </td>
                  <td>
                    <input class="rb-input" value={d.description} disabled={running} onInput={(e) => update(i, { description: e.currentTarget.value })} />
                  </td>
                  <td class="num">
                    <input class="rb-input rb-input-narrow" inputMode="numeric" value={String(d.price)} disabled={running} onInput={(e) => update(i, { price: Number(e.currentTarget.value) })} />
                  </td>
                  <td>
                    <input type="checkbox" class="rb-check" checked={d.onSale} disabled={running} onChange={(e) => update(i, { onSale: e.currentTarget.checked })} />
                  </td>
                  <td>
                    <button class="rb-icon-btn" disabled={running} onClick={() => setDrafts(drafts.filter((_, j) => j !== i))} aria-label="Remove row">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Field label="Icon for all of them (optional)" hint="PNG or JPG. You can change individual icons on the dashboard later.">
          <input type="file" accept="image/png,image/jpeg" disabled={running} onChange={(e) => setIcon(e.currentTarget.files?.[0] ?? null)} />
        </Field>
        {kind === "gamePass" && <p class="rb-note">Roblox allows at most 50 game passes on sale per experience; anything over that is created off sale or fails.</p>}
      </main>
      <footer class="rb-footer">
        <div class="rb-actions">
          {results.length > 0 && (
            <span class="rb-muted">
              {running ? `Creating ${results.length} of ${drafts.length}…` : `Created ${created} of ${drafts.length}.`}
            </span>
          )}
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-primary" disabled={!ready} onClick={create}>
            Create {drafts.length || ""} {KIND_LABEL[kind]}
            {drafts.length === 1 ? "" : "s"}
          </button>
        </div>
      </footer>
    </>
  );
}

function CopyItems({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const ws = useWorkspace();
  const [sourceId, setSourceId] = useState<number | null>(ws.universeId);
  const [targetId, setTargetId] = useState<number | null>(ws.experiences.find((x) => x.universeId !== ws.universeId)?.universeId ?? null);
  const [sourceItems, setSourceItems] = useState<SellableItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [copyIcons, setCopyIcons] = useState(true);
  const [offSale, setOffSale] = useState(false);
  const [results, setResults] = useState<Map<string, RowResult>>(new Map());
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (sourceId == null) return;
    setLoading(true);
    setSelected(new Set());
    setResults(new Map());
    Promise.all([listGamePasses(ws.client, sourceId), listDevProducts(ws.client, sourceId)])
      .then(([a, b]) => setSourceItems([...a, ...b]))
      .catch(() => setSourceItems([]))
      .finally(() => setLoading(false));
  }, [sourceId]);

  const toCopy = sourceItems.filter((i) => selected.has(i.key));

  const copy = async () => {
    if (targetId == null || toCopy.length === 0) return;
    setRunning(true);
    onBusy(true);
    const icons = copyIcons ? await getThumbnails(ws.client, toCopy) : new Map<string, string>();
    const out = new Map<string, RowResult>();
    await runPaced(
      toCopy,
      async (item) => {
        const iconUrl = icons.get(item.key);
        const image = iconUrl ? await fetchIcon(iconUrl) : undefined;
        await createExperienceItem(
          ws.client,
          item.kind as Kind,
          targetId,
          { name: item.name, description: item.description ?? "", price: item.price ?? 0, onSale: offSale ? false : item.onSale },
          image,
        );
      },
      {
        intervalMs: 1200,
        onResult: (r) => {
          out.set(r.task.key, { ok: r.ok, error: r.error });
          setResults(new Map(out));
        },
      },
    );
    setRunning(false);
    onBusy(false);
    if (targetId === ws.universeId) ws.reloadExperience();
  };

  if (ws.experiences.length < 2) {
    return <main class="rb-body"><div class="rb-empty">You need at least two experiences to copy between them.</div></main>;
  }

  const experienceOptions = ws.experiences.map((x) => (
    <option key={x.universeId} value={String(x.universeId)}>
      {x.name}
    </option>
  ));

  return (
    <>
      <main class="rb-body rb-pad">
        <div class="rb-form-row">
          <Field label="Copy from">
            <select class="rb-select" value={String(sourceId ?? "")} disabled={running} onChange={(e) => setSourceId(Number(e.currentTarget.value))}>
              {experienceOptions}
            </select>
          </Field>
          <Field label="Copy to">
            <select class="rb-select" value={String(targetId ?? "")} disabled={running} onChange={(e) => setTargetId(Number(e.currentTarget.value))}>
              {experienceOptions}
            </select>
          </Field>
        </div>
        <div class="rb-form-row">
          <label class="rb-checkbox">
            <input type="checkbox" checked={copyIcons} onChange={(e) => setCopyIcons(e.currentTarget.checked)} /> Copy icons
          </label>
          <label class="rb-checkbox">
            <input type="checkbox" checked={offSale} onChange={(e) => setOffSale(e.currentTarget.checked)} /> Create copies off sale
          </label>
        </div>
        {sourceId === targetId && <p class="rb-note">Pick two different experiences.</p>}
        {loading && <div class="rb-empty">Loading…</div>}
        {!loading && sourceItems.length === 0 && <div class="rb-empty">This experience has no game passes or developer products.</div>}
        {!loading && sourceItems.length > 0 && (
          <table class="rb-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    class="rb-check"
                    checked={selected.size === sourceItems.length}
                    onChange={(e) => setSelected(e.currentTarget.checked ? new Set(sourceItems.map((i) => i.key)) : new Set())}
                    aria-label="Select all"
                  />
                </th>
                <th>Name</th>
                <th>Type</th>
                <th class="num">Price</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sourceItems.map((item) => {
                const r = results.get(item.key);
                return (
                  <tr key={item.key}>
                    <td>
                      <input
                        type="checkbox"
                        class="rb-check"
                        checked={selected.has(item.key)}
                        disabled={running}
                        onChange={() => {
                          const next = new Set(selected);
                          next.has(item.key) ? next.delete(item.key) : next.add(item.key);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>{item.name}</td>
                    <td>{item.kind === "gamePass" ? "Game pass" : "Developer product"}</td>
                    <td class="num">{item.price == null ? "—" : robux(item.price)}</td>
                    <td>{r ? r.ok ? <span class="rb-ok">✓ Copied</span> : <span class="rb-warning">✕ {r.error}</span> : item.onSale ? "On sale" : "Off sale"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </main>
      <footer class="rb-footer">
        <div class="rb-actions">
          <span class="rb-muted">{toCopy.length} selected</span>
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-primary" disabled={running || toCopy.length === 0 || targetId == null || sourceId === targetId} onClick={copy}>
            {running ? "Copying…" : `Copy ${toCopy.length} to ${ws.experiences.find((x) => x.universeId === targetId)?.name ?? "…"}`}
          </button>
        </div>
      </footer>
    </>
  );
}
