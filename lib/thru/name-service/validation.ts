import { NAME_LABEL_MAX_UTF8_BYTES } from "./constants";

const TEXT_ENCODER = new TextEncoder();

export interface ValidatedNameLabel {
  label: string;
  bytes: Uint8Array;
}

export function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

export function validateNameLabel(value: string): ValidatedNameLabel {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim().length === 0
  ) {
    throw new Error("A .thru label is required.");
  }
  if (value.includes(".")) {
    throw new Error("Enter only the label, without dots or the .thru suffix.");
  }

  const bytes = TEXT_ENCODER.encode(value);
  if (bytes.length > NAME_LABEL_MAX_UTF8_BYTES) {
    throw new Error(
      `The label must be ${NAME_LABEL_MAX_UTF8_BYTES} UTF-8 bytes or fewer.`,
    );
  }

  return { label: value, bytes };
}

