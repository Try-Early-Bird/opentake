import type {InvestmentVenue} from '../../../shared/investment-venues';
import {CoinbaseCapital} from './CoinbaseCapital';
import {FollowPanel} from './FollowPanel';
type Props={takeId:string;strategyId:string;onChanged:()=>void;onDeposit:()=>void};
/** Venue views reuse their existing holding, order, withdrawal and close
 * components. Funding always returns to the shared multi-account review. */
const panels:Record<InvestmentVenue,(props:Props)=>React.JSX.Element>={
 coinbase:p=><CoinbaseCapital takeId={p.takeId} onChanged={p.onChanged} mixedDeposit={p.onDeposit}/>,
 robinhood:p=><FollowPanel takeId={p.takeId} strategyId={p.strategyId} published minimumAllocation={null} mixedDeposit={p.onDeposit} onChanged={p.onChanged}/>,
};
export function InvestmentVenuePanel({venue,...props}:Props&{venue:InvestmentVenue}){return panels[venue](props);}
