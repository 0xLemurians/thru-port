import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Pubkey } from "@thru/sdk";
import {
  parseDomainData,
  parseLeaseData,
  parseRegistrarConfigData,
} from "../lib/thru/name-service/account-parser";
import type {
  ReadonlyAccountReader,
  ReadonlyChainAccount,
} from "../lib/thru/name-service/account-types";
import {
  NAME_NOT_FOUND_MESSAGE,
  NAME_SERVICE_PROGRAM_ADDRESS,
  NAME_SNAPSHOT_WARNING,
  REGISTRAR_PROGRAM_ADDRESS,
} from "../lib/thru/name-service/constants";
import {
  deriveDomainAddress,
  deriveLeaseAddress,
  deriveRegistrarConfigAddress,
} from "../lib/thru/name-service/derivation";
import {
  LatestNameLookupTracker,
  lookupThruName,
} from "../lib/thru/name-service/lookup";
import {
  utf8ByteLength,
  validateNameLabel,
} from "../lib/thru/name-service/validation";

const ROOT_REGISTRAR =
  "taG7mAFPWH786OckjT8fuirjgaaF070YxPjJGE32NIctNm";
const TOKEN_PROGRAM =
  "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq";
const OWNER = "taBI9fwnX5fT_sJ0cdKKyCLyk72TLw6Rz4wwb-SFdU8aKD";
const TREASURER =
  "ta8QDb9ErMQaavd-pyeOMoyYS4HuwvjlEw5S6kF73m9R2S";
const PAYMENT_MINT =
  "tacdgTUGud8OgzN5HnVVv4u3x82UBe8ciZAtjOLJZE_SNg";
const TEXT_ENCODER = new TextEncoder();

function addressBytes(address: string): Uint8Array {
  return Pubkey.from(address).toBytes();
}

function setAddress(
  target: Uint8Array,
  offset: number,
  address: string,
): void {
  target.set(addressBytes(address), offset);
}

function setU32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer).setUint32(offset, value, true);
}

function setU64(target: Uint8Array, offset: number, value: bigint): void {
  new DataView(target.buffer).setBigUint64(offset, value, true);
}

function setText(
  target: Uint8Array,
  offset: number,
  lengthOffset: number,
  value: string,
): void {
  const bytes = TEXT_ENCODER.encode(value);
  target.set(bytes, offset);
  setU32(target, lengthOffset, bytes.length);
}

function buildConfigData(): Uint8Array {
  const data = new Uint8Array(244);
  setAddress(data, 0, NAME_SERVICE_PROGRAM_ADDRESS);
  setAddress(data, 32, ROOT_REGISTRAR);
  setAddress(data, 64, TREASURER);
  setAddress(data, 96, PAYMENT_MINT);
  setAddress(data, 128, TOKEN_PROGRAM);
  setText(data, 160, 224, "thru");
  setU64(data, 228, 100n);
  setU64(data, 236, 765n);
  return data;
}

function buildDomainData(
  label: string,
  domainOwner = OWNER,
  parent = ROOT_REGISTRAR,
  records: Array<[string, string]> = [["profile", "mert"]],
): Uint8Array {
  const data = new Uint8Array(145 + records.length * 296);
  data[0] = 2;
  setAddress(data, 1, parent);
  setAddress(data, 33, domainOwner);
  setText(data, 65, 129, label);
  setU64(data, 133, 1234n);
  setU32(data, 141, records.length);

  let offset = 145;
  for (const [key, value] of records) {
    const keyBytes = TEXT_ENCODER.encode(key);
    const valueBytes = TEXT_ENCODER.encode(value);
    setU32(data, offset, keyBytes.length);
    data.set(keyBytes, offset + 4);
    setU32(data, offset + 36, valueBytes.length);
    data.set(valueBytes, offset + 40);
    offset += 296;
  }
  return data;
}

