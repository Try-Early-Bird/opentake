// Shared control styles for connection and setup modals. Values follow the
// trading-platform modal (ConnectMenu), so AI and platform setup look alike.
const focus = 'focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';
export const primaryButtonClass = `rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 ${focus}`;
export const secondaryButtonClass = `rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground ${focus}`;
export const linkButtonClass = `rounded text-sm underline underline-offset-4 ${focus}`;
export const fieldLabelClass = 'block text-sm font-medium';
export const inputClass = 'mt-1.5 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export const choiceClass = 'flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-foreground/30 has-[:checked]:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-50';
export const mutedTextClass = 'text-sm text-muted-foreground';
export const actionsClass = 'flex items-center justify-end gap-2';
