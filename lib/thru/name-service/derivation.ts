import { deriveProgramAddress, Pubkey } from "@thru/sdk";
import {
  LEASE_SEED_PREFIX,
  NAME_SERVICE_PROGRAM_ADDRESS,
  REGISTRAR_CONFIG_SEED_TEXT,
  REGISTRAR_PROGRAM_ADDRESS,
} from "./constants";

const TEXT_ENCODER = new TextEncoder();

function paddedSeed(value: Uint8Array): Uint8Array {
  if (value.length > 32) {
    throw new Error("Program-address seed exceeds 32 bytes.");
  }
  const seed = new Uint8Array(32);
  seed.set(value);
  return seed;
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const input = new Uint8Array(value.length);
  input.set(value);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    input.buffer,
  );
  return new Uint8Array(digest);
}

export function deriveRegistrarConfigAddress(): string {
  const seed = paddedSeed(TEXT_ENCODER.encode(REGISTRAR_CONFIG_SEED_TEXT));
  return deriveProgramAddress({
    programAddress: REGISTRAR_PROGRAM_ADDRESS,
    seed,
  }).address;
}

export async function deriveDomainAddress(
  rootRegistrarAddress: string,
  rawLabelBytes: Uint8Array,
): Promise<string> {
  const rootRegistrarBytes = Pubkey.from(rootRegistrarAddress).toBytes();
  const seed = await sha256(
    concatenate(rootRegistrarBytes, rawLabelBytes),
  );
  return deriveProgramAddress({
    programAddress: NAME_SERVICE_PROGRAM_ADDRESS,
    seed,
  }).address;
}

export async function deriveLeaseAddress(
  rawLabelBytes: Uint8Array,
): Promise<string> {
  const seed = await sha256(
    concatenate(TEXT_ENCODER.encode(LEASE_SEED_PREFIX), rawLabelBytes),
  );
  return deriveProgramAddress({
    programAddress: REGISTRAR_PROGRAM_ADDRESS,
    seed,
  }).address;
}
