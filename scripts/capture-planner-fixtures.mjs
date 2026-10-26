// Optional reference capture; ordinary OSS tests use the checked-in fixture only.
// Usage: node scripts/capture-planner-fixtures.mjs /absolute/path/to/target-sizing.ts
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
const source = readFileSync(process.argv[2], 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
if (sha256 !== '4d34fadcffaa146725e6fa716c807bbd80214ebb609f87f58a4c094761d0e721') throw new Error('Reference baseline changed; review before recapturing');
const exports = {};
runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, {exports});
const base = {symbol:'VTI',targetWeightPercent:50,bucketValueUsd:'100',currentInstrumentValueUsd:'0',currentQuantity:'0',availableCashUsd:'100',markPriceUsd:'10',maximumOrderNotionalUsd:'1000'};
const variations = [
 ['fractional buy',{}], ['cent flooring',{bucketValueUsd:'100.01',targetWeightPercent:33.33}],
 ['below minimum',{bucketValueUsd:'1'}], ['exact minimum',{bucketValueUsd:'2'}],
 ['threshold',{currentInstrumentValueUsd:'49.9'}], ['no cash',{availableCashUsd:'0'}],
 ['cash capped',{availableCashUsd:'10',capBuyToCash:true}], ['notional cap',{maximumOrderNotionalUsd:'20'}],
 ['partial sell',{currentInstrumentValueUsd:'70',currentQuantity:'7'}],
 ['sell no mark',{currentInstrumentValueUsd:'70',currentQuantity:'7',markPriceUsd:null}],
 ['sell no quantity',{currentInstrumentValueUsd:'70'}],
 ['sell headroom',{currentInstrumentValueUsd:'51.01',currentQuantity:'5.101'}],
 ['exit dust',{targetWeightPercent:0,currentInstrumentValueUsd:'12.3456789',currentQuantity:'1.23456789'}],
 ['basis point weight',{targetWeightPercent:0.01,bucketValueUsd:'100000',availableCashUsd:'100000',rebalanceThresholdBps:0}],
 ['explicit venue minimum',{bucketValueUsd:'8',minimumOrderNotionalUsd:'5'}],
];
const sizing = variations.map(([name,overrides]) => {const input={...base,...overrides};return {name,input,expected:exports.sizeTargetAllocation(input)};});
const conservation = [
 {orders:[{symbol:'VTI',dollarAmount:'33.33'},{symbol:'BND',dollarAmount:'33.33'},{symbol:'VXUS',dollarAmount:'33.33'}],intended:'100',cash:'100'},
 {orders:[{symbol:'VTI',dollarAmount:'10'}],intended:'20',cash:'10'},
 {orders:[],intended:'100',cash:'100'},
].map(input=>({...input,expected:exports.conserveRequestedNotionals(input.orders,input.intended,input.cash)}));
writeFileSync(new URL('../tests/fixtures/planning/hosted-sizing.json',import.meta.url), JSON.stringify({commit:'e8969265fe29fdafe34fce1f99022485b332de0a',sha256,sizing,conservation},null,2)+'\n');
