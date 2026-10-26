import { Select as Primitive } from '@base-ui/react/select';
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

// Local shadcn/Base UI Select, shared by settings and credential forms.
export function Select({ id, value, onValueChange, items, disabled, className, renderItem, renderValue, header, popupClassName, ariaLabel }: {
  ariaLabel?: string; id: string; value: string; onValueChange: (value: string) => void;
  header?: ReactNode; popupClassName?: string;
  renderItem?: (value: string) => ReactNode; renderValue?: (value: string) => ReactNode;
  items: { value: string; label: string; disabled?: boolean }[]; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <Primitive.Root open={open} onOpenChange={setOpen} value={value} items={items} disabled={disabled} onValueChange={next => { if (next !== null) onValueChange(next); }}>
    <Primitive.Trigger id={id} aria-label={ariaLabel} data-slot="select-trigger" onKeyDownCapture={event => {
      if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
    }} className={cn('flex min-h-9 items-center justify-between gap-3 rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', className)}>
      <Primitive.Value>{renderValue ? renderValue(value) : undefined}</Primitive.Value>
      <Primitive.Icon><ChevronDown size={14} aria-hidden="true" className="text-muted-foreground" /></Primitive.Icon>
    </Primitive.Trigger>
    <Primitive.Portal>
      <Primitive.Positioner sideOffset={4} align="start" alignItemWithTrigger={false} collisionPadding={8} className={cn('z-[60]', popupClassName)}>
        <Primitive.Popup data-slot="select-content" onKeyDownCapture={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
        }} className="min-w-[var(--anchor-width)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none">
          {header && <div className="flex items-center justify-end px-3 py-2">{header}</div>}
          <Primitive.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto p-1">
            {items.map(item => <Primitive.Item key={item.value} value={item.value} disabled={item.disabled} className="relative flex cursor-default items-center rounded-sm py-2 pr-8 pl-2 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-40">
              <Primitive.ItemText>{renderItem ? renderItem(item.value) : item.label}</Primitive.ItemText>
              <Primitive.ItemIndicator className="absolute right-2"><Check size={14} aria-hidden="true" /></Primitive.ItemIndicator>
            </Primitive.Item>)}
          </Primitive.List>
        </Primitive.Popup>
      </Primitive.Positioner>
    </Primitive.Portal>
  </Primitive.Root>;
}
