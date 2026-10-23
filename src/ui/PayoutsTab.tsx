import { useEffect, useMemo, useState } from "preact/hooks";
import { findUser } from "../api/account";
import { cacheCovers } from "../core/salesCache";
import { markPaid, owed, readPlan, writePlan, type Designer, type PayoutPlan } from "../core/payouts";
import { robux } from "./charts";
import { Dialog, Segmented, downloadText, fileSafe } from "./components";
import { creatorKey, useWorkspace } from "./workspace";

// Works out what each designer in a group is owed from their items' sales.
// RoBulk doesn't send payouts: the amounts are paid on Roblox's own payouts
// page, then marked as paid here so the next period starts after them.

type Period = "unpaid" | "thisMonth" | "lastMonth" | "30";

const startOfMonth = (d: Date, offset = 0) => new Date(d.getFullYear(), d.getMonth() + offset, 1);

/** The period a designer is being paid for. */
function periodFor(period: Period, designer: Designer, now: Date): { from: Date; to: Date } {
  switch (period) {
    case "unpaid":
      return { from: designer.paidThrough ? new Date(designer.paidThrough) : startOfMonth(now), to: now };
    case "thisMonth":
      return { from: startOfMonth(now), to: now };
    case "lastMonth":
      return { from: startOfMonth(now, -1), to: new Date(startOfMonth(now).getTime() - 1) };
    case "30":
      return { from: new Date(now.getTime() - 30 * 86_400_000), to: now };
  }
}

const shortDate = (d: Date) => d.toLocaleDateString(undefined, { dateStyle: "medium" });

