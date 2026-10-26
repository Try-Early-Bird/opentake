import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Wallet } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { PortfolioAccount } from '../../../shared/portfolio';
import { CoinbaseMark, RobinhoodLogoTile } from '../logos';
import { money } from '../portfolio/format';

export function PortfolioAccountSelect({ accounts, value, onChange, loading = false }: { accounts: PortfolioAccount[]; value: string | null; onChange: (id: string) => void; loading?: boolean }) {
  const selected = accounts.find(account => account.id === value);
  // Until the account list arrives, a remembered account is not "unavailable"; hold its place.
  if (loading && !selected) return <h1 id="portfolio-value-heading" aria-label="Loading account" aria-busy="true" className="min-w-0 font-display text-[26px] tracking-[-0.02em]">
    <span className="block h-[1.4em] w-56 max-w-full animate-pulse rounded-md bg-muted" aria-hidden="true"/>
  </h1>;
  return <h1 id="portfolio-value-heading" aria-label={selected?.label ?? (value ? 'Account unavailable' : 'Select an account')} className="min-w-0 font-display text-[26px] tracking-[-0.02em]">
    <Select.Root value={value} onValueChange={id => { if (id) onChange(id); }} items={accounts.map(account => ({ value: account.id, label: account.label }))}>
      <Select.Trigger aria-label="Select portfolio account" className="flex max-w-[min(28rem,calc(100vw-5rem))] items-center gap-2 rounded-md py-1 text-left outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span className="truncate">{selected?.label ?? (value ? 'Account unavailable' : 'Select an account')}</span><Select.Icon><ChevronDown size={20} className="shrink-0" aria-hidden="true"/></Select.Icon>
      </Select.Trigger>
      <Select.Portal><Select.Positioner align="start" alignItemWithTrigger={false} sideOffset={8} collisionPadding={16} className="z-50">
        <Select.Popup className="w-[380px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none">
          <p className="border-b border-border px-5 py-4 text-sm font-medium">Select an account</p>
          <Select.List className="max-h-[min(24rem,var(--available-height))] overflow-y-auto divide-y divide-border">
            {accounts.map(account => {
              const balance = account.balance;
              const known = balance?.totalValue != null && balance.totalValue !== '' && Number.isFinite(Number(balance.totalValue)) && /^[A-Z]{3}$/.test(balance.currency);
              return <Select.Item key={account.id} value={account.id} className="relative flex cursor-default items-center gap-3 px-5 py-4 pr-12 outline-none data-[highlighted]:bg-muted">
                {account.venue === 'robinhood' ? <RobinhoodLogoTile className="size-8" markClassName="size-4"/> : account.venue === 'coinbase' ? <CoinbaseMark className="size-8 shrink-0" /> : <Wallet size={24} aria-hidden="true"/>}
                <span className="min-w-0 flex-1"><Select.ItemText className="block truncate text-sm row-title">{account.label}</Select.ItemText><span className="mt-1 block text-xs text-muted-foreground">{account.venue === 'coinbase' ? 'Coinbase' : 'Robinhood'} · {known ? `${money(balance!.totalValue, balance!.currency)} total balance` : 'Balance not synced'}</span>{!account.available && <span className="mt-1 block text-xs text-muted-foreground">Reconnect to update</span>}{known && Number.isFinite(Date.parse(balance!.observedAt)) && <span className="mt-1 block text-[11px] text-muted-foreground">Saved {new Date(balance!.observedAt).toLocaleString()}</span>}</span>
                <Select.ItemIndicator className="absolute right-5 text-success"><Check size={20} aria-hidden="true"/></Select.ItemIndicator>
              </Select.Item>;
            })}
          </Select.List>
          <Link to="/settings" search={{ section: 'connections' }} className="block border-t border-border px-5 py-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">Manage connections ↗</Link>
        </Select.Popup>
      </Select.Positioner></Select.Portal>
    </Select.Root>
  </h1>;
}
