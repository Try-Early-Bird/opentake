import type {StrategyInstrument} from './strategies';
export interface AllocationRow extends StrategyInstrument {weight:string;reason:string}
/** Preserve provider identity when editing weights or notes. */
export const rowInstrument=({venue,symbol,market}:AllocationRow):StrategyInstrument=>({venue,symbol,...(market?{market}: {})});
export function percentToBps(text: string): number | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(text.trim())) return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** Two-decimal percent text for a basis-point count. */
export function bpsToPercentText(bps: number): string {
  const text = (bps / 100).toFixed(2);
  return text.replace(/\.?0+$/u, '');
}
export function canonicalSymbol(text: string, venue='robinhood'): string {
  const symbol=text.trim().toUpperCase();return venue==='robinhood'?symbol.replace(/[-/]([A-Z])$/u, '.$1'):symbol;
}

/**
 * Maps a table (CSV or spreadsheet rows, header first) to holdings. The
 * symbol column is the first header matching ticker/symbol; the weight column
 * the first matching weight/allocation/target/percent. Without a weight
 * column, weights are left blank for the author to fill.
 */
export function parseHoldingsTable(rows: readonly string[][], venue='robinhood'): { symbol: string; weight: string | null }[] {
  const headerIndex = rows.findIndex((row) => row.some((cell) => /^(ticker|symbol|ticker symbol)$/iu.test(cell.trim())));
  if (headerIndex < 0) {
    // No header: treat it as a pasted list, one entry per row.
    return parseHoldingsList(rows.map((row) => row.join(' ')).join('\n'),venue);
  }
  const header = rows[headerIndex]!.map((cell) => cell.trim().toLowerCase());
  const symbolColumn = header.findIndex((cell) => /^(ticker|symbol|ticker symbol)$/u.test(cell));
  const weightColumn = header.findIndex((cell) => /weight|allocation|target|percent|%/u.test(cell));
  const out = new Map<string, string | null>();
  for (const row of rows.slice(headerIndex + 1)) {
    const symbolText = (row[symbolColumn] ?? '').trim();
    if (!/^[A-Za-z][A-Za-z0-9.\-/]{0,15}$/u.test(symbolText)) continue;
    const symbol = canonicalSymbol(symbolText,venue);
    const weightText = weightColumn < 0 ? '' : (row[weightColumn] ?? '').trim().replace(/%$/u, '').replace(/,/gu, '');
    const weight = /^\d{1,3}(\.\d+)?$/u.test(weightText) ? (Math.round(Number(weightText) * 100) / 100).toString() : null;
    if (!out.has(symbol)) out.set(symbol, weight);
  }
  return [...out].map(([symbol, weight]) => ({ symbol, weight }));
}

/** Basis points the holdings must fill once cash is set aside; 0 when cash is not a valid percent. */
export function investableBps(cash: string): number {
  const cashBps = percentToBps(cash);
  return cashBps === null ? 10_000 : Math.max(0, 10_000 - cashBps);
}

/** Scales weights so they total exactly `targetBps`, keeping proportions; the rounding remainder goes to the largest. */
export function scaleWeightsTo(rows: readonly AllocationRow[], targetBps: number): AllocationRow[] {
  const bps = rows.map((row) => Math.max(0, Math.round(weightOf(row) * 100)));
  const total = bps.reduce((sum, value) => sum + value, 0);
  if (total === 0) return [...rows];
  const scaled = bps.map((value) => Math.floor((value * targetBps) / total));
  const remainder = targetBps - scaled.reduce((sum, value) => sum + value, 0);
  const largest = scaled.indexOf(Math.max(...scaled));
  scaled[largest] = (scaled[largest] ?? 0) + remainder;
  return rows.map((row, index) => ({ ...row, weight: bpsToPercentText(scaled[index] ?? 0) }));
}

/**
 * Raises every holding below `floorBps` to it, taking the difference from the
 * holdings above it in proportion to how far each sits above the floor, so none
 * of them falls under it. The total stays exact (the rounding remainder comes off
 * the largest). Null when every holding at the floor would not fit the total.
 */