function ItemPicker({ designer, onSave, onClose }: { designer: Designer; onSave: (keys: string[]) => void; onClose: () => void }) {
  const { items, thumbs } = useWorkspace();
  const [chosen, setChosen] = useState(new Set(designer.itemKeys));
  const [search, setSearch] = useState("");
  const shown = items.filter((i) => i.name.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (key: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Dialog
      title={`Items ${designer.name} is paid for`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <span class="rb-muted rb-small">{chosen.size} selected</span>
          <div class="rb-spacer" />
          <button class="rb-btn rb-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button class="rb-btn rb-btn-primary" onClick={() => onSave([...chosen])}>
            Save
          </button>
        </>
      }
    >
      <div class="rb-picker-tools">
        <input class="rb-input" placeholder="Search names, like [+] or Suit" value={search} onInput={(e) => setSearch(e.currentTarget.value)} />
        <button class="rb-link-btn" onClick={() => setChosen((prev) => new Set([...prev, ...shown.map((i) => i.key)]))}>
          Select all shown
        </button>
        <button class="rb-link-btn" onClick={() => setChosen((prev) => new Set([...prev].filter((k) => !shown.some((i) => i.key === k))))}>
          Clear shown
        </button>
      </div>
      {items.length === 0 && <p class="rb-muted">No items loaded yet.</p>}
      <ul class="rb-picker-list">
        {shown.map((i) => (
          <li key={i.key}>
            <label>
              <input type="checkbox" class="rb-check" checked={chosen.has(i.key)} onChange={(e) => toggle(i.key, e.currentTarget.checked)} />
              {thumbs.get(i.key) && <img src={thumbs.get(i.key)} alt="" width={28} height={28} />}
              <span>{i.name}</span>
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function PayoutsTab() {
  const { client, creator, storage, salesEntry, sales, loadSalesSince } = useWorkspace();
  const groupKey = creator ? creatorKey(creator) : "";
  const [plan, setPlan] = useState<PayoutPlan | null>(null);
  const [period, setPeriod] = useState<Period>("unpaid");
  const [username, setUsername] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [picking, setPicking] = useState<Designer | null>(null);
  const now = useMemo(() => new Date(), [period, salesEntry]);

  useEffect(() => {
    setPlan(null);
    if (groupKey) readPlan(storage, groupKey).then(setPlan);
  }, [groupKey]);

  const save = (next: PayoutPlan) => {
    setPlan(next);
    writePlan(storage, groupKey, next).catch(() => {});
  };
  const update = (userId: number, patch: Partial<Designer>) => plan && save({ ...plan, designers: plan.designers.map((d) => (d.userId === userId ? { ...d, ...patch } : d)) });

  const rows = (plan?.designers ?? []).map((d) => {
    const { from, to } = periodFor(period, d, now);
    return { designer: d, from, to, ...owed(d, salesEntry?.sales ?? [], from, to) };
  });
  const earliest = rows.reduce<Date | null>((min, r) => (!min || r.from < min ? r.from : min), null);
  const covered = !earliest || (salesEntry ? cacheCovers(salesEntry, earliest) : false);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  // Load sales far enough back for every designer's period.
  useEffect(() => {
    if (earliest && !covered) loadSalesSince(earliest);
  }, [earliest?.getTime(), covered]);

  if (creator?.type !== "Group") return <div class="rb-empty">Payouts are for groups. Pick a group in the creator menu.</div>;
  if (!creator.access.earnings) return <div class="rb-empty">Your role in this group can't see its revenue, so payouts can't be worked out.</div>;

  const add = async () => {
    if (!plan || !username.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const user = await findUser(client, username);
      if (!user) setAddError(`There's no Roblox user called "${username.trim()}".`);
      else if (plan.designers.some((d) => d.userId === user.id)) setAddError(`${user.name} is already on the list.`);
      else {
        save({ ...plan, designers: [...plan.designers, { userId: user.id, name: user.name, share: 30, itemKeys: [], paidThrough: null }] });
        setUsername("");
      }
    } catch (e) {
      setAddError(`Couldn't look that user up: ${(e as Error).message}`);
    }
    setAdding(false);
  };

  const exportCsv = () => {
    const lines = ["designer,user id,from,to,sales,earned,share %,payout"];
    for (const r of rows) lines.push([`"${r.designer.name}"`, r.designer.userId, r.from.toISOString(), r.to.toISOString(), r.sales, r.earned, r.designer.share, r.amount].join(","));
    downloadText(`${fileSafe(creator.name)}-payouts.csv`, lines.join("\r\n") + "\r\n", "text/csv");
  };

  const confirmPaid = () => {
    const payments = rows.filter((r) => r.amount > 0).map((r) => ({ designer: r.designer, amount: r.amount, from: r.from }));
    if (payments.length === 0 || !plan) return;
    const list = payments.map((p) => `${p.designer.name}: ${robux(p.amount)}`).join("\n");
    if (!confirm(`Mark these as paid?\n\n${list}\n\nOnly do this after paying them on Roblox. Their next period will start after ${shortDate(now)}.`)) return;
    save(markPaid(plan, payments, now));
  };

  return (
    <>
      <div class="rb-toolbar">
        <Segmented<Period>
          label="Period"
          value={period}
          onChange={setPeriod}
          options={[
            ["unpaid", "Since last payout"],
            ["thisMonth", "This month"],
            ["lastMonth", "Last month"],
            ["30", "Last 30 days"],
          ]}
        />
        <div class="rb-spacer" />
        <button class="rb-btn rb-btn-ghost" disabled={rows.length === 0} onClick={exportCsv}>
          Export (.csv)
        </button>
        <a class="rb-btn rb-btn-ghost" href={`https://create.roblox.com/dashboard/group/payouts?groupId=${creator.id}`} target="_blank" rel="noreferrer">
          Open Roblox payouts
        </a>
      </div>

      <main class="rb-body rb-pad">
        <p class="rb-muted rb-small rb-payouts-note">
          Add the people who design for {creator.name}, the share of their items' earnings they get, and which items are theirs. RoBulk works out what each is owed;
          you pay them on Roblox's payouts page, then click <strong>Mark as paid</strong> so the next period starts after it. RoBulk never sends Robux itself.
        </p>

        {!covered && (
          <div class="rb-banner rb-banner-inline">
            {sales.progress ?? "Loading sales"} The amounts fill in as sales arrive.
          </div>
        )}

        <section class="rb-card">
          <div class="rb-table-wrap">
            <table class="rb-table">
              <thead>
                <tr>
                  <th>Designer</th>
                  <th class="num">Share</th>
                  <th>Items</th>
                  <th>Period</th>
                  <th class="num">Sales</th>
                  <th class="num">Their items earned</th>
                  <th class="num">Payout</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.designer.userId}>
                    <td>
                      <a href={`https://www.roblox.com/users/${r.designer.userId}/profile`} target="_blank" rel="noreferrer">
                        {r.designer.name}
                      </a>
                    </td>
                    <td class="num">
                      <input
                        class="rb-input rb-share"
                        type="number"
                        min={0}
                        max={100}
                        aria-label={`Share for ${r.designer.name}, percent`}
                        value={r.designer.share}
                        onChange={(e) => update(r.designer.userId, { share: Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)) })}
                      />
                      %
                    </td>
                    <td>
                      <button class="rb-link-btn" onClick={() => setPicking(r.designer)}>
                        {r.designer.itemKeys.length === 0 ? "Choose items" : `${r.designer.itemKeys.length} ${r.designer.itemKeys.length === 1 ? "item" : "items"}`}
                      </button>
                    </td>
                    <td class="rb-small rb-muted">
                      {shortDate(r.from)} – {shortDate(r.to)}
                    </td>
                    <td class="num">{r.sales.toLocaleString()}</td>
                    <td class="num">{robux(r.earned)}</td>
                    <td class="num">
                      <strong>{robux(r.amount)}</strong>
                    </td>
                    <td class="num">
                      <button
                        class="rb-link-btn"
                        onClick={() => plan && confirm(`Remove ${r.designer.name}?`) && save({ ...plan, designers: plan.designers.filter((d) => d.userId !== r.designer.userId) })}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && plan && (
                  <tr>
                    <td colSpan={8} class="rb-muted">
                      No designers yet. Add one below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <form
            class="rb-add-designer"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input class="rb-input" placeholder="Roblox username" aria-label="Designer's Roblox username" value={username} onInput={(e) => setUsername(e.currentTarget.value)} />
            <button class="rb-btn" type="submit" disabled={adding || !username.trim()}>
              {adding ? "Looking up…" : "Add designer"}
            </button>
            {addError && <span class="rb-error rb-small">{addError}</span>}
          </form>
        </section>

        {rows.length > 0 && (
          <div class="rb-payouts-total">
            <span>
              Total to pay: <strong>{robux(total)}</strong>
              {sales.balance != null && <span class="rb-muted"> · group funds {robux(sales.balance)}</span>}
              {sales.balance != null && total > sales.balance && <span class="rb-error"> · more than the group has</span>}
            </span>
            <button class="rb-btn rb-btn-primary" disabled={total === 0 || !covered} onClick={confirmPaid}>
              Mark as paid
            </button>
          </div>
        )}

        {plan && plan.paid.length > 0 && (
          <details class="rb-paid-log">
            <summary>Payouts marked as paid ({plan.paid.length})</summary>
            <ul>
              {plan.paid.map((p, i) => (
                <li key={i}>
                  {shortDate(new Date(p.markedAt))}: {p.name} {robux(p.amount)} for {shortDate(new Date(p.from))} – {shortDate(new Date(p.to))}
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>

      {picking && (
        <ItemPicker
          designer={picking}
          onClose={() => setPicking(null)}
          onSave={(keys) => {
            update(picking.userId, { itemKeys: keys });
            setPicking(null);
          }}
        />
      )}
    </>
  );
}
