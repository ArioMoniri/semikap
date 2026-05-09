import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/ui/cn';

// `cva()` returns a function; we treat it as part of the component module since
// it has no separate users. The eslint react-refresh rule is silenced inline
// for this single export to avoid a parallel "variants" file with no payload.
// eslint-disable-next-line react-refresh/only-export-components
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tamias-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-tamias-accent text-white hover:bg-blue-700',
        // Dark-mode overrides matter most for `ghost` + `outline`: in dark
        // panels the v0.5.x outline used hard-coded `bg-white text-ink`,
        // which read as "barely-visible white card" in the Tools / Layout
        // sidebars (user feedback on v0.7.0 builds). Pin a slate-800
        // background and slate-100 text in dark mode so unselected buttons
        // stay legible at every contrast level.
        ghost:
          'bg-transparent text-tamias-ink hover:bg-slate-100 ' +
          'dark:text-slate-100 dark:hover:bg-slate-800',
        outline:
          'border border-slate-300 bg-white text-tamias-ink hover:bg-slate-50 ' +
          'dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
        danger: 'bg-red-600 text-white hover:bg-red-700',
        ink: 'bg-tamias-ink text-white hover:bg-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        icon: 'h-9 w-9 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />
  );
});

