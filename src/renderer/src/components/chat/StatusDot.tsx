/** The small status dot the chat puts before a state line: amber waiting, green done, red failed, grey settled. */
const tones={attention:'bg-attention',success:'bg-success',destructive:'bg-destructive',muted:'bg-muted-foreground/60'} as const;
export type DotTone=keyof typeof tones;
export function StatusDot({tone,className=''}:{tone:DotTone;className?:string}){
 return <span aria-hidden="true" className={`inline-block size-1.5 shrink-0 rounded-full ${tones[tone]} ${className}`}/>;
}
