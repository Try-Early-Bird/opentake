/** Broker buying power minus what strategies have reserved, never below zero. */
export function freeBuyingPower(buyingPower: string | null | undefined, reservedCash: string | undefined): string | null {
  if (buyingPower === null || buyingPower === undefined) return null;
  const total = Number(buyingPower);
  const reserved = Number(reservedCash ?? '0');
  if (!Number.isFinite(total)) return buyingPower;
  return String(Math.max(0, total - (Number.isFinite(reserved) ? reserved : 0)));
}

