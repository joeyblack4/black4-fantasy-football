/** Round an observed nonnegative USD decimal upward to integer microUSD without binary drift. */
export function usdToMicros(input: number | string): number {
  const value = String(input);
  const match = value.match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new Error("Invalid USD decimal");
  const fraction = match[2] ?? "";
  const power = 6 + Number(match[3] ?? 0) - fraction.length;
  if (!Number.isInteger(power) || Math.abs(power) > 100)
    throw new Error("USD magnitude unsupported");
  const digits = BigInt(match[1] + fraction);
  const micro =
    power >= 0
      ? digits * 10n ** BigInt(power)
      : (digits + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("USD overflow");
  return Number(micro);
}
