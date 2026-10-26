import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {test,expect} from 'vitest';
import {ReducePositionsForm} from '../../src/renderer/src/strategies/ReducePositionsForm';
const props={amount:'20',onAmountChange:()=>{},currency:'USD',band:{minimumAmount:'2',maximumAmount:'198',possible:true,holdingsValue:'200'},preview:{ok:true,legs:[{symbol:'BTC',notional:'20'}],remainingValue:'180',reasons:[]},busy:false,onCancel:()=>{},onConfirm:()=>{}};
const render=(extra:Partial<Parameters<typeof ReducePositionsForm>[0]>={})=>renderToStaticMarkup(createElement(ReducePositionsForm,{...props,...extra}));
const confirm=(html:string)=>html.match(/<button[^>]*>Take out[^<]*<\/button>/)?.[0];
test('shared reduction form shows the limits, sales and remaining investment for equities',()=>{
 const html=render();for(const text of ['Minimum $2.00','Max $198.00','25%','50%','This sells','$180.00 stays invested'])expect(html).toContain(text);
 expect(confirm(html)).not.toContain('disabled=""');
});
test('crypto reduction formats USDC and provider fee-adjusted proceeds',()=>{
 const html=render({currency:'USDC',preview:{...props.preview,fees:'1',estimatedProceeds:'19'}});
 for(const text of ['2.00 USDC','Fees ≈ 1.00 USDC','19.00 ','180.00 USDC stays invested'])expect(html).toContain(text);
});
test('missing, loading, impossible and failed previews never enable confirmation',()=>{
 for(const extra of [{preview:null},{loading:true},{band:null},{band:{...props.band,possible:false}},{error:'Unavailable'},{preview:{...props.preview,ok:false}},{amount:'..'}])expect(confirm(render(extra))).toContain('disabled=""');
});
