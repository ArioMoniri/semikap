import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';
import { cn } from '../../lib/ui/cn';

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleContent = CollapsiblePrimitive.Content;

type RootProps = Omit<ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, 'title'>;

interface SectionProps extends RootProps {
  /** Section heading shown in the trigger row. */
  title: ReactNode;
  /** Optional badge or right-side adornment in the header. */
  trailing?: ReactNode;
  /** Additional content classes. */
  contentClassName?: string;
}

/**
 * Sidebar-friendly collapsible section: a clickable header with a chevron and
 * a panel below. Used to group related controls without overwhelming the
 * sidebar at first glance.
 */
export const CollapsibleSection = forwardRef<
  ElementRef<typeof CollapsiblePrimitive.Root>,
  SectionProps
>(function CollapsibleSection(
  { title, trailing, children, className, contentClassName, ...props },
  ref
) {
  return (
    <CollapsiblePrimitive.Root
      ref={ref}
      className={cn(
        'rounded-lg border border-slate-200 bg-white shadow-sm',
        'dark:border-slate-800 dark:bg-slate-900',
        className
      )}
      {...props}
    >
      <CollapsiblePrimitive.Trigger
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tamias-accent focus-visible:ring-offset-2'
        )}
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-tamias-ink dark:text-slate-100">
          <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-data-[state=closed]:-rotate-90 dark:text-slate-500" />
          {title}
        </div>
        {trailing && <div className="text-xs text-slate-500 dark:text-slate-400">{trailing}</div>}
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content
        className={cn(
          'overflow-hidden border-t border-slate-100 px-3 py-3 text-sm',
          'dark:border-slate-800',
          'data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down',
          contentClassName
        )}
      >
        {children}
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
});
