import {expect,test} from 'vitest';
import {reconcileCoinbaseHistory} from '../../src/main/coinbase/reconciliation';
test('reconciliation distinguishes ledger deltas from wallet/portfolio precision and preserves currency',()=>{
 const h={state:'complete' as const,reason:null,walletCount:2,completedWallets:2,
 wallets:[{wallet:'private-id',asset:'BTC',available:'0.123456789123456789',held:'0.01'},{wallet:'private-usdc',asset:'USDC',available:'10',held:'0'}],
 transactions:[{id:'private-tx',wallet:'private-id',asset:'BTC',amount:'0.14',status:'completed',type:'receive',occurredAt:'2026-10-01T00:00:00Z'},{id:'private-tx-2',wallet:'private-id',asset:'BTC',amount:'-0.006543210876543211',status:'completed',type:'send',occurredAt:'2026-10-02T00:00:00Z'}]};
 const positions=[{asset:'BTC',quantity:'0.1334567891234568',instrumentRef:'coinbase:BTC',marketValue:'100',availableValue:null,currency:'USD',isCash:false}];
 const rows=reconcileCoinbaseHistory(h,positions);
 expect(rows[0]).toMatchObject({asset:'BTC',ledgerQuantity:'0.133456789123456789',walletQuantity:'0.133456789123456789',portfolioQuantity:'0.1334567891234568',difference:'0.000000000000000011'});
 expect(rows[1]).toMatchObject({asset:'USDC',walletQuantity:'10'});
 expect(JSON.stringify(rows)).not.toContain('private-');
 expect(rows[0].types.map(t=>t.quantity)).toEqual(['0.14','-0.006543210876543211']);
});