export function raiseSmallestTo<T extends { bps: number }>(weights: readonly T[], floorBps: number): T[] | null {
  const total = weights.reduce((sum, w) => sum + w.bps, 0);
  if (weights.length === 0 || floorBps * weights.length > total) return null;
  const need = weights.reduce((sum, w) => sum + Math.max(0, floorBps - w.bps), 0);
  const excess = weights.reduce((sum, w) => sum + Math.max(0, w.bps - floorBps), 0);
  const next = weights.map((w) => ({ ...w, bps: w.bps < floorBps ? floorBps : w.bps - (need ? Math.floor((need * (w.bps - floorBps)) / excess) : 0) }));
  const largest = next.reduce((best, w, index) => (w.bps > next[best]!.bps ? index : best), 0);
  next[largest] = { ...next[largest]!, bps: next[largest]!.bps + total - next.reduce((sum, w) => sum + w.bps, 0) };
  return next;
}

/**
 * Gives every row the same share of `targetBps`. The remainder that an even
 * split leaves (at most rows − 1 basis points) goes one point each to the
 * first rows, so the weights land on the target exactly.
 */
export function splitWeightsEvenly(rows: readonly AllocationRow[], targetBps: number): AllocationRow[] {
  if (rows.length === 0) return [];
  const each = Math.floor(targetBps / rows.length);
  const extra = targetBps - each * rows.length;
  return rows.map((row, index) => ({ ...row, weight: bpsToPercentText(each + (index < extra ? 1 : 0)) }));
}

/**
 * Parses a pasted holdings list. Accepts one entry per line or comma, as
 * "AAPL 12.5", "AAPL,12.5", "AAPL: 12.5%", "AAPL\t12.5", or just "AAPL".
 * Duplicate symbols keep the first weight. Weights are optional.
 */
export function parseHoldingsList(text: string, venue='robinhood'): { symbol: string; weight: string | null }[] {
  const out = new Map<string, string | null>();
  for (const raw of text.split(/[\n;]+/u)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/[\s,:\t]+/u).filter((part) => part !== '');
    if (parts.length === 0) continue;
    // "12.5 AAPL" is as common as "AAPL 12.5".
    const symbolFirst = /^[A-Za-z][A-Za-z0-9.\-/]{0,15}$/u.test(parts[0]!);
    const symbolPart = symbolFirst ? parts[0]! : parts[1];
    const weightPart = symbolFirst ? parts[1] : parts[0];
    if (symbolPart === undefined || !/^[A-Za-z][A-Za-z0-9.\-/]{0,15}$/u.test(symbolPart)) continue;
    const symbol = canonicalSymbol(symbolPart,venue);
    const weight = weightPart === undefined ? null : weightPart.replace(/%$/u, '');
    if (!out.has(symbol)) out.set(symbol, weight !== null && /^\d{1,3}(\.\d{1,2})?$/u.test(weight) ? weight : null);
  }
  return [...out].map(([symbol, weight]) => ({ symbol, weight }));
}

export function weightOf(row: AllocationRow): number {
  const parsed = Number(row.weight);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function allocationTotal(rows: readonly AllocationRow[], cash: string): number {
  const cashValue = Number(cash);
  return rows.reduce((sum, row) => sum + weightOf(row), Number.isFinite(cashValue) ? cashValue : 0);
}


/** CSV/TSV rows, including quoted separators and escaped quotes. */
export function parseDelimitedHoldings(text:string):string[][] {
 const separator=text.split(/\r?\n/u,1)[0].includes('\t')?'\t':',';
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
  else if(!quoted&&(c===separator||c==='\n')){row.push(cell);cell='';if(c==='\n'){rows.push(row);row=[];}}
  else if(c!=='\r')cell+=c;
 }
 if(quoted)throw new Error('Unclosed quote in holdings file.');
 if(cell||row.length){row.push(cell);rows.push(row);}return rows;
}
