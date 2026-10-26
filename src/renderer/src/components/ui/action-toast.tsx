import {ActionProgressCard} from '../ActionProgressCard'
import type {ActionProgress} from '../../../../shared/action-notification'
// toast.tsx is the per-screen error notice; this is the app-wide
// confirmation toast.
import { Toast as ToastPrimitive } from "@base-ui/react/toast"
import { Clock, XIcon } from "lucide-react"
import * as React from "react"

import { cn } from "../../lib/utils"

// App-wide toasts: short confirmations ("Draft saved.") that stack in the
// bottom-right corner, above the status bar, and dismiss themselves. Screens
// call useToast().add({ title, description?, actionProps? }). A toast about
// something now waiting to happen passes `data: { icon: "scheduled" }`: it
// leads with a clock in the brand accent and puts its action inline ("View").

/** Toasts to manage: add, update, close. */
const useToast = ToastPrimitive.useToastManager

function ToastList(): React.JSX.Element {
  const { toasts } = useToast()
  return (
    <>
      {toasts.map((toast) => {
        const action=(toast.data as {action?:ActionProgress}|undefined)?.action
        if(action)return <ToastPrimitive.Root key={toast.id} toast={toast} className="pointer-events-auto relative w-96 max-w-[calc(100vw-2rem)] rounded-xl bg-popover p-3 pr-8 text-popover-foreground shadow-lg ring-1 ring-foreground/10"><ToastPrimitive.Content><ToastPrimitive.Title className="sr-only">{action.title}</ToastPrimitive.Title><ActionProgressCard action={action} onView={toast.actionProps?()=>toast.actionProps?.onClick?.({} as React.MouseEvent<HTMLButtonElement>):undefined}/></ToastPrimitive.Content><ToastPrimitive.Close aria-label="Dismiss" className="absolute right-2 top-3 text-muted-foreground"><XIcon size={12}/></ToastPrimitive.Close></ToastPrimitive.Root>
        const scheduled = (toast.data as { icon?: string } | undefined)?.icon === "scheduled"
        if (scheduled) {
          return (
            <ToastPrimitive.Root
              key={toast.id}
              toast={toast}
              data-slot="toast"
              className={cn(
                "pointer-events-auto flex w-96 items-center gap-3 rounded-xl bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10",
                "transition-[opacity,transform] duration-150 ease-out data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0",
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand" aria-hidden>
                <Clock size={16} />
              </span>
              <ToastPrimitive.Content className="min-w-0 flex-1">
                <ToastPrimitive.Title className="truncate font-medium" />
                <ToastPrimitive.Description className="truncate text-xs text-muted-foreground" />
              </ToastPrimitive.Content>
              {toast.actionProps !== undefined && (
                <ToastPrimitive.Action className="shrink-0 rounded px-1.5 py-0.5 text-sm font-medium text-brand hover:bg-brand/10" />
              )}
              <ToastPrimitive.Close
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon size={14} />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          )
        }
        return (
        <ToastPrimitive.Root
          key={toast.id}
          toast={toast}
          data-slot="toast"
          className={cn(
            "pointer-events-auto flex w-80 items-start gap-3 rounded-xl bg-popover p-3 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10",
            "transition-[opacity,transform] duration-150 ease-out data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0 data-[ending-style]:translate-y-2 data-[ending-style]:opacity-0",
          )}
        >
          <ToastPrimitive.Content className="min-w-0 flex-1">
            <ToastPrimitive.Title className="font-medium" />
            <ToastPrimitive.Description className="mt-0.5 text-xs text-muted-foreground" />
            {toast.actionProps !== undefined && (
              <ToastPrimitive.Action className="mt-2 text-xs font-medium underline underline-offset-2 hover:text-foreground" />
            )}
          </ToastPrimitive.Content>
          <ToastPrimitive.Close
            aria-label="Dismiss"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <XIcon size={14} />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
        )
      })}
    </>
  )
}

/** Wraps the app: provides the toast manager and renders the corner viewport. */
function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ToastPrimitive.Provider timeout={8000}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport
          data-slot="toast-viewport"
          className="pointer-events-none fixed right-4 bottom-12 z-[60] flex flex-col items-end gap-2"
        >
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  )
}

export { ToastProvider, useToast }
