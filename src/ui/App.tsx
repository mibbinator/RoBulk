import { useEffect, useState } from "preact/hooks";
import { Shell } from "./Shell";
import { detectTheme, type Theme } from "./theme";

// The dashboard is a single-page app, so watch for route changes and only
// offer the launcher on dashboard pages.
const isDashboard = () => location.pathname.startsWith("/dashboard");

export function App() {
  const [onDashboard, setOnDashboard] = useState(isDashboard);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const id = setInterval(() => setOnDashboard(isDashboard()), 1000);
    return () => clearInterval(id);
  }, []);

  const launch = () => {
    setTheme(detectTheme());
    setOpen(true);
  };

  return (
    <div class="rb-root" data-theme={theme}>
      {onDashboard && !open && (
        <button class="rb-launcher" onClick={launch} title="Open RoBulk">
          <LogoIcon />
          Bulk Edit
        </button>
      )}
      {open && <Shell onClose={() => setOpen(false)} />}
    </div>
  );
}

function LogoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" fill="currentColor" opacity=".6" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" fill="currentColor" opacity=".6" />
      <path d="M14.5 17.5l2.2 2.2 4.3-4.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
