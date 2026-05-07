import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/ui/cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg border border-slate-200 bg-white shadow-sm',
          'dark:border-slate-800 dark:bg-slate-900',
          className
        )}
        {...props}
      />
    );
  }
);

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('flex flex-col space-y-1 p-4 pb-2', className)}
        {...props}
      />
    );
  }
);

export const CardTitle = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'text-sm font-semibold tracking-tight text-tamias-ink',
          'dark:text-slate-100',
          className
        )}
        {...props}
      />
    );
  }
);

export const CardDescription = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardDescription({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('text-xs text-slate-500 dark:text-slate-400', className)}
        {...props}
      />
    );
  }
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn('p-4 pt-0 text-sm', className)} {...props} />;
  }
);

export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div ref={ref} className={cn('flex items-center p-4 pt-0', className)} {...props} />
    );
  }
);
