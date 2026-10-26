import { z } from 'zod';
import { managedScanDefinitionSchema } from './managed-scans';
import { robinhoodToolSpecs } from '../opentake-mcp/robinhood-contracts';

// Separate from parseRead and from the trading transport. Never exposed as raw
// tool names to a model; only the host-managed executor supplies IDs and titles.
const operations = ['get_scanner_filter_specs', 'get_scans', 'create_scan', 'update_scan_filters', 'update_scan_config', 'run_scan'] as const;
export type ScanOperation = typeof operations[number];
export function parseScanOperation(name: string, input: unknown) {
  const operation = z.enum(operations).parse(name);
  const args = robinhoodToolSpecs[operation].arguments.parse(input) as Record<string, unknown>;
  // No expression filters, arbitrary columns, presets, or create-as-update path.
  const allowed = operation === 'create_scan' ? ['title', 'filters'] : operation === 'update_scan_config'
    ? ['scan_id', 'sorting_column', 'sorting_direction'] : operation === 'update_scan_filters' ? ['scan_id', 'filters']
    : operation === 'run_scan' ? ['scan_id'] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unsupported managed screener operation.');
  if (operation === 'create_scan' && (!args.title || !Array.isArray(args.filters) || args.filters.length)) throw new Error('Managed creation requires an empty filter set.');
  if (operation === 'update_scan_filters') managedScanDefinitionSchema.shape.filters.parse(args.filters);
  return { operation, args };
}
const inputSchema = z.toJSONSchema(managedScanDefinitionSchema, { io: 'input' }); delete inputSchema.$schema;
export const managedScreenerTool = {
  name: 'robinhood_search_screen', title: 'Search-owned Robinhood screener',
  description: 'Replace filters and sorting on the screener owned by Opentake search, then run it. Creates a saved Robinhood screener on first use. Search only; never edits other screeners or trades. Fetch filter specs first. Provide all conditions and an explicit sorting column; configured scan columns are validated before updates.',
  inputSchema: { ...inputSchema, type: 'object' as const },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
export const screenerSpecsTool = {
  name: 'robinhood_get_scanner_filter_specs',
  description: 'Discover supported Robinhood screener filters. Use exact predicates, values, intervals and lengths. PERCENTAGE values use percent numbers (5 means 5%); do not invent conditions. Sorting must name a configured scan column, such as Market cap.',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
};
export class ScreenerError extends Error {}
