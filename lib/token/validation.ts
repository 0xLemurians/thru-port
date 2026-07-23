export const TOKEN_NAME_MAX_BYTES = 64;
export const TOKEN_TICKER_MAX_BYTES = 8;
export const TOKEN_DECIMALS_MIN = 0;
export const TOKEN_DECIMALS_MAX = 18;
export const TOKEN_AMOUNT_MAX_RAW = (1n << 64n) - 1n;

export interface ValidatedTokenInput {
  name: string;
  ticker: string;
  decimals: number;
  initialSupply: string;
  initialSupplyRaw: bigint;
}

const TEXT_ENCODER = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/;
const DECIMAL_AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

export function validateTokenName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Token name is required.");
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw new Error("Token name cannot contain control characters.");
  }
  if (TEXT_ENCODER.encode(normalized).length > TOKEN_NAME_MAX_BYTES) {
    throw new Error(
      `Token name must be ${TOKEN_NAME_MAX_BYTES} UTF-8 bytes or fewer.`,
    );
  }
  return normalized;
}

export function validateTokenTicker(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new Error("Ticker is required.");
  }
  if (
    !TICKER_PATTERN.test(normalized) ||
    TEXT_ENCODER.encode(normalized).length > TOKEN_TICKER_MAX_BYTES
  ) {
    throw new Error(
      "Ticker must start with A-Z and contain only A-Z or 0-9 (maximum 8 characters).",
    );
  }
  return normalized;
}

export function validateTokenDecimals(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < TOKEN_DECIMALS_MIN ||
    value > TOKEN_DECIMALS_MAX
  ) {
    throw new Error(
      `Decimals must be an integer from ${TOKEN_DECIMALS_MIN} to ${TOKEN_DECIMALS_MAX}.`,
    );
  }
  return value;
}

export function decimalAmountToRaw(
  value: string,
  decimals: number,
  maximum: bigint = TOKEN_AMOUNT_MAX_RAW,
  fieldLabel = "Initial supply",
): bigint {
  validateTokenDecimals(decimals);

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldLabel} is required.`);
  }
  if (/[eE]/.test(normalized)) {
    throw new Error("Scientific notation is not supported.");
  }
  if (normalized.startsWith("-") || normalized.startsWith("+")) {
    throw new Error(`${fieldLabel} must be a positive decimal amount.`);
  }
  if (normalized.length > 64) {
    throw new Error(`${fieldLabel} is too large.`);
  }

  const match = DECIMAL_AMOUNT_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(
      `${fieldLabel} must use plain decimal notation without separators.`,
    );
  }

  const fraction = match[1] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `${fieldLabel} can have at most ${decimals} decimal place${
        decimals === 1 ? "" : "s"
      }.`,
    );
  }

  const [whole = "0"] = normalized.split(".");
  const scale = 10n ** BigInt(decimals);
  const raw =
    BigInt(whole) * scale +
    BigInt(fraction.padEnd(decimals, "0") || "0");

  if (raw <= 0n) {
    throw new Error(`${fieldLabel} must be greater than zero.`);
  }
  if (raw > maximum) {
    throw new Error(
      `${fieldLabel} exceeds the maximum raw amount of ${maximum.toString()}.`,
    );
  }

  return raw;
}

export function validateTokenInput(input: {
  name: string;
  ticker: string;
  decimals: number;
  initialSupply: string;
}): ValidatedTokenInput {
  const decimals = validateTokenDecimals(input.decimals);
  return {
    name: validateTokenName(input.name),
    ticker: validateTokenTicker(input.ticker),
    decimals,
    initialSupply: input.initialSupply.trim(),
    initialSupplyRaw: decimalAmountToRaw(input.initialSupply, decimals),
  };
}
