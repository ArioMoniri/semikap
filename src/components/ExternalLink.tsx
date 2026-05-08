import { useCallback, type ReactNode, type MouseEvent } from 'react';
import { isTauri } from '../lib/desktop/updater';

interface Props {
  href: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
}

/**
 * Anchor that opens its href in the user's *default browser* even when the
 * page is running inside the Tauri WebView (where `target="_blank"` is a
 * no-op). Falls back to standard new-tab semantics in the browser PWA.
 */
export function ExternalLink({ href, className, title, ariaLabel, children }: Props) {
  const handleClick = useCallback(
    async (e: MouseEvent<HTMLAnchorElement>) => {
      if (!isTauri()) return; // browser: let the anchor's default handle it
      e.preventDefault();
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(href);
      } catch (err) {
        console.warn('[TAMIAS] shell.open failed:', err);
      }
    },
    [href]
  );

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      title={title}
      aria-label={ariaLabel}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
