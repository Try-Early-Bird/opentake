import {expect,test} from 'vitest';
import {positionBasis,type BasisEntry} from '../../src/main/coinbase/position-basis';
const entries:BasisEntry[]=[
 {asset:'BTC',quantity:'2',kind:'fill',cause:'buy'},
 {asset:'USDC',quantity:'-202',kind:'fill',cause:'buy'},
 {asset:'BTC',quantity:'-0.5',kind:'fill',cause:'sell'},
 {asset:'USDC',quantity:'60',kind:'fill',cause:'sell'},
 {asset:'BTC',quantity:'-0.5',kind:'release',cause:'keep'},
];
test('position basis includes buy fees and removes average cost on sells and releases',()=>{
 expect(positionBasis(entries,'BTC','USDC')).toEqual({quantity:'1',cost:'101'});
});
test('position basis stays unknown for another quote or holdings without purchase evidence',()=>{
 expect(positionBasis(entries,'BTC','USD').cost).toBeNull();
 expect(positionBasis([{asset:'BTC',quantity:'1',kind:'capital',cause:'external'}],'BTC','USDC').cost).toBeNull();
});
