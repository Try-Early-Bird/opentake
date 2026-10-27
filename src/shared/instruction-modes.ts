export interface ModeConfig {
 description: string;
 guidance: string;
 details: string;
 completion: string;
 /** null inherits globally available tools; an empty array permits none. */
 tools: string[] | null;
}
export const emptyModeConfig: ModeConfig = { description:'', guidance:'', details:'', completion:'', tools:null };
/** The conversation fields Opentake ships a default for on General. */
export type ModeFlow = Pick<ModeConfig,'guidance'|'details'|'completion'>;
const flowFields = ['guidance','details','completion'] as const;
/** General's empty conversation fields use the shipped default, so default updates reach them. */
export function withDefaultFlow(config:ModeConfig, flow:ModeFlow):ModeConfig {
 return {...config,...Object.fromEntries(flowFields.map(key=>[key,config[key].trim()?config[key]:flow[key]]))};
}
/** Stores a field equal to the shipped default as empty, so it keeps following the default. */
export function withoutDefaultFlow(config:ModeConfig, flow:ModeFlow):ModeConfig {
 return {...config,...Object.fromEntries(flowFields.map(key=>[key,config[key].trim()===flow[key].trim()?'':config[key]]))};
}
export function modePrompt(text:string, config:ModeConfig):string {
 return [text,config.guidance&&`Conversation guidance\n${config.guidance}`,config.details&&`Details to clarify when relevant\n${config.details}`,config.completion&&`When to finish\n${config.completion}`].filter(Boolean).join('\n\n');
}
/** followsDefault: the built-in General set resolves to the shipped default at run time. */
export interface PublishedMode { name:string; text:string; config:ModeConfig; version:number; publishedAt:string; followsDefault?:boolean }
export interface InstructionLabel { id:string; name:string; version:number }
/** The exact system prompt for a run; Settings previews use the same function. */
export function composeInstructions(required:string, about:string, instructions:string):string {
 return [`<opentake_requirements>\n${required}\n</opentake_requirements>`,about.trim()&&`<about_user>\n${about.trim()}\n</about_user>`,instructions.trim()&&`<instructions>\n${instructions.trim()}\n</instructions>`].filter(Boolean).join('\n\n');
}
