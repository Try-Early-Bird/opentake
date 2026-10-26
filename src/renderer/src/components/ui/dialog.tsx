import type { ComponentProps } from 'react';
import { Dialog as Primitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

// Local shadcn/Base UI dialog, matching the reference desktop's primitives.
export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
export function DialogContent({ children, className, showCloseButton = true, backdropClassName, ...props }: Primitive.Popup.Props & { showCloseButton?: boolean; backdropClassName?: string }) {
  return <Primitive.Portal>
    <Primitive.Backdrop className={cn('fixed inset-0 z-50 bg-black/50 backdrop-blur-xs', backdropClassName)} />
    <Primitive.Popup {...props} data-slot="dialog-content" className={cn('fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl bg-popover p-6 text-sm text-popover-foreground shadow-lg ring-1 ring-border outline-none', className)}>
      {children}
      {showCloseButton && <Primitive.Close aria-label="Close dialog" className="absolute top-3 right-3 rounded p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X size={16} /></Primitive.Close>}
    </Primitive.Popup>
  </Primitive.Portal>;
}
export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-2', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: Primitive.Title.Props) {
  return <Primitive.Title className={cn('pr-6 text-lg font-medium', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: Primitive.Description.Props) {
  return <Primitive.Description className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex justify-end gap-2 pt-2', className)} {...props} />;
}
