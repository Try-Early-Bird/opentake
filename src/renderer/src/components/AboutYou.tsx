import { useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';

export function AboutYou() {
 const [initial,setInitial]=useState<string>();const [error,setError]=useState('');
 async function load(){try{const config=await window.takes.instructions();setInitial(config.about);setError('');}catch{setError('Could not load About you.');}}
 useEffect(()=>{void load();},[]);
 if(initial===undefined)return error?<p role="alert" className="text-sm text-destructive">{error} <button className="underline" onClick={()=>void load()}>Retry</button></p>:<p className="text-sm text-muted-foreground">Loading About you…</p>;
 return <AboutYouEditor initial={initial}/>;
}

function AboutYouEditor({initial}:{initial:string}) {
 const [text,setText]=useState(initial);const latest=useRef(text);latest.current=text;
 const saved=useRef(initial);const queue=useRef(Promise.resolve());const [status,setStatus]=useState('');const [error,setError]=useState('');
 function save(){const value=latest.current;const task=queue.current.catch(()=>{}).then(async()=>{
  if(value===saved.current)return;setStatus('Saving…');setError('');
  try{await window.takes.saveAbout(value);saved.current=value;setStatus('Saved');}
  catch{setStatus('Not saved');setError('Could not save About you. Retry before leaving.');throw new Error('Could not save About you. Retry before leaving.');}
 });queue.current=task;return task;}
 useBlocker({shouldBlockFn:async()=>{try{await save();return false;}catch{return true;}},enableBeforeUnload:false});
 useEffect(()=>{const timer=setTimeout(()=>void save().catch(()=>{}),500);return()=>clearTimeout(timer);},[text]);
 useEffect(()=>()=>{void save().catch(()=>{});},[]);
 return <div><div className="flex items-start justify-between gap-3"><div><h3 className="flex items-baseline gap-2 text-sm font-semibold">About you <span className="text-xs font-normal text-muted-foreground">Optional</span></h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Shared with the AI in every chat. Changes save automatically and apply from your next message.</p></div><span className="text-xs text-muted-foreground" aria-live="polite">{status}</span></div><textarea aria-label="About you" className="mt-4 min-h-28 w-full resize-y rounded-2xl border border-border/50 bg-background/20 p-4 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring" maxLength={6000} value={text} placeholder="Describe yourself and how you invest: goals, time horizon, risk tolerance, what you hold, and what you want from Opentake." onChange={e=>setText(e.target.value)} onBlur={()=>void save().catch(()=>{})}/>{error&&<p role="alert" className="mt-2 text-sm text-destructive">{error} <button className="underline" onClick={()=>void save().catch(()=>{})}>Retry About you</button></p>}</div>;
}
