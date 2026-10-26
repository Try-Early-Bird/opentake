import {NotificationAccount} from './NotificationAccount';
import { Link } from '@tanstack/react-router';
import {NotificationRow} from './NotificationRow';
import { Button } from './ui/button';
import { setArchivePromptOpen } from '../archive-decision-store';
import type { NotificationItem } from '../../../shared/notifications';

// The strategy_archived, cash_shortfall, outside_sale, holding_not_bought and
// symbol_delisted rows. The member archives
// their own take here, so the archive row names the take rather than an author.
// close_failed, take_overspent, order_unknown and missing_evidence are self-hosted additions in the
// same markup; their decisions are made on the take page.
export function TakeEventNotificationRow({ item, busy, onHoldAll, onNavigate }: {
  item: NotificationItem;
  busy: boolean;
  onHoldAll: (allocationId: string) => void;
  onNavigate: () => void;
}): React.JSX.Element | null {
  const event = item.takeEvent;
  if (event === undefined || !('strategyId' in item.context)) return null;
  const resolved = item.resolvedAt !== null;
  const name = <span className="font-medium">{event.strategyName}</span>;
  const symbol = <span className="font-medium">{event.symbol}</span>;
  const muted = (text: string): React.JSX.Element => <span className="text-muted-foreground">{text}</span>;
  const text = (() => {
    if(event.venue==='coinbase')return <>{name}{muted(` · ${event.detail??item.body}`)}</>;
    switch (event.event) {
      case 'strategy_archived':
        return <>{muted('You archived ')}{name}{muted(event.detail === 'failed' ? ' · the sell failed; decide again' : ' · hold or sell its positions')}</>;
      case 'close_failed':
        return <>{muted('Closing ')}{name}{muted(' did not go through. Retry or choose again.')}</>;
      case 'cash_shortfall':
        return <>{muted('Cash your ')}{name}{muted(' investment held has left your Robinhood account. It is paused until you keep following, close it, or add the money back.')}</>;
      case 'outside_sale':
        return <>{muted('A sale of ')}{symbol}{muted(' in Robinhood included shares your ')}{name}{muted(' investment held. It is paused until you choose to keep following or close it.')}</>;
      case 'take_overspent':
        return <>{name}{muted(' spent more cash than it held. Cover the difference or close it.')}</>;
      case 'order_unknown':
        return <>{muted('Robinhood did not confirm or refuse an order for ')}{symbol}{muted(' in ')}{name}{muted('. Check Robinhood, then clear it if it is not there.')}</>;
      case 'holding_not_bought':
        return <>{symbol}{muted(' could not be bought for your ')}{name}{muted(' investment, so that share of your money is waiting as cash. It keeps trying; open it to retry now or close out.')}</>;
      case 'missing_evidence':
        return <>{muted('A ')}{symbol}{muted(' fill could not be matched to ')}{name}{muted(', so it is paused until it is. It retries on each sync.')}</>;
      case 'symbol_delisted':
        return <>{symbol}{muted(' no longer trades. ')}{name}{muted(' released it at its last price; check your account for what you received.')}</>;
    }
  })();
  const deciding = event.event === 'strategy_archived' && event.venue!=='coinbase' && !resolved;
  return (
    <NotificationRow occurredAt={item.occurredAt} tone={resolved?'neutral':'attention'} attention={!resolved&&item.requiresAction}>
      <Link to="/strategies/$strategyId" params={{ strategyId: item.context.strategyId }} onClick={onNavigate} className="block text-left">
        <span className="block font-medium">{item.title}</span><span className="mt-1 block text-muted-foreground">{text}{resolved?' · Resolved':''}</span>
        {item.account&&<NotificationAccount {...item.account}/>}
      </Link>
      {deciding && (
        <span className="mt-2 flex gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onHoldAll(event.allocationId)}>Hold all</Button>
          <Button size="sm" disabled={busy} onClick={() => { onNavigate(); setArchivePromptOpen(true); }}>Choose…</Button>
        </span>
      )}
    </NotificationRow>
  );
}
