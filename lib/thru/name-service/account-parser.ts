import { Pubkey } from "@thru/sdk";
import {
  NAME_RECORD_KEY_MAX_BYTES,
  NAME_RECORD_VALUE_MAX_BYTES,
} from "./constants";
import type {
  DomainState,
  LeaseState,
  ReadonlyChainAccount,
  RegistrarConfigState,
} from "./account-types";

const PUBKEY_SIZE = 32;
const TEXT_FIELD_SIZE = 64;
const CONFIG_ACCOUNT_SIZE = 244;
const LEASE_ACCOUNT_SIZE = 148;
const DOMAIN_DISCRIMINATOR = 2;
const DOMAIN_BASE_SIZE = 145;
const RECORD_SIZE =
  4 +
  NAME_RECORD_KEY_MAX_BYTES +
  4 +
  NAME_RECORD_VALUE_MAX_BYTES;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

function requireLength(
  data: Uint8Array,
  expected: number,
  label: string,
): void {
  if (data.length !== expected) {
    throw new Error(
      `${label} data has ${data.length} bytes; expected ${expected}.`,
    );
  }
}

function requireRange(
  data: Uint8Array,
  offset: number,
  length: number,
  label: string,
): void {
  if (
    offset < 0 ||
    length < 0 ||
    offset > data.length ||
    length > data.length - offset
  ) {
    throw new Error(`${label} extends beyond account data.`);
  }
}

function readU32(data: Uint8Array, offset: number, label: string): number {
  requireRange(data, offset, 4, label);
  return new DataView(
    data.buffer,
    data.byteOffset + offset,
    4,
  ).getUint32(0, true);
}

function readU64(data: Uint8Array, offset: number, label: string): bigint {
  requireRange(data, offset, 8, label);
  return new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
}

function readAddress(
  data: Uint8Array,
  offset: number,
  label: string,
): string {
  requireRange(data, offset, PUBKEY_SIZE, label);
  return Pubkey.from(data.slice(offset, offset + PUBKEY_SIZE)).toThruFmt();
}

function readText(
  data: Uint8Array,
  offset: number,
  capacity: number,
  length: number,
  label: string,
  allowEmpty = false,
): string {
  if ((!allowEmpty && length === 0) || length > capacity) {
    throw new Error(`${label} length ${length} is invalid.`);
  }
  requireRange(data, offset, capacity, label);
  try {
    return TEXT_DECODER.decode(data.slice(offset, offset + length));
  } catch {
    throw new Error(`${label} is not valid UTF-8 text.`);
  }
}

export function accountOwnerAddress(account: ReadonlyChainAccount): string {
  const owner = account.meta?.owner;
  if (!owner) throw new Error("Account owner metadata is missing.");
  return typeof owner === "string" ? owner : owner.toThruFmt();
}

export function assertAccountOwnedBy(
  account: ReadonlyChainAccount,
  expectedOwner: string,
  label: string,
): void {
  const owner = accountOwnerAddress(account);
  if (owner !== expectedOwner) {
    throw new Error(
      `${label} is owned by ${owner}; expected ${expectedOwner}.`,
    );
  }
}

export function accountDataBytes(
  account: ReadonlyChainAccount,
  label: string,
): Uint8Array {
  const data = account.data?.data;
  if (!data) throw new Error(`${label} data is missing.`);
  const declaredSize = account.meta?.dataSize;
  if (declaredSize !== undefined && declaredSize !== data.length) {
    throw new Error(
      `${label} metadata declares ${declaredSize} bytes but ${data.length} were returned.`,
    );
  }
  return data;
}

export function parseRegistrarConfigData(
  data: Uint8Array,
): RegistrarConfigState {
  requireLength(data, CONFIG_ACCOUNT_SIZE, "Registrar config");
  const rootNameLength = readU32(data, 224, "Root domain name length");

  return {
    nameServiceProgramId: readAddress(data, 0, "Name Service program"),
    rootRegistrar: readAddress(data, 32, "Root registrar"),
    treasurerTokenAccount: readAddress(
      data,
      64,
      "Treasurer token account",
    ),
    paymentMint: readAddress(data, 96, "Payment mint"),
    tokenProgramId: readAddress(data, 128, "Token program"),
    rootDomainName: readText(
      data,
      160,
      TEXT_FIELD_SIZE,
      rootNameLength,
      "Root domain name",
    ),
    pricePerYear: readU64(data, 228, "Price per year"),
    totalDomainsSold: readU64(data, 236, "Total domains sold"),
  };
}

export function parseDomainData(data: Uint8Array): DomainState {
  if (data.length < DOMAIN_BASE_SIZE) {
    throw new Error(
      `Domain data has ${data.length} bytes; expected at least ${DOMAIN_BASE_SIZE}.`,
    );
  }
  if (data[0] !== DOMAIN_DISCRIMINATOR) {
    throw new Error(
      `Malformed domain discriminator ${data[0]}; expected ${DOMAIN_DISCRIMINATOR}.`,
    );
  }

  const nameLength = readU32(data, 129, "Domain name length");
  const recordCount = readU32(data, 141, "Domain record count");
  const expectedSize = DOMAIN_BASE_SIZE + recordCount * RECORD_SIZE;
  requireLength(data, expectedSize, "Domain");

  const records = [];
  let offset = DOMAIN_BASE_SIZE;
  for (let index = 0; index < recordCount; index += 1) {
    const keyLength = readU32(data, offset, `Record ${index} key length`);
    const key = readText(
      data,
      offset + 4,
      NAME_RECORD_KEY_MAX_BYTES,
      keyLength,
      `Record ${index} key`,
    );
    const valueLengthOffset = offset + 4 + NAME_RECORD_KEY_MAX_BYTES;
    const valueLength = readU32(
      data,
      valueLengthOffset,
      `Record ${index} value length`,
    );
    const value = readText(
      data,
      valueLengthOffset + 4,
      NAME_RECORD_VALUE_MAX_BYTES,
      valueLength,
      `Record ${index} value`,
      true,
    );
    records.push({
      key,
      value,
      keyByteLength: keyLength,
      valueByteLength: valueLength,
    });
    offset += RECORD_SIZE;
  }

  return {
    parent: readAddress(data, 1, "Domain parent"),
    owner: readAddress(data, 33, "Domain owner"),
    name: readText(
      data,
      65,
      TEXT_FIELD_SIZE,
      nameLength,
      "Domain name",
    ),
    registrationTime: readU64(data, 133, "Registration time"),
    recordCount,
    records,
  };
}

export function parseLeaseData(data: Uint8Array): LeaseState {
  requireLength(data, LEASE_ACCOUNT_SIZE, "Lease");
  const nameLength = readU32(data, 128, "Lease domain name length");
  return {
    domainAccount: readAddress(data, 0, "Lease domain account"),
    owner: readAddress(data, 32, "Lease owner"),
    domainName: readText(
      data,
      64,
      TEXT_FIELD_SIZE,
      nameLength,
      "Lease domain name",
    ),
    leaseStart: readU64(data, 132, "Lease start"),
    leaseEnd: readU64(data, 140, "Lease end"),
  };
}

