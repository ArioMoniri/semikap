import { useEffect, useState } from 'react';
import { Moon, Sun, MonitorSmartphone } from 'lucide-react';
import { applyTheme, readStoredTheme, storeTheme, type Theme } from '../lib/ui/theme';
import { cn } from '../lib/ui/cn';

const ORDER: Theme[] = ['light', 'dark', 'system'];

const ICONS: Record<Theme, JSX.Element> = {
  light: <Sun className="h-3.5 w-3.5" aria-hidden="true" />,
  dark: <Moon className="h-3.5 w-3.5" aria-hidden="true" />,
  system: <MonitorSmartphone className="h-3.5 w-3.5" aria-hidden="true" />,
};

const LABELS: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

/**
 * Three-state theme toggle (Light / Dark / System), persisted in localStorage.
 * Sits in the header.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    setTheme(next);
    storeTheme(next);
    applyTheme(next);
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white/80 hover:bg-white/15',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-1 focus-visible:ring-offset-tamias-ink'
      )}
      aria-label={`Theme: ${LABELS[theme]}. Click to cycle.`}
      title={`Theme: ${LABELS[theme]} — click to cycle`}
    >
      {ICONS[theme]} {LABELS[theme]}
    </button>
  );
}
