import { useEffect, useState } from "preact/hooks";
import type { Settings } from "../core/settings";
import { useWorkspace } from "./workspace";

const megabytes = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function Option({ setting, label, hint }: { setting: keyof Settings; label: string; hint: string }) {
  const { settings, updateSettings } = useWorkspace();
  return (
    <label class="rb-option">
      <input type="checkbox" class="rb-check" checked={settings[setting]} onChange={(e) => updateSettings({ [setting]: e.currentTarget.checked })} />
      <strong>{label}</strong>
      <span>{hint}</span>
    </label>
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
        </section>
      </div>
    </main>
  );
}
