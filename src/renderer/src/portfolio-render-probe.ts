import {useLayoutEffect} from 'react';
const enabled=import.meta.env.VITE_PORTFOLIO_RENDER_PROBE==='1';
let pending:{kind:string;range:string;start:number;commit?:number;requestStart?:number;requestEnd?:number;id:number}|undefined;
let sequence=0;
function begin(kind:string,range:string){
 if(!enabled)return;
 pending={kind,range,start:performance.now(),id:++sequence};
 const id=sequence;
 setTimeout(()=>{if(pending?.id===id){console.info('PORTFOLIO_RENDER_PROBE '+JSON.stringify({kind,range,status:'timeout',ms:performance.now()-pending.start}));pending=undefined;}},15000);
}
if(enabled)document.addEventListener('click',event=>{
 const target=event.target instanceof Element?event.target.closest('a'):null;
 if(target&&new URL(target.href,location.href).pathname==='/portfolio'&&location.pathname!=='/portfolio')begin('navigation','1d');
},true);
export async function measurePortfolioSnapshot<T>(read:()=>Promise<T>):Promise<T>{
 const sample=enabled&&pending?.kind==='navigation'?pending:undefined;
 const record=sample&&sample.requestStart===undefined;
 if(record)sample.requestStart=performance.now();
 try{return await read();}
 finally{if(record)sample.requestEnd=performance.now();}
}
export function beginPortfolioRange(range:string){begin('range',range);}
/** Two animation frames after React commit and a nonempty SVG path: a paint
 * opportunity estimate, not compositor presentation or all position-row data. */
export function usePortfolioRenderProbe(range:string,pointCount:number){
 useLayoutEffect(()=>{
  const sample=pending;if(!enabled||!sample||sample.range!==range||pointCount<2)return;
  sample.commit=performance.now();let first=0,second=0,cancelled=false;
  const check=()=>{
   if(cancelled||pending!==sample)return;
   const path=document.querySelector('[aria-label="Portfolio value over time"] .recharts-line-curve');
   if(!path?.getAttribute('d')){first=requestAnimationFrame(check);return;}
   second=requestAnimationFrame(()=>{
    if(cancelled||pending!==sample)return;
    console.info('PORTFOLIO_RENDER_PROBE '+JSON.stringify({kind:sample.kind,range,status:'ok',ms:performance.now()-sample.start,commitMs:sample.commit!-sample.start,points:pointCount,requestStartMs:sample.requestStart===undefined?undefined:sample.requestStart-sample.start,requestEndMs:sample.requestEnd===undefined?undefined:sample.requestEnd-sample.start}));
    pending=undefined;
   });
  };
  first=requestAnimationFrame(check);
  return()=>{cancelled=true;cancelAnimationFrame(first);cancelAnimationFrame(second);};
 },[range,pointCount]);
}