function buildLeaseData(
  label: string,
  domainAddress: string,
  leaseOwner = OWNER,
): Uint8Array {
  const data = new Uint8Array(148);
  setAddress(data, 0, domainAddress);
  setAddress(data, 32, leaseOwner);
  setText(data, 64, 128, label);
  setU64(data, 132, 1000n);
  setU64(data, 140, 2000n);
  return data;
}

function chainAccount(
  owner: string,
  data: Uint8Array,
): ReadonlyChainAccount {
  return {
    meta: {
      owner,
      dataSize: data.length,
      flags: { isDeleted: false },
    },
    data: { data },
  };
}

test("uses the official AlphaNet Name Service and Registrar addresses", () => {
  assert.equal(
    NAME_SERVICE_PROGRAM_ADDRESS,
    "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUF",
  );
  assert.equal(
    REGISTRAR_PROGRAM_ADDRESS,
    "taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYG",
  );
});

test("derives the official Registrar config address from padded config seed", () => {
  assert.equal(
    deriveRegistrarConfigAddress(),
    "taI-BFbVYdM6ZtUldRu_t0Q7QcNAmCHE6qbVuzpgcRaGuE",
  );
});

test("derives domain and lease addresses from official formulas", async () => {
  const raw = validateNameLabel("mert").bytes;
  assert.equal(
    await deriveDomainAddress(ROOT_REGISTRAR, raw),
    "taZoHjV5_HTOnNmaLngXYmlXsFxVhEGiKiJLhFpk5xSm5a",
  );
  assert.equal(
    await deriveLeaseAddress(raw),
    "taUBtyoAOVodS3ZqJUxKUyZy6t8LCGKbQaSMrSiwMZPawL",
  );
});

test("Mert and mert derive different addresses", async () => {
  const lower = validateNameLabel("mert").bytes;
  const upper = validateNameLabel("Mert").bytes;
  assert.notEqual(
    await deriveDomainAddress(ROOT_REGISTRAR, lower),
    await deriveDomainAddress(ROOT_REGISTRAR, upper),
  );
  assert.notEqual(
    await deriveLeaseAddress(lower),
    await deriveLeaseAddress(upper),
  );
});

test("validates labels by raw UTF-8 byte length", () => {
  assert.equal(utf8ByteLength("\u00e9"), 2);
  assert.equal(
    validateNameLabel(" ".repeat(2) + "Mert ").label,
    "  Mert ",
  );
  assert.equal(validateNameLabel("\ud83d\ude00".repeat(16)).bytes.length, 64);
  assert.throws(() => validateNameLabel(""), /required/i);
  assert.throws(
    () => validateNameLabel("\ud83d\ude00".repeat(17)),
    /64 UTF-8 bytes/i,
  );
  assert.throws(() => validateNameLabel("mert.thru"), /only the label/i);
});

test("does not apply Unicode normalization", async () => {
  const composed = validateNameLabel("\u00e9");
  const decomposed = validateNameLabel("e\u0301");
  assert.equal(composed.label, "\u00e9");
  assert.equal(decomposed.label, "e\u0301");
  assert.notDeepEqual(composed.bytes, decomposed.bytes);
  assert.notEqual(
    await deriveDomainAddress(ROOT_REGISTRAR, composed.bytes),
    await deriveDomainAddress(ROOT_REGISTRAR, decomposed.bytes),
  );
});

test("parses official Config, Domain, records, and Lease layouts", async () => {
  const config = parseRegistrarConfigData(buildConfigData());
  assert.equal(config.nameServiceProgramId, NAME_SERVICE_PROGRAM_ADDRESS);
  assert.equal(config.rootRegistrar, ROOT_REGISTRAR);
  assert.equal(config.paymentMint, PAYMENT_MINT);
  assert.equal(config.treasurerTokenAccount, TREASURER);
  assert.equal(config.pricePerYear, 100n);

  const domain = parseDomainData(buildDomainData("mert"));
  assert.equal(domain.parent, ROOT_REGISTRAR);
  assert.equal(domain.owner, OWNER);
  assert.equal(domain.name, "mert");
  assert.equal(domain.registrationTime, 1234n);
  assert.equal(domain.recordCount, 1);
  assert.deepEqual(domain.records[0], {
    key: "profile",
    value: "mert",
    keyByteLength: 7,
    valueByteLength: 4,
  });

  const domainAddress = await deriveDomainAddress(
    ROOT_REGISTRAR,
    TEXT_ENCODER.encode("mert"),
  );
  const lease = parseLeaseData(buildLeaseData("mert", domainAddress));
  assert.equal(lease.domainAccount, domainAddress);
  assert.equal(lease.owner, OWNER);
  assert.equal(lease.domainName, "mert");
  assert.equal(lease.leaseStart, 1000n);
  assert.equal(lease.leaseEnd, 2000n);
});

