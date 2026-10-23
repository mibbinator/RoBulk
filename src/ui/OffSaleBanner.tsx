import { useEffect, useState } from "preact/hooks";
import { listAvatarItems } from "../api/catalog";
import type { RobloxClient } from "../api/http";
import type { StorageLike } from "../core/history";
import { activeAlerts, checkOffSale, dismissAlert, type OffSaleAlert, type Site } from "../core/offSaleWatch";
import { readSettings } from "../core/settings";

const ALERTS_CHANGED = "robulk:alerts-changed";

/** Checks the catalog for items that went off sale, if the alarm is on. Safe to call on every page load. */
export async function runOffSaleCheck(client: RobloxClient, storage: StorageLike): Promise<void> {
  if (!(await readSettings(storage)).offSaleAlarm) return;
  const raised = await checkOffSale(storage, async (type, id) =>
    (await listAvatarItems(client, { type, id, name: "", access: { avatarItems: true, experiences: false, earnings: false } })).map((i) => ({
      id: i.id,
      name: i.name,
      onSale: i.onSale,
    })),
  ).catch(() => []);
  if (raised.length) window.dispatchEvent(new Event(ALERTS_CHANGED));
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Banners for off-sale alerts on this site. Each stays until its ✕ is
 * clicked; closing it here doesn't close it on the other site.
 */
export function OffSaleBanner({ site, storage, onReview, reviewHref }: { site: Site; storage: StorageLike; onReview?: (alert: OffSaleAlert) => void; reviewHref?: (alert: OffSaleAlert) => string }) {
  const [alerts, setAlerts] = useState<OffSaleAlert[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      activeAlerts(storage, site).then(setAlerts, () => {});
    };
    refresh();
    window.addEventListener(ALERTS_CHANGED, refresh);
    // Another tab may raise or close an alert.
    const onStorage = (changes: Record<string, unknown>) => "offSaleAlerts" in changes && refresh();
    const events = typeof chrome !== "undefined" ? chrome.storage?.onChanged : undefined;
    events?.addListener(onStorage);
    return () => {
      window.removeEventListener(ALERTS_CHANGED, refresh);
      events?.removeListener(onStorage);
    };
  }, [storage, site]);

  if (alerts.length === 0) return null;

  const close = async (alert: OffSaleAlert) => {
    setAlerts((list) => list.filter((a) => a.id !== alert.id));
    await dismissAlert(storage, alert.id, site);
  };

  return (
    <div class="rb-alerts" role="alert">
      {alerts.map((alert) => {
        const n = alert.items.length;
        return (
          <div class="rb-alert" key={alert.id}>
            <div class="rb-alert-text">
              <strong>
                {n} {plural(n, "item", "items")} from {alert.creatorName} went off sale
              </strong>{" "}
              <span>
                RoBulk noticed on {new Date(alert.detectedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.{" "}
                {alert.creatorType === "Group" ? "This can happen when the group owner's Premium runs out." : "Check your Premium membership if you didn't do this."}
              </span>{" "}
              <button class="rb-link-btn" onClick={() => setOpen(open === alert.id ? null : alert.id)}>
                {open === alert.id ? "Hide items" : "Show items"}
              </button>
              {open === alert.id && (
                <ul class="rb-alert-items">
                  {alert.items.map((i) => (
                    <li key={i.id}>{i.name}</li>
                  ))}
                </ul>
              )}
            </div>
            {onReview && (
              <button class="rb-btn rb-btn-primary rb-alert-action" onClick={() => onReview(alert)}>
                Put back on sale…
              </button>
            )}
            {reviewHref && (
              <a class="rb-btn rb-btn-primary rb-alert-action" href={reviewHref(alert)}>
                Fix in RoBulk
              </a>
            )}
            <button class="rb-alert-close" aria-label="Close this warning" title="Close" onClick={() => close(alert)}>
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
