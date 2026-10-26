import {Link} from '@tanstack/react-router';
import {ArrowUpRight} from 'lucide-react';
import type {StrategyInstrument} from '../../../shared/strategies';

/** Separate from the notes toggle so navigation never nests interactive controls. */
export function InstrumentMarketLink({instrument}:{instrument:StrategyInstrument}){
 const props={className:'shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  'aria-label':`Open ${instrument.symbol} ${instrument.market?.kind==='crypto'||instrument.venue==='coinbase'?'crypto ':''}market on ${instrument.venue==='robinhood'?'Robinhood':'Coinbase'}`,title:'Open market'};
 const icon=<ArrowUpRight size={15} aria-hidden="true"/>;
 if(instrument.market)return <Link {...props} to="/markets/$market" params={{market:JSON.stringify({identity:instrument.market,symbol:instrument.symbol,name:instrument.symbol,venueLabel:instrument.venue==='robinhood'?'Robinhood':'Coinbase',typeLabel:'Crypto'})}}>{icon}</Link>;
 if(instrument.venue==='robinhood')return <Link {...props} to="/rh/$symbol" params={{symbol:instrument.symbol}}>{icon}</Link>;
 if(instrument.venue==='coinbase')return <Link {...props} to="/coinbase/$product" params={{product:instrument.symbol.includes('-')?instrument.symbol:`${instrument.symbol}-USD`}}>{icon}</Link>;
 return null;
}
