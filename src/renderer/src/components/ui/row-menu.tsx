import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

// Dialog action rows: native buttons retain Enter/Space and Tab behavior.
export function RowMenu({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} role="group" className={cn('grid gap-1', className)} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-menu-item]:not(:disabled)')];
    if (!rows.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current < 0 ? event.key === 'ArrowUp' ? rows.length - 1 : 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next].focus();
  }} />;
}

export function RowMenuItem({ className, ...props }: ComponentProps<'button'>) {
  return <button {...props} type="button" data-row-menu-item onPointerMove={event => {
    if (!event.currentTarget.disabled && event.pointerType === 'mouse') event.currentTarget.focus({ preventScroll: true });
  }} className={cn('flex w-full items-center gap-3 rounded-md px-3 py-4 text-left text-sm outline-none enabled:hover:bg-muted focus:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', className)} />;
}
