import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../core/settings";
import { useWorkspace } from "./workspace";

const megabytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The settings that are switched on or off. */
type Switch = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function Option({ setting, label, hint }: { setting: Switch; label: string; hint: string }) {
  const { settings, updateSettings } = useWorkspace();
  return (
    <label class="rb-option">
      <input type="checkbox" class="rb-check" checked={settings[setting]} onChange={(e) => updateSettings({ [setting]: e.currentTarget.checked })} />
      <strong>{label}</strong>
      <span>{hint}</span>
    </label>
  );
}

const LIMITS: [string, number | null][] = [
  ["25,000", 25_000],
  ["50,000", 50_000],
  ["100,000 (default)", 100_000],
  ["250,000", 250_000],
  ["500,000", 500_000],
  ["1,000,000", 1_000_000],
  ["2,500,000", 2_500_000],
  ["No limit", null],
];
/** Above this, a warning says saved sales can take a lot of space. */
const LARGE_LIMIT = 500_000;

/** How many sales to keep in the browser per account or group. */
function StorageLimit() {
  const { settings, updateSettings } = useWorkspace();
  const limit = settings.maxStoredSales;
  const large = limit === null || limit > LARGE_LIMIT;
  return (
    <div class="rb-option-extra">
      <label class="rb-limit">
        <span>Sales to keep per account or group</span>
        <select
          class="rb-select"
          disabled={!settings.rememberSales}
          value={limit === null ? "none" : String(limit)}
          onChange={(e) => updateSettings({ maxStoredSales: e.currentTarget.value === "none" ? null : Number(e.currentTarget.value) })}
        >
          {LIMITS.map(([label, value]) => (
            <option key={label} value={value === null ? "none" : String(value)}>
              {label}
            </option>
          ))}
          {limit !== null && !LIMITS.some(([, v]) => v === limit) && <option value={String(limit)}>{limit.toLocaleString()}</option>}
        </select>
      </label>
      <p class="rb-small rb-muted">
        The newest are kept and older ones are dropped past this. Each 100,000 sales takes about 6 MB. If the browser won't save that many, RoBulk keeps them in a separate
        database of its own instead.
      </p>
      {large && settings.rememberSales && (
        <p class="rb-small rb-warning-text" role="note">
          ⚠ Keeping more than 500,000 sales can take up a lot of space on your computer ({limit === null ? "about 60 MB per million sales, with no limit" : `up to about ${Math.round((limit / 1_000_000) * 60)} MB per account or group`}). It's
          only worth it for very busy stores that want their whole history.
        </p>
      )}
    </div>
  );
}

export function OptionsTab() {
  const { settings, savedSalesSize, clearSavedSales } = useWorkspace();
  const [size, setSize] = useState<number | null>(null);

  const measure = () => savedSalesSize().then(setSize);
  useEffect(() => {
    measure();
  }, [settings.rememberSales]);

  const clear = async () => {
    if (!confirm("Clear the sales saved in this browser? The next earnings report loads them from Roblox again.")) return;
    await clearSavedSales();
    measure();
  };

  return (
    <main class="rb-body rb-pad">
      <p class="rb-muted">These apply to every creator and are saved in this browser.</p>
      <div class="rb-options">
        <section class="rb-card">
          <header class="rb-card-header">
            <h3>Sales and earnings</h3>
          </header>
          <Option
            setting="backgroundSales"
            label="Load sales in the background"
            hint="Starts loading your sales as soon as RoBulk opens, so the Earnings report and the sold counts in the Items tab are ready when you get to them. A bar at the bottom of the panel shows how it's going."
          />
          <Option
            setting="rememberSales"
            label="Remember sales between visits"
            hint="Keeps loaded sales in this browser so later visits only fetch new ones. Turning this off deletes the saved sales."
          />
          <StorageLimit />
          <div class="rb-option-extra rb-small rb-muted">
            {size == null ? "Saved sales: size unknown in this browser." : size === 0 ? "No sales saved." : `Saved sales take up ${megabytes(size)}.`}{" "}
            {size !== 0 && (
              <button class="rb-link-btn" onClick={clear}>
                Clear saved sales
              </button>
            )}
          </div>
        </section>

        <section class="rb-card">
          <header class="rb-card-header">
            <h3>Items</h3>
          </header>
          <Option
            setting="perSaleEarnings"
            label="Show what you get per sale"
            hint={'Looks up Roblox\'s share for each avatar item price to show "you get R$…" next to it. That takes one request to Roblox per price.'}
          />
          <Option
            setting="dailySnapshots"
            label="Take a daily snapshot"
            hint="Saves your prices and sale status once a day when RoBulk opens, so you can restore them from the History tab. A snapshot before each save is always taken."
          />
          <Option
            setting="offSaleAlarm"
            label="Warn me when items go off sale"
            hint="When you visit Roblox or the Creator Dashboard, checks whether items RoBulk has seen on sale were taken off sale (for example when a group owner's Premium runs out). A banner shows on each site until you close it."
          />
          <Option
            setting="newSalesBadge"
            label="Count new sales on the sidebar"
            hint="Shows how many sales came in since you last opened the Earnings report, next to RoBulk in the dashboard's sidebar."
          />
        </section>

        <section class="rb-card">
          <header class="rb-card-header">
            <h3>Experimental</h3>
          </header>
          <p class="rb-small rb-muted rb-option-note">Newer features that may change or not always be right yet.</p>
          <Option
            setting="bestTimes"
            label="Best times to sell"
            hint="Adds a chart to the Earnings report showing which days and hours your sales come in, in your time zone."
          />
          <Option
            setting="priceImpact"
            label="Price vs. sales"
            hint="In an item's sales, compares how it sold before and after its last price change, using RoBulk's snapshots and change log."
          />
        </section>
      </div>
    </main>
  );
}
