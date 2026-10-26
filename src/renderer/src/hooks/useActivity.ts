import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityItem } from '../components/ActivityRows';
import type {PortfolioActivityCursor,PortfolioView} from '../../../shared/portfolio';
import { portfolioActivity } from '../portfolio/local-adapter';
export function useActivity() {
 const [items,setItems]=useState<ActivityItem[]|null>(null),[status,setStatus]=useState<number|null>(null);
 const [currency,setCurrency]=useState('USD'),[hasMore,setHasMore]=useState(false),[loadingMore,setLoadingMore]=useState(false),[error,setError]=useState('');
 const view=useRef<PortfolioView|null>(null),cursor=useRef<PortfolioActivityCursor|null>(null),busy=useRef(false),generation=useRef(0);
 const loadMore=useCallback(async()=>{
  if(busy.current||!view.current?.account||!cursor.current)return;
  const current=generation.current,base=view.current;busy.current=true;setLoadingMore(true);setError('');
  try{
   const page=await window.portfolio.activity(base.account!.id,cursor.current);
   if(current!==generation.current)return;
   const next=portfolioActivity({...base,...page});
   setItems(old=>{const ids=new Set(old?.map(item=>item.id));return [...old??[],...next.filter(item=>!ids.has(item.id))];});
   cursor.current=page.nextCursor;setHasMore(!!page.nextCursor);
  }catch{if(current===generation.current)setError('Could not load more activity.');}
  finally{if(current===generation.current){busy.current=false;setLoadingMore(false);}}
 },[]);
 useEffect(()=>{
  const current=++generation.current;busy.current=true;
  const load=async()=>{try{
   const base=await window.portfolio.snapshot();
   const page=base.account?await window.portfolio.activity(base.account.id):null;
   if(current!==generation.current)return;
   view.current=base;cursor.current=page?.nextCursor??null;setHasMore(!!page?.nextCursor);
   setItems(page?portfolioActivity({...base,...page}):[]);setCurrency(base.portfolio?.currency??'USD');setStatus(200);
  }catch{if(current===generation.current){setItems([]);setStatus(500);}}
  finally{if(current===generation.current)busy.current=false;}};
  let refreshing=false;
  const refresh=async()=>{
   const base=view.current;if(busy.current||refreshing||!base?.account)return;
   refreshing=true;
   try{const page=await window.portfolio.activity(base.account.id);
    if(current!==generation.current)return;
    const next=portfolioActivity({...base,...page});
    setItems(old=>{const updated=new Map((old??[]).map(item=>[item.id,item]));for(const item of next)updated.set(item.id,item);return [...updated.values()].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.id.localeCompare(a.id));});
   }catch{/* Keep the loaded history while a background refresh is unavailable. */}
   finally{refreshing=false;}
  };
  void load();const timer=setInterval(()=>void refresh(),5000);return()=>{generation.current++;clearInterval(timer);};
 },[]);
 return {items,status,currency,hasMore,loadingMore,error,loadMore};
}
