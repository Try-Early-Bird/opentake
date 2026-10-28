export const coinbaseMessages = {
  orders_pending: 'This portfolio has reserved or unresolved orders. Cancel unused reservations and let submitted orders reconcile before disconnecting.',
  invalid_key: 'Choose a downloaded Coinbase ECDSA API-key JSON file.',
  storage_locked: 'Reconnect this Coinbase account to keep using it.',
  permissions: 'Use a key with View enabled and Transfer disabled. Enable Trade for View + Trade, or choose View only.',
  scope: 'The key must identify one readable Coinbase spot portfolio. Check the selected portfolio in Coinbase.',
  duplicate: 'This Coinbase portfolio is already connected. Use Replace key on that connection.',
  wrong_account: 'The replacement key belongs to another portfolio. Add it as a separate account.',
  unavailable: 'This Coinbase connection is unavailable. Refresh the connection list.',
  contract: 'The Coinbase tool contract is not supported by this app version.',
  authentication: 'Coinbase rejected this key or its access. Replace the key after checking permissions.',
  provider: 'Coinbase could not be reached or returned an incomplete response. Try refreshing later.',
  runtime: 'The bundled Coinbase connection could not start. Restart the app or reinstall this version.',
  busy: 'Another Coinbase connection operation is running.',
  timeout: 'Coinbase operation timed out. Refresh to check its status before trying again.',
  cancelled: 'Coinbase connection cancelled.',
} as const;
export class CoinbaseError extends Error {
  constructor(public code: keyof typeof coinbaseMessages, public detail?:string) { super(coinbaseMessages[code]); }
}
export function coinbaseError(error: unknown): CoinbaseError {
  return error instanceof CoinbaseError ? error : new CoinbaseError('provider');
}
