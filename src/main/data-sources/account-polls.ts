import type {ManagedPollId,ManagedPollSetting} from '../../shared/managed-polls';
export function createAccountPollGate(settings:{list(accountId:string):Promise<ManagedPollSetting[]>},clock=Date.now){
 const checks=new Map<string,number>();
 return {
  async due(id:ManagedPollId,accountId:string){
   const setting=(await settings.list(accountId)).find(item=>item.id===id&&item.accountId===accountId);
   if(!setting||setting.collection==='off')return false;
   const key=accountId+':'+id,now=clock(),last=checks.get(key);
   if(last!==undefined&&now>=last&&now-last<setting.intervalMs)return false;
   if(checks.size>=1024&&!checks.has(key))checks.delete(checks.keys().next().value!);
   checks.set(key,now);return true;
  },
  changed(id:ManagedPollId,accountId:string){checks.delete(accountId+':'+id);},
 };
}
