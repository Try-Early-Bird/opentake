/** Supported investment venues. New connectors must register an execution
 * adapter and renderer panel before being added here; schema allowlists must
 * be expanded with an append-only migration. */
export const investmentVenues={
 coinbase:{label:'Coinbase',currencies:['USDC','USD'],defaultCurrency:'USDC'},
 robinhood:{label:'Robinhood',currencies:['USD'],defaultCurrency:'USD'},
} as const;
export type InvestmentVenue=keyof typeof investmentVenues;
