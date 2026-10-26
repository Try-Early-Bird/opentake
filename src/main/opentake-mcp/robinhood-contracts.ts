import { z } from "zod";

// Robinhood argument contracts. Only explicitly registered read tools
// are enabled by catalog.ts; these definitions never authorize execution.

const symbol = z.string().trim().min(1).max(16).transform((value) => value.toUpperCase());
const uuid = z.uuid();
const isoInstant = z.union([z.iso.datetime(), z.iso.date()]);
const cursor = z.string().min(1).max(4_096);
const shortText = z.string().trim().min(1).max(256);
const bounds = z.enum(["regular", "24_5", "24_7"]);
const interval = z.enum([
  "5second", "15second", "1minute", "5minute", "10minute", "15minute",
  "30minute", "1hour", "4hour", "1day", "1week", "1month",
]);
const jsonValue: z.ZodType<unknown> = z.unknown();

export type RobinhoodToolAccountScope = "none" | "account_number" | "rhs_account_number";

export interface RobinhoodToolSpec<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  access: "read" | "write";
  /** Which account identifier the runtime injects, if any. */
  account: RobinhoodToolAccountScope;
  /** Writes that act on the brokerage account need `agentic_allowed`. */
  requireAgentic: boolean;
  /** Irreversible actions require an explicit `confirm: true` in the body. */
  confirm: boolean;
  /** Snapshot resources to resync after the call succeeds. */
  resync: ReadonlyArray<
    "robinhood_portfolio" | "robinhood_equity_positions" | "robinhood_option_positions"
    | "robinhood_equity_orders" | "robinhood_option_orders"
  >;
  arguments: Schema;
}

type ReadSpec<Schema extends z.ZodTypeAny, Account extends RobinhoodToolAccountScope> = {
  access: "read";
  account: Account;
  requireAgentic: false;
  confirm: false;
  resync: readonly [];
  arguments: Schema;
};

function read<Schema extends z.ZodTypeAny, Account extends RobinhoodToolAccountScope = "none">(
  arguments_: Schema,
  account?: Account,
): ReadSpec<Schema, Account> {
  return {
    access: "read",
    account: (account ?? "none") as Account,
    requireAgentic: false,
    confirm: false,
    resync: [],
    arguments: arguments_,
  };
}

type WriteDefaults = {
  account: "none";
  requireAgentic: false;
  confirm: false;
  resync: readonly [];
};

type WriteSpec<
  Schema extends z.ZodTypeAny,
  Options extends Partial<Omit<RobinhoodToolSpec, "access" | "arguments">>,
> = { access: "write"; arguments: Schema } & Omit<WriteDefaults, keyof Options> & Options;

function write<
  Schema extends z.ZodTypeAny,
  const Options extends Partial<Omit<RobinhoodToolSpec, "access" | "arguments">> = {},
>(arguments_: Schema, options?: Options): WriteSpec<Schema, Options> {
  return {
    access: "write",
    account: "none",
    requireAgentic: false,
    confirm: false,
    resync: [],
    ...(options ?? {}),
    arguments: arguments_,
  } as WriteSpec<Schema, Options>;
}

const watchlistItems = z
  .object({
    list_id: shortText,
    symbols: z.array(symbol).min(1).max(100).optional(),
    currency_pair_ids: z.array(uuid).min(1).max(100).optional(),
    index_ids: z.array(uuid).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.symbols, value.currency_pair_ids, value.index_ids].filter((item) => item !== undefined).length === 1,
    "provide exactly one of symbols, currency_pair_ids, or index_ids",
  );

const optionWatchlistItems = z
  .object({
    option_ids: z.array(uuid).min(1).max(100),
    position_type: z.enum(["long", "short"]).optional(),
  })
  .strict();

const scanFilters = z.array(z.record(z.string(), jsonValue)).max(100);
const scanColumns = z.array(z.record(z.string(), jsonValue)).max(100);

