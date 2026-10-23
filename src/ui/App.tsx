import { useEffect, useState } from "preact/hooks";
import logoUrl from "../../public/icons/icon-48.png?inline";
import { watchSidebar } from "../content/sidebar";
import { Shell } from "./Shell";
import { detectTheme, type Theme } from "./theme";

// The dashboard is a single-page app, so watch for route changes and only
// offer RoBulk on dashboard pages.
const isDashboard = () => location.pathname.startsWith("/dashboard");

/** How long to wait for the sidebar before showing the floating button instead. */
const SIDEBAR_WAIT_MS = 4000;

export function App() {
  const [onDashboard, setOnDashboard] = useState(isDashboard);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");
  const [inSidebar, setInSidebar] = useState(false);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setOnDashboard(isDashboard()), 1000);
    const wait = setTimeout(() => setWaited(true), SIDEBAR_WAIT_MS);
    return () => {
      clearInterval(id);
      clearTimeout(wait);
    };
  }, []);

  const launch = () => {
    setTheme(detectTheme());
    setOpen(true);
  };

  // The RoBulk entry under "All tools" in the dashboard's sidebar.
  useEffect(() => {
    if (!onDashboard) return;
    return watchSidebar(logoUrl, launch, setInSidebar);
  }, [onDashboard]);

  // When the sidebar is hidden (small windows) or can't be found, a floating button stands in.
  const floating = onDashboard && !open && !inSidebar && waited;

  return (
    <div class="rb-root" data-theme={theme}>
      {floating && (
        <button class="rb-launcher" onClick={launch} title="Open RoBulk">
          <img src={logoUrl} alt="" width={20} height={20} />
          RoBulk
        </button>
      )}
      {open && <Shell onClose={() => setOpen(false)} />}
    </div>
  );
}
