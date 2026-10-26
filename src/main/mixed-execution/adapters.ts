import type {MixedVenue} from '../../shared/mixed-execution';
import type {Database,InvestmentDependencies,InvestmentVenueAdapter} from './contracts';
import {createCoinbaseInvestmentAdapter} from './coinbase-adapter';
import {createRobinhoodInvestmentAdapter} from './robinhood-adapter';
/** Adding a supported venue requires the complete lifecycle contract, not a
 * second coordinator or a bypass around shared funding/recovery checks. */
export function investmentVenueAdapters(database:Database,deps:InvestmentDependencies):Record<MixedVenue,InvestmentVenueAdapter>{
 return {coinbase:createCoinbaseInvestmentAdapter(database,deps),robinhood:createRobinhoodInvestmentAdapter(database,deps)};
}
