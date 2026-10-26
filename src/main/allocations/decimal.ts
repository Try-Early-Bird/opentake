const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

export function decimalToScaledInteger(
  value: string,
  scale = 18,
): bigint {
  const normalized = value.trim();
  const match = DECIMAL_PATTERN.exec(normalized);
  if (match === null || scale < 0) {
    throw new Error(`Invalid non-negative decimal: ${value}`);
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const retained = fraction.slice(0, scale).padEnd(scale, "0");
  let result = BigInt(whole) * powerOfTen(scale) + BigInt(retained || "0");
  const firstDiscarded = fraction.at(scale);
  if (firstDiscarded !== undefined && firstDiscarded >= "5") {
    result += 1n;
  }
  return result;
}

export function scaledIntegerToDecimal(
  value: bigint,
  scale = 18,
): string {
  if (value < 0n || scale < 0) {
    throw new Error("Only non-negative fixed-point values are supported");
  }
  if (scale === 0) {
    return value.toString();
  }
  const divisor = powerOfTen(scale);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(scale, "0")
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

export function normalizeDecimal(value: string, scale = 18): string {
  return scaledIntegerToDecimal(decimalToScaledInteger(value, scale), scale);
}

export function averageDecimals(
  left: string,
  right: string,
  scale = 18,
): string {
  const sum =
    decimalToScaledInteger(left, scale) +
    decimalToScaledInteger(right, scale);
  return scaledIntegerToDecimal((sum + 1n) / 2n, scale);
}

export function multiplyDecimals(
  left: string,
  right: string,
  scale = 18,
): string {
  const divisor = powerOfTen(scale);
  const product =
    decimalToScaledInteger(left, scale) *
    decimalToScaledInteger(right, scale);
  return scaledIntegerToDecimal((product + divisor / 2n) / divisor, scale);
}

export function divideDecimals(
  numerator: string,
  denominator: string,
  scale = 18,
): string {
  const scaledNumerator = decimalToScaledInteger(numerator, scale);
  const scaledDenominator = decimalToScaledInteger(denominator, scale);
  if (scaledDenominator === 0n) {
    throw new Error("Cannot divide by zero");
  }
  const dividend = scaledNumerator * powerOfTen(scale);
  return scaledIntegerToDecimal(
    (dividend + scaledDenominator / 2n) / scaledDenominator,
    scale,
  );
}

export function subtractDecimals(
  left: string,
  right: string,
  scale = 18,
): string {
  const difference =
    decimalToScaledInteger(left, scale) -
    decimalToScaledInteger(right, scale);
  if (difference < 0n) {
    throw new Error("Decimal subtraction produced a negative value");
  }
  return scaledIntegerToDecimal(difference, scale);
}

export function integerUnitsToDecimal(
  value: bigint,
  decimals: number,
): string {
  if (value < 0n || decimals < 0 || decimals > 36) {
    throw new Error("Invalid integer unit value");
  }
  return scaledIntegerToDecimal(value, decimals);
}

export function formatUsd(value: string): string {
  const cents = decimalToScaledInteger(value, 2);
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, "0");
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `$${grouped}.${fraction}`;
}
