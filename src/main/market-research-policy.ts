import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { RobinhoodToolDefinition } from '../shared/connections';

export function dynamicReadArguments(name: string, input: unknown): Record<string, unknown> {
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) throw new Error('Invalid tool name');
  const args = z.record(z.string(), z.unknown()).parse(input);
  if (Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error('Tool arguments too large');
  if (/account[_-]?(number|id|ref)|rhs[_-]?account/iu.test(JSON.stringify(args))) throw new Error('Tool requires an account mapping');
  return args;
}
export function validateDiscoveredRead(tool: RobinhoodToolDefinition | undefined, args: Record<string, unknown>): void {
  if (tool?.annotations?.readOnlyHint !== true) throw new Error('Tool unavailable or not declared read-only');
  if (/account[_-]?(number|id|ref)|rhs[_-]?account/iu.test(JSON.stringify(tool.inputSchema))) throw new Error('Tool requires an account mapping');
  const validate = new AjvJsonSchemaValidator().getValidator(tool.inputSchema as JsonSchemaType);
  if (!validate(args).valid) throw new Error('Arguments do not match the live tool schema');
}
