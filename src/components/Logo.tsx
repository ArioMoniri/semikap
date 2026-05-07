import { cn } from '../lib/ui/cn';

interface Props {
  className?: string;
}

/**
 * Inline TAMIAS wordmark + glyph. Avoids fetching an SVG over the network at
 * runtime (CSP-friendly) and renders crisply at any size.
 */
export function Logo({ className }: Props) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <svg
        viewBox="0 0 32 32"
        className="h-6 w-6 text-tamias-accent"
        aria-hidden="true"
      >
        <rect x="2" y="2" width="28" height="28" rx="7" fill="currentColor" opacity="0.12" />
        <rect x="2" y="2" width="28" height="28" rx="7" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path
          d="M9 11h14M16 11v12"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
      <div className="leading-none">
        <div className="text-sm font-bold tracking-wide text-white">TAMIAS</div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/50">
          local imaging
        </div>
      </div>
    </div>
  );
}
