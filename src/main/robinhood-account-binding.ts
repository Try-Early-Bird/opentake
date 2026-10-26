import { createHash } from 'node:crypto';
import { z } from 'zod';

const account = z.object({ account_number: z.string().min(1).max(128), rhs_account_number: z.string().regex(/^\d+$/).max(128),
  rhc_account_number: z.string().max(128).optional(), agentic_allowed: z.boolean(),
  type: z.string(), brokerage_account_type: z.string(), state: z.string(),
  deactivated: z.boolean(), permanently_deactivated: z.boolean() });
/** Resolve from the same fresh provider row, never from a flattened list of IDs. */
export function resolveRobinhoodCryptoAccount(raw: unknown, externalRef: string | undefined) {
  const payload = z.object({ data: z.object({ accounts: z.array(z.unknown()).max(100).nullable() }) }).parse(raw);
  if (!externalRef) throw Error('Account unavailable');
  const rows = (payload.data.accounts ?? []).filter(value => {
    if (!value || typeof value !== 'object') return false;
    const number = (value as Record<string, unknown>).account_number;
    return typeof number === 'string' && createHash('sha256').update(number).digest('hex') === externalRef;
  });
  if (rows.length !== 1) throw Error('Account binding unavailable');
  const row = account.parse(rows[0]);
  if (!row.agentic_allowed || row.rhc_account_number === undefined) throw Error('Crypto account unavailable');
  // Only an explicit empty linked-account field proves there is no crypto account.
  // Missing fields, failed reads and mismatched identities must not clear holdings.
  if (!row.rhc_account_number.trim()) return null;
  // Binding is not trade eligibility: state, pair restrictions and side still need checks.
  return { accountNumber: row.account_number, rhsAccountNumber: row.rhs_account_number,
    cryptoAccountNumber: row.rhc_account_number, brokerageAccountType: row.brokerage_account_type,
    tradingType: row.type, state: row.state, deactivated: row.deactivated, permanentlyDeactivated: row.permanently_deactivated };
}

/** Trading and order recovery require a linked crypto account. */
export function bindRobinhoodCryptoAccount(raw:unknown,externalRef:string|undefined){
 const account=resolveRobinhoodCryptoAccount(raw,externalRef);
 if(!account)throw Error('Crypto account unavailable');
 return account;
}
