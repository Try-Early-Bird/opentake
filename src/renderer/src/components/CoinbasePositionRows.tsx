import {StrategyRow} from './PositionRows';
import {sortedStrategyHoldings} from '../portfolio/strategy-series';
import type {AllocationHistory,PortfolioStrategy} from '../../../shared/portfolio';
import type {PortfolioRange} from '../portfolio-history';
import {useNavigate} from '@tanstack/react-router';
import {HoldingLogo} from './HoldingLogo';
import {cryptoLogo} from '../crypto-logos';
import type {SymbolSeries} from '../../../shared/market-series';
import { isCryptoDust, useHideCryptoDust, useCryptoDustThreshold } from '../crypto-preferences';
import type { CoinbaseSpotPosition } from '../../../shared/portfolio';
import { SeriesRow } from './SeriesRow';
import {assetAmount} from '../portfolio/format';

export function CoinbasePositionRows({ positions,strategies=[],historyByAllocation,range,series,loading=false,accountId }: { positions: CoinbaseSpotPosition[];strategies?:PortfolioStrategy[];historyByAllocation?:ReadonlyMap<string,AllocationHistory>;range:PortfolioRange;accountId?:string;series?:ReadonlyMap<string,SymbolSeries>;loading?:boolean }) {
  const navigate=useNavigate();
  const hideDust=useHideCryptoDust();
  const threshold=useCryptoDustThreshold();
  const visible=hideDust?positions.filter(p=>!isCryptoDust(p.marketValue,p.currency,threshold)):positions;
  if (!visible.length&&!strategies.length) return <p className="p-6 text-center text-sm text-muted-foreground">No visible holdings</p>;
  return <ul className="m-0 list-none p-0">{sortedStrategyHoldings(strategies).map(holding=><StrategyRow key={holding.allocationId} holding={holding} history={historyByAllocation?.get(holding.allocationId)} seriesBySymbol={series??new Map()} range={range} currency="USD" loading={loading} onSelect={()=>void navigate({to:'/strategies/$strategyId',params:{strategyId:holding.strategyId}})}/>)}{visible.map(position => (
    <SeriesRow
      key={position.instrumentRef}
      leading={<HoldingLogo weight={{symbol:position.asset,logoUrl:cryptoLogo(position.asset)}}/>}
      title={position.asset}
      subtitle={assetAmount(position.quantity, position.asset)}
      series={series?.get(position.asset)}
      displayValue={position.marketValue}
      currency={position.currency}
      loading={!position.isCash&&loading}
      onSelect={!position.isCash?()=>void navigate({to:"/coinbase/$product",params:{product:`${position.asset}-${position.currency}`},search:{accountId}}):undefined}
      flush
    />
  ))}</ul>;
}
