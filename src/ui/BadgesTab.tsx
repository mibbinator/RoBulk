import { useEffect, useMemo, useState } from "preact/hooks";
import { listBadges, updateBadge, type Badge, type BadgeChanges } from "../api/badges";
import { getBadgeIcons } from "../api/thumbnails";
import { runPaced } from "../core/queue";
import { NAME_LIMIT, applyTextOperation, type TextOperation } from "../core/textRules";
import { BarChart, ChartCard, compact } from "./charts";
import { Dialog, Field, Segmented } from "./components";
import { useWorkspace } from "./workspace";

type RowResult = { ok: boolean; error?: string };

export function BadgesTab({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const ws = useWorkspace();
  const [badges, setBadges] = useState<Badge[]>([]);
  const [icons, setIcons] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Map<number, BadgeChanges>>(new Map());
  const [results, setResults] = useState<Map<number, RowResult>>(new Map());
  const [running, setRunning] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const load = async () => {
    if (ws.universeId == null) return;
    setLoading(true);
    setError(null);
    setEdits(new Map());
    setSelected(new Set());
    setResults(new Map());
    try {
      const list = await listBadges(ws.client, ws.universeId);
      setBadges(list);
      getBadgeIcons(ws.client, list.map((b) => b.id)).then(setIcons);
    } catch (e) {
      setError(`Couldn't load badges: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [ws.universeId]);

  const effective = (b: Badge) => ({ ...b, ...edits.get(b.id) });

  const stage = (ids: Iterable<number>, patch: (b: Badge) => BadgeChanges) => {
    const next = new Map(edits);
    for (const id of ids) {
      const badge = badges.find((b) => b.id === id)!;
      const merged = { ...next.get(id), ...patch(effective(badge)) };
      // Drop fields that match the badge as loaded.
      (Object.keys(merged) as (keyof BadgeChanges)[]).forEach((k) => merged[k] === badge[k] && delete merged[k]);
      Object.keys(merged).length ? next.set(id, merged) : next.delete(id);
    }
    setEdits(next);
  };

  const save = async () => {
    const queue = [...edits.entries()];
    if (!queue.length) return;
    setRunning(true);
    onBusy(true);
    const out = new Map<number, RowResult>();
    await runPaced(queue, ([id, changes]) => updateBadge(ws.client, id, changes), {
      onResult: (r) => {
        const [id, changes] = r.task;
        out.set(id, { ok: r.ok, error: r.error });
        setResults(new Map(out));
        if (r.ok) {
          setBadges((prev) => prev.map((b) => (b.id === id ? { ...b, ...changes } : b)));
          setEdits((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
          });
        }
      },
    });
    setRunning(false);
    onBusy(false);
  };

  const top = useMemo(() => [...badges].sort((a, b) => b.awardedCount - a.awardedCount).slice(0, 10), [badges]);

  if (ws.universeId == null) return <main class="rb-body"><div class="rb-empty">Pick an experience at the top to manage its badges.</div></main>;

  return (
    <>
      <div class="rb-toolbar">
        <span class="rb-muted">{badges.length} badges in {ws.experience?.name}</span>
        <div class="rb-spacer" />
        <button class="rb-btn rb-btn-ghost" disabled={badges.length === 0} onClick={() => setSelected(new Set(badges.map((b) => b.id)))}>
          Select all
        </button>
        <button class="rb-btn rb-btn-ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
          Clear
        </button>
        <button class="rb-btn rb-btn-ghost" disabled={loading || running} onClick={load}>
          Refresh
        </button>
      </div>

      <main class="rb-body">
        {loading && <div class="rb-empty">Loading badges…</div>}
        {error && <div class="rb-empty rb-error">{error}</div>}
        {!loading && !error && badges.length === 0 && <div class="rb-empty">This experience has no badges yet.</div>}

        {!loading && top.some((b) => b.awardedCount > 0) && (
          <div class="rb-grid rb-grid-tight">
            <ChartCard
              wide
              title="Most awarded badges"
              subtitle="All-time awards"
              table={{ columns: ["Badge", "Awarded", "Win rate", "Yesterday"], rows: top.map((b) => [b.name, b.awardedCount.toLocaleString(), `${b.winRatePercentage.toFixed(1)}%`, b.pastDayAwardedCount]) }}
            >
              <BarChart horizontal labels={top.map((b) => b.name)} values={top.map((b) => b.awardedCount)} format={(n) => `${compact(n)} awarded`} />
            </ChartCard>
          </div>
        )}

        {badges.length > 0 && (
          <section class="rb-group">
            {badges.map((badge) => {
              const eff = effective(badge);
              const edit = edits.get(badge.id);
              const r = results.get(badge.id);
              return (
                <div key={badge.id} class={`rb-row rb-badge-row ${selected.has(badge.id) ? "is-selected" : ""}`}>
                  <input
                    type="checkbox"
                    class="rb-check"
                    checked={selected.has(badge.id)}
                    disabled={running}
                    onChange={() => {
                      const next = new Set(selected);
                      next.has(badge.id) ? next.delete(badge.id) : next.add(badge.id);
                      setSelected(next);
                    }}
                    aria-label={`Select ${badge.name}`}
                  />
                  <div class="rb-thumb rb-thumb-round">{icons.get(badge.id) && <img src={icons.get(badge.id)} alt="" loading="lazy" />}</div>
                  <div class="rb-name">
                    <div class="rb-name-line">
                      <a href={`https://www.roblox.com/badges/${badge.id}`} target="_blank" rel="noreferrer" class={edit?.name !== undefined ? "is-old" : ""}>
                        {badge.name}
                      </a>
                      {edit?.name !== undefined && <span class="rb-new-name">→ {edit.name}</span>}
                    </div>
                    <div class="rb-meta">
                      <span class="rb-muted rb-small">
                        {badge.awardedCount.toLocaleString()} awarded · {badge.winRatePercentage.toFixed(1)}% win rate · {badge.pastDayAwardedCount.toLocaleString()} yesterday
                      </span>
                    </div>
                    {r && !r.ok && <span class="rb-warning">✕ {r.error}</span>}
                  </div>
                  <div class="rb-sale">
                    {edit?.enabled !== undefined && <span class={`rb-pill rb-pill-was ${badge.enabled ? "on" : "off"}`}>{badge.enabled ? "Enabled" : "Disabled"}</span>}
                    {edit?.enabled !== undefined && <span class="rb-arrow">→</span>}
                    <button
                      class={`rb-pill rb-pill-btn ${eff.enabled ? "on" : "off"} ${edit?.enabled !== undefined ? "is-changed" : ""}`}
                      disabled={running}
                      onClick={() => stage([badge.id], (b) => ({ enabled: !b.enabled }))}
                      title="Click to toggle"
                    >
                      {eff.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                  <div class="rb-status">{r?.ok && <span class="rb-ok">✓</span>}</div>
                </div>
              );
            })}
          </section>
        )}
      </main>

      <footer class="rb-footer">
        <div class="rb-actions">
          <span class="rb-selection">{selected.size} selected</span>
          <button class="rb-btn" disabled={running || selected.size === 0} onClick={() => stage(selected, () => ({ enabled: true }))}>
            Enable
          </button>
          <button class="rb-btn" disabled={running || selected.size === 0} onClick={() => stage(selected, () => ({ enabled: false }))}>
            Disable
          </button>
          <button class="rb-btn" disabled={running || selected.size === 0} onClick={() => setRenaming(true)}>
            Rename…
          </button>
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-ghost" disabled={running || edits.size === 0} onClick={() => setEdits(new Map())}>
            Discard changes
          </button>
          <button class="rb-btn rb-btn-primary" disabled={running || edits.size === 0} onClick={save}>
            {running ? "Saving…" : edits.size === 0 ? "No changes" : `Save ${edits.size} change${edits.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </footer>

      {renaming && (
        <BadgeRenameDialog
          badges={badges.filter((b) => selected.has(b.id)).map(effective)}
          onApply={(names) => stage(names.keys(), (b) => ({ name: names.get(b.id)! }))}
          onClose={() => setRenaming(false)}
        />
      )}
    </>
  );
}

function BadgeRenameDialog({ badges, onApply, onClose }: { badges: Badge[]; onApply: (names: Map<number, string>) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"prefix" | "suffix" | "replace" | "template">("prefix");
  const [text, setText] = useState("");
  const [find, setFind] = useState("");
  const [replaceWith, setReplaceWith] = useState("");
  const op: TextOperation = mode === "replace" ? { kind: "replace", find, replaceWith } : mode === "template" ? { kind: "template", template: text } : { kind: mode, text };
  const names = new Map(badges.map((b, index) => [b.id, applyTextOperation(op, { current: b.name, name: b.name, index, price: null, id: b.id })]));
  const changed = badges.filter((b) => names.get(b.id) !== b.name);
  const invalid = changed.some((b) => !names.get(b.id)!.trim() || names.get(b.id)!.length > NAME_LIMIT);

  return (
    <Dialog
      title={`Rename ${badges.length} badge${badges.length === 1 ? "" : "s"}`}
      onClose={onClose}
      footer={
        <>
          <button class="rb-btn rb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            class="rb-btn rb-btn-primary"
            disabled={changed.length === 0 || invalid}
            onClick={() => {
              onApply(new Map(changed.map((b) => [b.id, names.get(b.id)!])));
              onClose();
            }}
          >
            Stage {changed.length} rename{changed.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <Segmented label="How to rename" value={mode} onChange={setMode} options={[["prefix", "Add prefix"], ["suffix", "Add suffix"], ["replace", "Find & replace"], ["template", "Template"]]} />
      {mode === "replace" ? (
        <div class="rb-form-row">
          <Field label="Find">
            <input class="rb-input" value={find} onInput={(e) => setFind(e.currentTarget.value)} />
          </Field>
          <Field label="Replace with">
            <input class="rb-input" value={replaceWith} onInput={(e) => setReplaceWith(e.currentTarget.value)} />
          </Field>
        </div>
      ) : (
        <Field label={mode === "template" ? "Template" : mode === "prefix" ? "Prefix" : "Suffix"} hint={mode === "template" ? "{name} and {n} work here" : undefined}>
          <input class="rb-input" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        </Field>
      )}
      {invalid && <p class="rb-note">Badge names must be 1–{NAME_LIMIT} characters.</p>}
      <ul class="rb-preview-list">
        {changed.slice(0, 6).map((b) => (
          <li key={b.id}>
            <span class="rb-muted">{b.name}</span> → <strong>{names.get(b.id)}</strong>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