test("rejects malformed discriminator and short account data", () => {
  const malformed = buildDomainData("mert");
  malformed[0] = 1;
  assert.throws(() => parseDomainData(malformed), /discriminator/i);
  assert.throws(() => parseDomainData(new Uint8Array(144)), /at least 145/i);
  assert.throws(
    () => parseRegistrarConfigData(new Uint8Array(243)),
    /expected 244/i,
  );
  assert.throws(
    () => parseLeaseData(new Uint8Array(147)),
    /expected 148/i,
  );
});

test("rejects name length and record count overflow", () => {
  const nameOverflow = buildDomainData("mert", OWNER, ROOT_REGISTRAR, []);
  setU32(nameOverflow, 129, 65);
  assert.throws(() => parseDomainData(nameOverflow), /name length 65/i);

  const countOverflow = buildDomainData("mert", OWNER, ROOT_REGISTRAR, []);
  setU32(countOverflow, 141, 0xffffffff);
  assert.throws(() => parseDomainData(countOverflow), /expected/i);
});

test("rejects record key and value lengths beyond official limits", () => {
  const keyOverflow = buildDomainData("mert");
  setU32(keyOverflow, 145, 33);
  assert.throws(() => parseDomainData(keyOverflow), /key length 33/i);

  const valueOverflow = buildDomainData("mert");
  setU32(valueOverflow, 181, 257);
  assert.throws(() => parseDomainData(valueOverflow), /value length 257/i);
});

test("validates Config, Domain, and Lease ownership and relationships", async () => {
  const label = "mert";
  const configAddress = deriveRegistrarConfigAddress();
  const domainAddress = await deriveDomainAddress(
    ROOT_REGISTRAR,
    TEXT_ENCODER.encode(label),
  );
  const leaseAddress = await deriveLeaseAddress(TEXT_ENCODER.encode(label));
  const accounts = new Map<string, ReadonlyChainAccount>([
    [
      configAddress,
      chainAccount(REGISTRAR_PROGRAM_ADDRESS, buildConfigData()),
    ],
    [
      domainAddress,
      chainAccount(
        NAME_SERVICE_PROGRAM_ADDRESS,
        buildDomainData(label),
      ),
    ],
    [
      leaseAddress,
      chainAccount(
        REGISTRAR_PROGRAM_ADDRESS,
        buildLeaseData(label, domainAddress),
      ),
    ],
  ]);
  const reader: ReadonlyAccountReader = {
    async get(address) {
      const account = accounts.get(address);
      if (!account) throw Object.assign(new Error("not found"), { code: 5 });
      return account;
    },
  };

  const snapshot = await lookupThruName(label, { reader });
  assert.equal(snapshot.fullyQualifiedName, "mert.thru");
  assert.equal(snapshot.domain.status, "found");
  assert.equal(snapshot.lease.status, "found");

  accounts.set(
    domainAddress,
    chainAccount(REGISTRAR_PROGRAM_ADDRESS, buildDomainData(label)),
  );
  const invalidOwner = await lookupThruName(label, { reader });
  assert.equal(invalidOwner.domain.status, "invalid");
  if (invalidOwner.domain.status === "invalid") {
    assert.match(
      invalidOwner.domain.error,
      new RegExp(`expected ${NAME_SERVICE_PROGRAM_ADDRESS}`),
    );
  }

  accounts.set(
    domainAddress,
    chainAccount(
      NAME_SERVICE_PROGRAM_ADDRESS,
      buildDomainData(label, OWNER, TOKEN_PROGRAM, []),
    ),
  );
  const invalidParent = await lookupThruName(label, { reader });
  assert.equal(invalidParent.domain.status, "invalid");
  if (invalidParent.domain.status === "invalid") {
    assert.match(invalidParent.domain.error, /does not match root registrar/i);
  }

  accounts.set(
    domainAddress,
    chainAccount(
      NAME_SERVICE_PROGRAM_ADDRESS,
      buildDomainData(label),
    ),
  );
  accounts.set(
    leaseAddress,
    chainAccount(
      REGISTRAR_PROGRAM_ADDRESS,
      buildLeaseData(label, TOKEN_PROGRAM),
    ),
  );
  const invalidLeaseDomain = await lookupThruName(label, { reader });
  assert.equal(invalidLeaseDomain.lease.status, "invalid");
  if (invalidLeaseDomain.lease.status === "invalid") {
    assert.match(invalidLeaseDomain.lease.error, /does not match derived domain/i);
  }
});

