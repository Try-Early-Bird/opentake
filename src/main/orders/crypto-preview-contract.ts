import { z } from 'zod';
export const cryptoDecimal = z.string().max(48).regex(/^(0|[1-9]\d{0,19})(\.\d{1,18})?$/);
const positive = cryptoDecimal.refine(value => /[1-9]/.test(value), 'Must be positive');
export const cryptoEligibilityInput = z.object({ currency_pair_id: z.string().min(1).max(256), side: z.enum(['buy', 'sell']) }).strict();
export const cryptoPreviewInput = cryptoEligibilityInput.extend({
  type: z.enum(['market', 'limit']), quantity: positive.optional(),
  dollar_amount: z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/).refine(v => /[1-9]/.test(v), 'Must be positive').optional(),
  limit_price: positive.optional(), time_in_force: z.literal('gtc').optional(),
}).superRefine((value, ctx) => {
  if ((value.quantity === undefined) === (value.dollar_amount === undefined)) ctx.addIssue({ code: 'custom', message: 'Provide exactly one of quantity or dollar_amount' });
  if ((value.type === 'limit') !== (value.limit_price !== undefined)) ctx.addIssue({ code: 'custom', message: 'Only limit orders require limit_price' });
});
