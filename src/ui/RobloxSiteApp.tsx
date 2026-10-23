import { useEffect, useMemo, useState } from "preact/hooks";
import { createClient } from "../api/http";
import { OffSaleBanner, runOffSaleCheck } from "./OffSaleBanner";
import { detectTheme, type Theme } from "./theme";
import { makeStorage } from "./workspace";

// What RoBulk does on www.roblox.com: only the off-sale alarm. It checks the
// catalog (at most every few minutes) and shows a banner until it's closed,
// with a link that opens the fix in RoBulk on the Creator Dashboard.

export function RobloxSiteApp() {
  const client = useMemo(() => createClient(), []);
  const storage = useMemo(makeStorage, []);
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    setTheme(detectTheme());
    runOffSaleCheck(client, storage);
  }, []);

  return (
    <div class="rb-root" data-theme={theme}>
      <OffSaleBanner
        site="roblox"
        storage={storage}
        reviewHref={(alert) =>
          `https://create.roblox.com/dashboard/creations?${new URLSearchParams({
            ...(alert.creatorType === "Group" ? { groupId: String(alert.creatorId) } : {}),
            robulkAlert: alert.id,
          })}`
        }
      />
    </div>
  );
}