export const robinhoodToolSpecs = {
  // Search & instrument resolution
  search: read(
    z.object({
      query: z.string().trim().min(1).max(256),
      asset_type: z.enum(["instrument", "currency_pair", "market_index"]).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }).strict(),
  ),

  // Verified against provider tool metadata captured 2026-10-14. Crypto account
  // reads require fresh same-row numeric RHS identity binding in the transport.
  get_currency_pairs: read(z.object({
    cursor: cursor.optional(), limit: z.number().int().min(1).max(700).optional(),
  }).strict()),
  get_crypto_quotes: read(z.object({
    symbols: z.array(symbol).min(1).max(20),
    timezone: z.string().max(100).refine(value => {
      if (value !== 'UTC' && !value.includes('/')) return false;
      try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
      catch { return false; }
    }, 'Invalid timezone').optional(),
  }).strict()),

  get_crypto_positions: read(z.object({ cursor: cursor.optional() }).strict(), 'rhs_account_number'),
  get_crypto_orders: read(z.object({
    order_id: uuid.optional(), cursor: cursor.optional(),
    state: z.enum(['queued', 'confirmed', 'partially_filled', 'filled', 'canceled', 'rejected', 'failed', 'voided']).optional(),
    state_group: z.enum(['open', 'closed']).optional(), side: z.enum(['buy', 'sell']).optional(),
    symbol: symbol.optional(), created_at_gte: z.iso.datetime().optional(), updated_at_gte: z.iso.datetime().optional(),
  }).strict().refine(value => !(value.state && value.state_group), 'Choose state or state_group'), 'rhs_account_number'),

  // Equity market data
  get_equity_price_book: read(
    z.object({ symbols: z.array(symbol).min(1).max(4) }).strict(),
  ),
  get_equity_technical_indicators: read(
    z.object({
      symbol,
      type: z.enum([
        "ema", "sma", "rsi", "momentum", "roc", "cci", "williams_r", "atr", "mfi", "adx",
        "donchian_channels", "bollinger_bands", "macd", "keltner_channels", "supertrend",
        "vwap", "obv", "pivot_points",
      ]),
      interval,
      start_time: isoInstant,
      end_time: isoInstant.optional(),
      period: z.number().int().positive().max(1_000).optional(),
      num_std: z.number().finite().positive().optional(),
      fast_period: z.number().int().positive().max(1_000).optional(),
      slow_period: z.number().int().positive().max(1_000).optional(),
      signal_period: z.number().int().positive().max(1_000).optional(),
      multiplier: z.number().finite().positive().optional(),
      method: z.string().trim().min(1).max(32).optional(),
      bounds: bounds.optional(),
      adjustment_type: z.string().trim().min(1).max(32).optional(),
      output: z.string().regex(/^(series|latest|last:[1-9][0-9]{0,3})$/u).optional(),
    }).strict(),
  ),

  // Fundamentals & earnings
  get_equity_fundamentals: read(
    z.object({ symbols: z.array(symbol).min(1).max(10), bounds: bounds.optional() }).strict(),
  ),
  get_financials: read(
    z.object({
      symbols: z.array(symbol).min(1).max(20),
      period: z.enum(["quarterly", "annual"]).optional(),
      limit: z.number().int().min(1).max(40).optional(),
    }).strict(),
  ),
  get_earnings_results: read(z.object({ symbol }).strict()),
  get_earnings_calendar: read(
    z.object({
      start_date: z.iso.date().optional(),
      days: z.number().int().min(-31).max(31).refine((value) => value !== 0, "days must be non-zero").optional(),
      filter: z.enum(["high_market_cap"]).optional(),
    }).strict(),
  ),

  // Positions, lots & P&L
  get_equity_tax_lots: read(
    z.object({ symbol, cursor: cursor.optional() }).strict(),
    "account_number",
  ),
  get_realized_pnl: read(
    z.object({
      span: z.enum(["day", "week", "month", "3month", "year", "all"]).optional(),
      start_date: z.iso.date().optional(),
      end_date: z.iso.date().optional(),
      asset_classes: z.array(z.enum(["equity", "option", "crypto"])).min(1).optional(),
      timezone: z.string().trim().min(1).max(64).optional(),
      display_currency: z.string().trim().length(3).optional(),
    }).strict().refine(
      (value) => !(value.span !== undefined && (value.start_date !== undefined || value.end_date !== undefined)),
      "span is mutually exclusive with start_date/end_date",
    ),
    "rhs_account_number",
  ),
  get_pnl_trade_history: read(
    z.object({
      span: z.enum(["week", "month", "3month", "ytd", "all"]).optional(),
      symbol: symbol.optional(),
      cursor: cursor.optional(),
    }).strict(),
    "rhs_account_number",
  ),

  // Options — data & exercise
  get_option_historicals: read(
    z.object({
      instrument_ids: z.array(uuid).min(1).max(10),
      start_time: isoInstant,
      end_time: isoInstant.optional(),
      interval: interval.optional(),
      bounds: bounds.optional(),
    }).strict(),
  ),
  exercise_option: write(
    z.object({
      option_id: uuid,
      quantity: z.number().int().positive(),
      allow_shorts: z.boolean().optional(),
      reason: z.enum([
        "covering_early_assignment", "buying_stocks",
        "not_enough_liquidity_or_spread_too_wide", "hedging_position",
      ]).optional(),
      ref_id: uuid.optional(),
    }).strict(),
    {
      account: "account_number",
      requireAgentic: true,
      confirm: true,
      resync: ["robinhood_portfolio", "robinhood_equity_positions", "robinhood_option_positions"],
    },
  ),
  cancel_option_exercise: write(
    z.object({ option_id: uuid }).strict(),
    {
      account: "account_number",
      requireAgentic: true,
      confirm: true,
      resync: ["robinhood_portfolio", "robinhood_option_positions"],
    },
  ),

  // Indexes
  get_indexes: read(
    z.object({ symbols: z.string().trim().min(1).max(256).optional() }).strict(),
  ),
  get_index_quotes: read(
    z.object({ instrument_ids: z.array(uuid).min(1).max(20) }).strict(),
  ),
  get_index_historicals: read(
    z.object({
      instrument_ids: z.array(uuid).min(1).max(10),
      start_time: isoInstant,
      interval,
      end_time: isoInstant.optional(),
    }).strict(),
  ),

  // Watchlists
  get_watchlists: read(z.object({}).strict()),
  // Membership of one list (object id, type, symbol); no prices. Used by the list mirror.
  get_watchlist_items: read(z.object({ list_id: shortText }).strict()),
  create_watchlist: write(
    z.object({
      display_name: shortText,
      display_description: z.string().trim().max(1_024).optional(),
      icon_emoji: z.string().trim().min(1).max(16).optional(),
    }).strict(),
  ),
  update_watchlist: write(
    z.object({
      list_id: shortText,
      display_name: shortText.optional(),
      icon_emoji: z.string().trim().min(1).max(16).optional(),
      display_description: z.string().trim().max(1_024).optional(),
    }).strict(),
  ),
  add_to_watchlist: write(watchlistItems),
  remove_from_watchlist: write(watchlistItems),
  follow_watchlist: write(z.object({ list_id: shortText }).strict()),
  unfollow_watchlist: write(z.object({ list_id: shortText }).strict()),

  // Options watchlist
  get_option_watchlist: read(z.object({}).strict()),
  add_option_to_watchlist: write(optionWatchlistItems),
  remove_option_from_watchlist: write(optionWatchlistItems),

  // Scanners / screeners
  get_scanner_filter_specs: read(z.object({}).strict()),
  get_scans: read(z.object({}).strict()),
  run_scan: read(z.object({ scan_id: shortText }).strict()),
  create_scan: write(
    z.object({
      filters: scanFilters.optional(),
      columns: scanColumns.optional(),
      preset: z.enum([
        "INITIAL", "DAILY_GAINERS", "DAILY_LOSERS", "HIGH_OPTIONS_VOLUME_IV", "UPCOMING_EARNINGS",
      ]).optional(),
      title: shortText.optional(),
      scan_id: shortText.optional(),
    }).strict(),
  ),
  update_scan_filters: write(
    z.object({ scan_id: shortText, filters: scanFilters }).strict(),
  ),
  update_scan_config: write(
    z.object({
      scan_id: shortText,
      sorting_column: shortText.optional(),
      sorting_direction: z.enum(["asc", "desc"]).optional(),
      columns: scanColumns.optional(),
    }).strict(),
  ),

  // Account upgrades
  get_limited_margin_upgrade_info: read(z.object({}).strict(), "account_number"),
  get_option_level_upgrade_info: read(z.object({}).strict(), "account_number"),
} as const satisfies Record<string, RobinhoodToolSpec>;

export type RobinhoodGenericToolName = keyof typeof robinhoodToolSpecs;

export const robinhoodGenericToolNames = Object.keys(robinhoodToolSpecs) as [
  RobinhoodGenericToolName,
  ...RobinhoodGenericToolName[],
];

export type RobinhoodToolArguments<Name extends RobinhoodGenericToolName> = z.infer<
  (typeof robinhoodToolSpecs)[Name]["arguments"]
>;

/** The only Robinhood writes the app sends outside orders: membership of the
 *  member's own (custom) watchlists, on their explicit action. Agents never get them. */
export const watchlistWriteTools = ['add_to_watchlist', 'remove_from_watchlist'] as const;
export type WatchlistWriteTool = (typeof watchlistWriteTools)[number];

export function robinhoodToolSpec(name: RobinhoodGenericToolName): RobinhoodToolSpec {
  return robinhoodToolSpecs[name];
}