test("reports missing Domain and Lease as snapshot not-found states", async () => {
  const configAddress = deriveRegistrarConfigAddress();
  const reader: ReadonlyAccountReader = {
    async get(address) {
      if (address === configAddress) {
        return chainAccount(REGISTRAR_PROGRAM_ADDRESS, buildConfigData());
      }
      throw Object.assign(new Error("[not_found] account not found"), {
        code: 5,
      });
    },
  };

  const snapshot = await lookupThruName("notregistered", { reader });
  assert.equal(snapshot.domain.status, "not-found");
  assert.equal(snapshot.lease.status, "not-found");
  assert.equal(
    NAME_NOT_FOUND_MESSAGE,
    "Not found on the latest AlphaNet snapshot.",
  );
  assert.match(NAME_SNAPSHOT_WARNING, /snapshot only/i);
  assert.doesNotMatch(NAME_SNAPSHOT_WARNING, /\bavailable\b/i);
});

test("an older RPC response cannot overwrite the latest lookup state", async () => {
  const tracker = new LatestNameLookupTracker();
  let state = "initial";
  let releaseOld: (() => void) | undefined;

  const oldRequest = tracker.begin();
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  }).then(() => {
    if (tracker.isCurrent(oldRequest)) state = "old";
  });

  const newRequest = tracker.begin();
  if (tracker.isCurrent(newRequest)) state = "new";
  releaseOld?.();
  await oldResponse;

  assert.equal(state, "new");
  assert.equal(tracker.isCurrent(oldRequest), false);
  assert.equal(tracker.isCurrent(newRequest), true);
});

test("lookup honors AbortSignal", async () => {
  const controller = new AbortController();
  const reader: ReadonlyAccountReader = {
    get: (_address, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  };

  const pending = lookupThruName("mert", {
    reader,
    signal: controller.signal,
  });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/i);
});

test("the existing read-only lookup remains isolated from mutation paths", () => {
  const files = [
    "lib/thru/name-service/constants.ts",
    "lib/thru/name-service/derivation.ts",
    "lib/thru/name-service/account-types.ts",
    "lib/thru/name-service/account-parser.ts",
    "lib/thru/name-service/lookup.ts",
    "lib/thru/name-service/validation.ts",
    "components/name-studio/NameLookupForm.tsx",
    "components/name-studio/NameAccountDetails.tsx",
    "components/name-studio/LeaseDetails.tsx",
    "components/name-studio/NameRecords.tsx",
    "components/name-studio/NameSecurityNotice.tsx",
  ];
  const source = files
    .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
    .join("\n");

  assert.doesNotMatch(
    source,
    /\.transactions\b|sendAndTrack|buildAndSign|StateProof|instruction|\.sign\(/i,
  );
  assert.doesNotMatch(source, /privateKey|mnemonic|recovery phrase/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage/i);
});
