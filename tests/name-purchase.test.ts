import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ConsensusStatus,
  Pubkey,
  SubmissionStatus,
  type BuildTransactionOptions,
  type SendAndTrackTxnUpdate,
} from "@thru/sdk";
import type { TokenAccountInfo } from "@thru/programs/token";
import type {
  NameLookupSnapshot,
  RegistrarConfigState,
} from "../lib/thru/name-service/account-types";
import {
  NAME_SERVICE_PROGRAM_ADDRESS,
  REGISTRAR_PROGRAM_ADDRESS,
} from "../lib/thru/name-service/constants";
import { deriveRegistrarConfigAddress } from "../lib/thru/name-service/derivation";
import {
  PURCHASE_INSTRUCTION_HEADER_BYTES,
  PURCHASE_PROGRESS_STAGES,
  PURCHASE_TRANSACTION_RESOURCES,
  PurchaseError,
  buildPurchaseAccountLayout,
  buildPurchaseDomainInstructionData,
  buildPurchaseDomainInstructionHeader,
  buildPurchaseTransaction,
  calculatePurchasePrice,
  derivePaymentTokenAccountAddress,
  preparePurchaseDomain,
  purchaseThruName,
  quotePurchaseDomain,
  resolvePurchaseAccountIndexes,
  sortPubkeysLexicographically,
  validatePayerTokenAccount,
  validatePurchaseLabel,
  validatePurchaseYears,
  validateTreasurerTokenAccount,
  verifyPurchasedDomain,
  type PreparedPurchaseDomain,
  type PurchaseAccountsInput,
  type PurchaseEngineDependencies,
  type PurchaseTransaction,
} from "../lib/thru/name-service/purchase";
import type { ThruAccount } from "../lib/wallet/thru-wallet";
import { thru } from "../lib/thru/client";

function fakeAddress(marker: number): string {
  const bytes = new Uint8Array(32);
  bytes.fill(marker);
  return Pubkey.from(bytes).toThruFmt();
}

function addressBytes(address: string): Uint8Array {
  return Pubkey.from(address).toBytes();
}

const ROOT_REGISTRAR = fakeAddress(1);
const TREASURER = fakeAddress(2);
const PAYMENT_MINT = fakeAddress(3);
const TOKEN_PROGRAM = fakeAddress(4);
const WALLET = fakeAddress(5);
const PAYER_TOKEN_ACCOUNT = fakeAddress(6);
const DOMAIN = fakeAddress(7);
const LEASE = fakeAddress(8);
const CONFIG = deriveRegistrarConfigAddress();
const LABEL = "Mért";
const PRICE_PER_YEAR = 25n;

const WALLET_ACCOUNT: ThruAccount = {
  address: WALLET,
  publicKey: addressBytes(WALLET),
  privateKey: new Uint8Array(32).fill(0x5a),
};

function registrarConfig(
  overrides: Partial<RegistrarConfigState> = {},
): RegistrarConfigState {
  return {
    nameServiceProgramId: NAME_SERVICE_PROGRAM_ADDRESS,
    rootRegistrar: ROOT_REGISTRAR,
    treasurerTokenAccount: TREASURER,
    paymentMint: PAYMENT_MINT,
    tokenProgramId: TOKEN_PROGRAM,
    rootDomainName: "thru",
    pricePerYear: PRICE_PER_YEAR,
    totalDomainsSold: 10n,
    ...overrides,
  };
}

function availableSnapshot(
  overrides: Partial<NameLookupSnapshot> = {},
): NameLookupSnapshot {
  return {
    label: LABEL,
    fullyQualifiedName: `${LABEL}.thru`,
    configAddress: CONFIG,
    domainAddress: DOMAIN,
    leaseAddress: LEASE,
    config: registrarConfig(),
    domain: { status: "not-found", address: DOMAIN },
    lease: { status: "not-found", address: LEASE },
    ...overrides,
  };
}

function foundSnapshot(
  owner = WALLET,
  overrides: Partial<NameLookupSnapshot> = {},
): NameLookupSnapshot {
  return availableSnapshot({
    domain: {
      status: "found",
      address: DOMAIN,
      state: {
        parent: ROOT_REGISTRAR,
        owner,
        name: LABEL,
        registrationTime: 1n,
        recordCount: 0,
        records: [],
      },
    },
    lease: {
      status: "found",
      address: LEASE,
      state: {
        domainAccount: DOMAIN,
        owner,
        domainName: LABEL,
        leaseStart: 1n,
        leaseEnd: 2n,
      },
    },
    ...overrides,
  });
}

function paymentAccount(
  overrides: Partial<TokenAccountInfo> = {},
): TokenAccountInfo {
  return {
    mint: PAYMENT_MINT,
    owner: WALLET,
    amount: 1_000n,
    isFrozen: false,
    ...overrides,
  };
}

function purchaseAccounts(): PurchaseAccountsInput {
  return {
    feePayer: WALLET,
    registrarProgram: REGISTRAR_PROGRAM_ADDRESS,
    configAccount: CONFIG,
    leaseAccount: LEASE,
    domainAccount: DOMAIN,
    treasurerTokenAccount: TREASURER,
    payerTokenAccount: PAYER_TOKEN_ACCOUNT,
    rootRegistrarAccount: ROOT_REGISTRAR,
    nameServiceProgram: NAME_SERVICE_PROGRAM_ADDRESS,
    paymentMintAccount: PAYMENT_MINT,
    tokenProgram: TOKEN_PROGRAM,
  };
}

function preparedPurchase(): PreparedPurchaseDomain {
  return {
    label: LABEL,
    years: 2,
    price: 50n,
    walletAddress: WALLET,
    configAddress: CONFIG,
    leaseAddress: LEASE,
    domainAddress: DOMAIN,
    treasurerTokenAccount: TREASURER,
    payerTokenAccount: PAYER_TOKEN_ACCOUNT,
    rootRegistrarAccount: ROOT_REGISTRAR,
    nameServiceProgram: NAME_SERVICE_PROGRAM_ADDRESS,
    paymentMintAccount: PAYMENT_MINT,
    tokenProgram: TOKEN_PROGRAM,
    config: registrarConfig(),
  };
}

function compareAddressBytes(left: string, right: string): number {
  const leftBytes = addressBytes(left);
  const rightBytes = addressBytes(right);
  for (let index = 0; index < 32; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.trim(), "hex"));
}

const FIXTURE_INDEXES = {
  configAccountIdx: 2,
  leaseAccountIdx: 3,
  domainAccountIdx: 4,
  nameServiceProgramIdx: 8,
  rootRegistrarAccountIdx: 7,
  treasurerTokenAccountIdx: 5,
  payerTokenAccountIdx: 6,
  paymentMintAccountIdx: 9,
  tokenProgramIdx: 10,
};

test("encodes every official fixed offset and an exact 91-byte header", () => {
  const indexes = {
    configAccountIdx: 0x0201,
    leaseAccountIdx: 0x0403,
    domainAccountIdx: 0x0605,
    nameServiceProgramIdx: 0x0807,
    rootRegistrarAccountIdx: 0x0a09,
    treasurerTokenAccountIdx: 0x0c0b,
    payerTokenAccountIdx: 0x0e0d,
    paymentMintAccountIdx: 0x100f,
    tokenProgramIdx: 0x1211,
  };
  const header = buildPurchaseDomainInstructionHeader({
    indexes,
    label: "\u00e9",
    years: 0xff,
  });
  const view = new DataView(header.buffer);

  assert.equal(header.length, PURCHASE_INSTRUCTION_HEADER_BYTES);
  assert.equal(view.getUint32(0, true), 1);
  assert.equal(view.getUint16(4, true), indexes.configAccountIdx);
  assert.equal(view.getUint16(6, true), indexes.leaseAccountIdx);
  assert.equal(view.getUint16(8, true), indexes.domainAccountIdx);
  assert.equal(view.getUint16(10, true), indexes.nameServiceProgramIdx);
  assert.equal(view.getUint16(12, true), indexes.rootRegistrarAccountIdx);
  assert.equal(view.getUint16(14, true), indexes.treasurerTokenAccountIdx);
  assert.equal(view.getUint16(16, true), indexes.payerTokenAccountIdx);
  assert.equal(view.getUint16(18, true), indexes.paymentMintAccountIdx);
  assert.equal(view.getUint16(20, true), indexes.tokenProgramIdx);
  assert.deepEqual(header.slice(22, 24), new Uint8Array([0xc3, 0xa9]));
  assert.ok(header.slice(24, 86).every((byte) => byte === 0));
  assert.equal(view.getUint32(86, true), 2);
  assert.equal(view.getUint8(90), 0xff);
});

test("accepts exactly 64 UTF-8 bytes and rejects 65 bytes or a dot", () => {
  assert.equal(validatePurchaseLabel("x".repeat(64)).bytes.length, 64);
  assert.equal(
    buildPurchaseDomainInstructionHeader({
      indexes: FIXTURE_INDEXES,
      label: "x".repeat(64),
      years: 1,
    }).length,
    91,
  );
  assert.throws(
    () => validatePurchaseLabel("x".repeat(65)),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "INVALID_LABEL",
  );
  assert.throws(
    () => validatePurchaseLabel("name.thru"),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "INVALID_LABEL",
  );
});

test("retains case, whitespace, and Unicode without normalization", () => {
  const upper = validatePurchaseLabel(" Name ");
  const lower = validatePurchaseLabel(" name ");
  const composed = validatePurchaseLabel("\u00e9");
  const decomposed = validatePurchaseLabel("e\u0301");

  assert.equal(upper.label, " Name ");
  assert.notDeepEqual(upper.bytes, lower.bytes);
  assert.equal(composed.label, "\u00e9");
  assert.equal(decomposed.label, "e\u0301");
  assert.notDeepEqual(composed.bytes, decomposed.bytes);
});

test("validates years as a positive u8 and encodes 255", () => {
  assert.equal(validatePurchaseYears(1), 1);
  assert.equal(validatePurchaseYears(255), 255);
  const header = buildPurchaseDomainInstructionHeader({
    indexes: FIXTURE_INDEXES,
    label: "A",
    years: 255,
  });
  assert.equal(header[90], 255);

  for (const invalid of [0, -1, 256, 1.5, Number.NaN]) {
    assert.throws(
      () => validatePurchaseYears(invalid),
      (error: unknown) =>
        error instanceof PurchaseError && error.code === "INVALID_YEARS",
    );
  }
});

test("calculates the registration price entirely with BigInt", () => {
  assert.equal(calculatePurchasePrice(9_007_199_254_740_993n, 3), 27_021_597_764_222_979n);
  assert.equal(typeof calculatePurchasePrice(25n, 2), "bigint");
  assert.throws(
    () => calculatePurchasePrice(-1n, 1),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "CONFIG_INVALID",
  );
});

test("sorts raw public-key bytes and resolves indexes after grouping", () => {
  const input = purchaseAccounts();
  const layout = buildPurchaseAccountLayout(input);
  const expectedReadWrite = [
    CONFIG,
    LEASE,
    DOMAIN,
    TREASURER,
    PAYER_TOKEN_ACCOUNT,
    ROOT_REGISTRAR,
  ].sort(compareAddressBytes);
  const expectedReadOnly = [
    NAME_SERVICE_PROGRAM_ADDRESS,
    PAYMENT_MINT,
    TOKEN_PROGRAM,
  ].sort(compareAddressBytes);

  assert.deepEqual(
    sortPubkeysLexicographically([...expectedReadWrite].reverse()),
    expectedReadWrite,
  );
  assert.deepEqual(layout.sortedReadWriteAccounts, expectedReadWrite);
  assert.deepEqual(layout.sortedReadOnlyAccounts, expectedReadOnly);
  assert.deepEqual(layout.wireAccounts, [
    WALLET,
    REGISTRAR_PROGRAM_ADDRESS,
    ...expectedReadWrite,
    ...expectedReadOnly,
  ]);

  const indexes = resolvePurchaseAccountIndexes(input, layout);
  assert.equal(indexes.configAccountIdx, layout.wireAccounts.indexOf(CONFIG));
  assert.equal(indexes.leaseAccountIdx, layout.wireAccounts.indexOf(LEASE));
  assert.equal(indexes.domainAccountIdx, layout.wireAccounts.indexOf(DOMAIN));
  assert.equal(
    indexes.nameServiceProgramIdx,
    layout.wireAccounts.indexOf(NAME_SERVICE_PROGRAM_ADDRESS),
  );
  assert.equal(
    indexes.rootRegistrarAccountIdx,
    layout.wireAccounts.indexOf(ROOT_REGISTRAR),
  );
  assert.equal(
    indexes.treasurerTokenAccountIdx,
    layout.wireAccounts.indexOf(TREASURER),
  );
  assert.equal(
    indexes.payerTokenAccountIdx,
    layout.wireAccounts.indexOf(PAYER_TOKEN_ACCOUNT),
  );
  assert.equal(
    indexes.paymentMintAccountIdx,
    layout.wireAccounts.indexOf(PAYMENT_MINT),
  );
  assert.equal(
    indexes.tokenProgramIdx,
    layout.wireAccounts.indexOf(TOKEN_PROGRAM),
  );
});

test("rejects duplicate, missing, invalid, and overflowing accounts", () => {
  assert.throws(
    () =>
      buildPurchaseAccountLayout({
        ...purchaseAccounts(),
        payerTokenAccount: TREASURER,
      }),
    /duplicate/i,
  );
  assert.throws(
    () =>
      buildPurchaseAccountLayout({
        ...purchaseAccounts(),
        domainAccount: "",
      }),
    /missing/i,
  );
  assert.throws(
    () =>
      buildPurchaseAccountLayout({
        ...purchaseAccounts(),
        domainAccount: "not-a-thru-address",
      }),
    /valid Thru address/i,
  );

  const input = purchaseAccounts();
  const layout = buildPurchaseAccountLayout(input);
  const overflowLayout = {
    ...layout,
    wireAccounts: [
      ...Array.from({ length: 65_536 }, () => fakeAddress(12)),
      CONFIG,
    ],
  };
  assert.throws(
    () => resolvePurchaseAccountIndexes(input, overflowLayout),
    /u16 wire limit/i,
  );
});

test("places the lease proof before the domain proof and matches total length", () => {
  const leaseProof = new Uint8Array([0xaa, 0xbb]);
  const domainProof = new Uint8Array([0xcc, 0xdd, 0xee]);
  const instruction = buildPurchaseDomainInstructionData({
    indexes: FIXTURE_INDEXES,
    label: "A",
    years: 3,
    leaseProof,
    domainProof,
  });

  assert.equal(instruction.length, 91 + leaseProof.length + domainProof.length);
  assert.deepEqual(instruction.slice(91, 93), leaseProof);
  assert.deepEqual(instruction.slice(93), domainProof);
});

test("matches the byte-for-byte official Rust purchase-builder fixture", () => {
  const officialFixture = hexToBytes(
    readFileSync(
      join(
        process.cwd(),
        "tests/fixtures/thru-registrar-purchase-0.2.39.hex",
      ),
      "utf8",
    ),
  );
  const actual = buildPurchaseDomainInstructionData({
    indexes: FIXTURE_INDEXES,
    label: "A",
    years: 3,
    leaseProof: new Uint8Array([0xaa, 0xbb]),
    domainProof: new Uint8Array([0xcc, 0xdd, 0xee, 0xff]),
  });

  assert.equal(bytesToHex(actual), bytesToHex(officialFixture));
  assert.equal(actual.length, 97);
});

test("validates payment mint, owner, Token Program, frozen state, and balance", () => {
  const valid = {
    tokenAccount: paymentAccount(),
    accountMetaOwner: TOKEN_PROGRAM,
    expectedTokenProgramId: TOKEN_PROGRAM,
    expectedMint: PAYMENT_MINT,
    expectedOwner: WALLET,
    requiredAmount: 50n,
  };
  assert.doesNotThrow(() => validatePayerTokenAccount(valid));

  const invalidCases: Array<{
    input: Parameters<typeof validatePayerTokenAccount>[0];
    code: string;
  }> = [
    {
      input: { ...valid, tokenAccount: null },
      code: "PAYER_TOKEN_ACCOUNT_NOT_FOUND",
    },
    {
      input: {
        ...valid,
        tokenAccount: paymentAccount({ mint: ROOT_REGISTRAR }),
      },
      code: "PAYER_TOKEN_ACCOUNT_INVALID",
    },
    {
      input: {
        ...valid,
        tokenAccount: paymentAccount({ owner: ROOT_REGISTRAR }),
      },
      code: "PAYER_TOKEN_ACCOUNT_INVALID",
    },
    {
      input: { ...valid, accountMetaOwner: ROOT_REGISTRAR },
      code: "PAYER_TOKEN_ACCOUNT_INVALID",
    },
    {
      input: {
        ...valid,
        tokenAccount: paymentAccount({ isFrozen: true }),
      },
      code: "PAYER_TOKEN_ACCOUNT_INVALID",
    },
    {
      input: {
        ...valid,
        tokenAccount: paymentAccount({ amount: 49n }),
      },
      code: "INSUFFICIENT_PAYMENT_BALANCE",
    },
  ];

  for (const invalid of invalidCases) {
    assert.throws(
      () => validatePayerTokenAccount(invalid.input),
      (error: unknown) =>
        error instanceof PurchaseError && error.code === invalid.code,
    );
  }
});

test("validates the configured treasurer token account like the official CLI", () => {
  const valid = {
    tokenAccount: paymentAccount({ owner: ROOT_REGISTRAR }),
    accountMetaOwner: TOKEN_PROGRAM,
    expectedTokenProgramId: TOKEN_PROGRAM,
    expectedMint: PAYMENT_MINT,
  };
  assert.doesNotThrow(() => validateTreasurerTokenAccount(valid));
  for (const input of [
    { ...valid, tokenAccount: null },
    { ...valid, accountMetaOwner: ROOT_REGISTRAR },
    {
      ...valid,
      tokenAccount: paymentAccount({
        owner: ROOT_REGISTRAR,
        mint: ROOT_REGISTRAR,
      }),
    },
    {
      ...valid,
      tokenAccount: paymentAccount({
        owner: ROOT_REGISTRAR,
        isFrozen: true,
      }),
    },
  ]) {
    assert.throws(
      () => validateTreasurerTokenAccount(input),
      (error: unknown) =>
        error instanceof PurchaseError && error.code === "CONFIG_INVALID",
    );
  }
});

test("derives the current wallet payment account without creating it", async () => {
  const expectedAddress = derivePaymentTokenAccountAddress({
    walletAddress: WALLET,
    paymentMint: PAYMENT_MINT,
    tokenProgramId: TOKEN_PROGRAM,
  });
  let readAddress = "";
  const prepared = await preparePurchaseDomain({
    label: LABEL,
    years: 2,
    walletAddress: WALLET,
    lookupName: async () => availableSnapshot(),
    readTokenAccount: async (address) => {
      if (address === expectedAddress) readAddress = address;
      return {
        info:
          address === TREASURER
            ? paymentAccount({ owner: ROOT_REGISTRAR })
            : paymentAccount(),
        accountMetaOwner: TOKEN_PROGRAM,
      };
    },
  });

  assert.equal(readAddress, expectedAddress);
  assert.equal(prepared.payerTokenAccount, expectedAddress);
});

test("read-only quotes retain exact price when payment is missing or insufficient", async () => {
  const missing = await quotePurchaseDomain({
    label: LABEL,
    years: 1,
    walletAddress: WALLET,
    payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    lookupName: async () => availableSnapshot(),
    readTokenAccount: async (address) => ({
      info:
        address === TREASURER
          ? paymentAccount({ owner: ROOT_REGISTRAR })
          : null,
      accountMetaOwner: TOKEN_PROGRAM,
    }),
  });
  assert.equal(missing.price, PRICE_PER_YEAR);
  assert.deepEqual(missing.payment, {
    status: "missing",
    code: "PAYER_TOKEN_ACCOUNT_NOT_FOUND",
    message: "The wallet payment token account does not exist.",
  });

  const insufficient = await quotePurchaseDomain({
    label: LABEL,
    years: 1,
    walletAddress: WALLET,
    payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    lookupName: async () => availableSnapshot(),
    readTokenAccount: async (address) => ({
      info:
        address === TREASURER
          ? paymentAccount({ owner: ROOT_REGISTRAR })
          : paymentAccount({ amount: PRICE_PER_YEAR - 1n }),
      accountMetaOwner: TOKEN_PROGRAM,
    }),
  });
  assert.equal(insufficient.price, PRICE_PER_YEAR);
  assert.equal(insufficient.payment.status, "insufficient");
});

function finalAccountsForBuild(options: BuildTransactionOptions): Pubkey[] {
  const sort = (values: NonNullable<typeof options.accounts>["readWrite"]) =>
    (values ?? [])
      .map((value) => Pubkey.from(value))
      .sort((left, right) =>
        compareAddressBytes(left.toThruFmt(), right.toThruFmt()),
      );
  return [
    Pubkey.from(options.feePayer.publicKey),
    Pubkey.from(options.program),
    ...sort(options.accounts?.readWrite),
    ...sort(options.accounts?.readOnly),
  ];
}

test("builds with exact resource values, groups, and post-sort indexes", async () => {
  let capturedOptions: BuildTransactionOptions | undefined;
  let capturedInstruction: Uint8Array | undefined;
  const transaction: PurchaseTransaction = {
    async sign() {},
    toWire: () => new Uint8Array([1]),
  };

  await buildPurchaseTransaction({
    prepared: preparedPurchase(),
    walletPublicKey: WALLET_ACCOUNT.publicKey,
    leaseProof: new Uint8Array([0xaa]),
    domainProof: new Uint8Array([0xbb]),
    buildTransaction: async (options) => {
      capturedOptions = options;
      const accounts = finalAccountsForBuild(options);
      assert.equal(typeof options.instructionData, "function");
      if (typeof options.instructionData !== "function") {
        throw new Error("expected dynamic instruction builder");
      }
      capturedInstruction = await options.instructionData({
        accounts,
        getAccountIndex(value) {
          const expected = Pubkey.from(value).toThruFmt();
          return accounts.findIndex(
            (account) => account.toThruFmt() === expected,
          );
        },
      });
      return transaction;
    },
  });

  assert.ok(capturedOptions);
  assert.deepEqual(capturedOptions.header, PURCHASE_TRANSACTION_RESOURCES);
  const layout = buildPurchaseAccountLayout(purchaseAccounts());
  assert.deepEqual(
    capturedOptions.accounts?.readWrite,
    layout.sortedReadWriteAccounts,
  );
  assert.deepEqual(
    capturedOptions.accounts?.readOnly,
    layout.sortedReadOnlyAccounts,
  );
  assert.equal(capturedInstruction?.length, 93);
  assert.deepEqual(capturedInstruction?.slice(91), new Uint8Array([0xaa, 0xbb]));
});

function successfulSend(
  events?: string[],
): PurchaseEngineDependencies["sendAndTrack"] {
  return async function* () {
    events?.push("send");
    const signature = new Uint8Array(64);
    signature[0] = 1;
    const update: SendAndTrackTxnUpdate = {
      status: SubmissionStatus.ACCEPTED,
      signature: { value: signature },
      consensusStatus: ConsensusStatus.FINALIZED,
      executionResult: {
        vmError: 0,
        consumedComputeUnits: 1,
        userErrorCode: 0n,
      },
    };
    yield update;
  };
}

function engineBuild(
  events: string[],
  counters: { signs: number },
): PurchaseEngineDependencies["buildTransaction"] {
  return async (options) => {
    events.push("build");
    const accounts = finalAccountsForBuild(options);
    if (typeof options.instructionData !== "function") {
      throw new Error("dynamic instruction builder required");
    }
    await options.instructionData({
      accounts,
      getAccountIndex(value) {
        const expected = Pubkey.from(value).toThruFmt();
        return accounts.findIndex(
          (account) => account.toThruFmt() === expected,
        );
      },
    });
    return {
      async sign(privateKey) {
        events.push("sign");
        counters.signs += 1;
        assert.equal(privateKey, WALLET_ACCOUNT.privateKey);
      },
      toWire() {
        return new Uint8Array([1, 2, 3]);
      },
    };
  };
}

function happyDependencies(events: string[] = []): {
  dependencies: PurchaseEngineDependencies;
  counters: {
    lookups: number;
    tokenReads: number;
    proofs: number;
    signs: number;
  };
} {
  const counters = {
    lookups: 0,
    tokenReads: 0,
    proofs: 0,
    signs: 0,
  };
  return {
    counters,
    dependencies: {
      lookupName: async () => {
        counters.lookups += 1;
        events.push(`lookup-${counters.lookups}`);
        return counters.lookups <= 3
          ? availableSnapshot({
              config: registrarConfig({
                totalDomainsSold: BigInt(10 + counters.lookups),
              }),
            })
          : foundSnapshot();
      },
      readTokenAccount: async (address) => {
        counters.tokenReads += 1;
        const kind =
          address === PAYER_TOKEN_ACCOUNT
            ? "payer"
            : address === TREASURER
              ? "treasurer"
              : "unexpected";
        events.push(`token-${kind}-${counters.tokenReads}`);
        assert.notEqual(kind, "unexpected");
        return {
          info:
            kind === "treasurer"
              ? paymentAccount({ owner: ROOT_REGISTRAR })
              : paymentAccount(),
          accountMetaOwner: TOKEN_PROGRAM,
        };
      },
      generateCreationProof: async (address) => {
        counters.proofs += 1;
        events.push(address === LEASE ? "proof-lease" : "proof-domain");
        return address === LEASE
          ? new Uint8Array([0xaa])
          : new Uint8Array([0xbb]);
      },
      buildTransaction: engineBuild(events, counters),
      sendAndTrack: successfulSend(events),
      sleep: async () => {},
    },
  };
}

test("refetches config and availability immediately before signing", async () => {
  const events: string[] = [];
  const { dependencies, counters } = happyDependencies(events);
  const result = await purchaseThruName(
    WALLET_ACCOUNT,
    {
      label: LABEL,
      years: 2,
      payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    },
    {
      dependencies,
      postStateIntervalMs: 0,
    },
  );

  assert.equal(result.price, 50n);
  assert.equal(result.postState.domain.status, "found");
  assert.equal(counters.lookups, 4);
  assert.equal(counters.tokenReads, 6);
  assert.equal(counters.proofs, 2);
  assert.equal(counters.signs, 1);
  assert.deepEqual(events, [
    "lookup-1",
    "token-payer-1",
    "token-treasurer-2",
    "lookup-2",
    "token-payer-3",
    "token-treasurer-4",
    "proof-lease",
    "proof-domain",
    "build",
    "lookup-3",
    "token-payer-5",
    "token-treasurer-6",
    "sign",
    "send",
    "lookup-4",
  ]);
});

test("verified .thru ownership resolves a tracker that ends before FINALIZED", async (t) => {
  const events: string[] = [];
  const { dependencies, counters } = happyDependencies(events);
  let sends = 0;
  dependencies.sendAndTrack = async function* () {
    sends += 1;
    const signature = new Uint8Array(64);
    signature[0] = 1;
    yield {
      status: SubmissionStatus.ACCEPTED,
      signature: { value: signature },
      consensusStatus: ConsensusStatus.OBSERVED,
      executionResult: {
        vmError: 0,
        consumedComputeUnits: 1,
        userErrorCode: 0n,
      },
    };
  };
  t.mock.method(thru.transactions, "get", async () => {
    throw new Error("Finalized transaction lookup unavailable");
  });

  const result = await purchaseThruName(
    WALLET_ACCOUNT,
    {
      label: LABEL,
      years: 1,
      payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    },
    {
      dependencies,
      postStateIntervalMs: 0,
    },
  );

  assert.equal(result.postState.domain.status, "found");
  assert.equal(result.postState.lease.status, "found");
  assert.equal(counters.lookups, 4);
  assert.equal(sends, 1);
});

test("reports truthful purchase progress in transaction order", async () => {
  const { dependencies } = happyDependencies();
  const progress: string[] = [];
  await purchaseThruName(
    WALLET_ACCOUNT,
    {
      label: LABEL,
      years: 1,
      payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    },
    {
      dependencies,
      postStateIntervalMs: 0,
      onProgress: (stage) => progress.push(stage),
    },
  );

  assert.deepEqual(progress, PURCHASE_PROGRESS_STAGES);
});

test("rejects an existing name before proof generation", async () => {
  let proofs = 0;
  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          dependencies: {
            lookupName: async () => foundSnapshot(),
            readTokenAccount: async () => ({
              info: paymentAccount(),
              accountMetaOwner: TOKEN_PROGRAM,
            }),
            generateCreationProof: async () => {
              proofs += 1;
              return new Uint8Array([1]);
            },
          },
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "NAME_UNAVAILABLE",
  );
  assert.equal(proofs, 0);
});

test("treats an expired existing lease as unavailable", async () => {
  const expired = foundSnapshot(WALLET, {
    lease: {
      status: "found",
      address: LEASE,
      state: {
        domainAccount: DOMAIN,
        owner: WALLET,
        domainName: LABEL,
        leaseStart: 1n,
        leaseEnd: 1n,
      },
    },
  });
  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          dependencies: {
            lookupName: async () => expired,
          },
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "NAME_UNAVAILABLE",
  );
});

test("a final availability refetch can stop signing and submission", async () => {
  let lookups = 0;
  let signs = 0;
  let sends = 0;
  const events: string[] = [];
  const dependencies = happyDependencies(events).dependencies;
  dependencies.lookupName = async () => {
    lookups += 1;
    return lookups < 3 ? availableSnapshot() : foundSnapshot();
  };
  dependencies.buildTransaction = async () => ({
    async sign() {
      signs += 1;
    },
    toWire: () => new Uint8Array([1]),
  });
  dependencies.sendAndTrack = async function* () {
    sends += 1;
  };

  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        { dependencies },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "NAME_UNAVAILABLE",
  );
  assert.equal(lookups, 3);
  assert.equal(signs, 0);
  assert.equal(sends, 0);
});

test("a changed config is rejected before signing", async () => {
  let lookups = 0;
  let signs = 0;
  const dependencies = happyDependencies().dependencies;
  dependencies.lookupName = async () => {
    lookups += 1;
    return availableSnapshot({
      config: registrarConfig({
        pricePerYear: lookups === 3 ? 26n : 25n,
      }),
    });
  };
  dependencies.buildTransaction = async () => ({
    async sign() {
      signs += 1;
    },
    toWire: () => new Uint8Array([1]),
  });

  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        { dependencies },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "CONFIG_INVALID",
  );
  assert.equal(signs, 0);
});

test("prevents concurrent duplicate submission for the same wallet and label", async () => {
  const controller = new AbortController();
  const pending = purchaseThruName(
    WALLET_ACCOUNT,
    {
      label: LABEL,
      years: 1,
      payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    },
    {
      signal: controller.signal,
      dependencies: {
        lookupName: (_label, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
      },
    },
  );
  await Promise.resolve();

  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          dependencies: {
            lookupName: async () => availableSnapshot(),
          },
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "TRANSACTION_REJECTED",
  );

  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "OPERATION_ABORTED",
  );
});

test("success requires a matching current-wallet post-state owner", async () => {
  const matching = await verifyPurchasedDomain({
    label: LABEL,
    expectedOwner: WALLET,
    expected: preparedPurchase(),
    maxAttempts: 1,
    lookupName: async () => foundSnapshot(),
  });
  assert.equal(matching.domain.status, "found");

  await assert.rejects(
    () =>
      verifyPurchasedDomain({
        label: LABEL,
        expectedOwner: WALLET,
        expected: preparedPurchase(),
        maxAttempts: 1,
        lookupName: async () => foundSnapshot(ROOT_REGISTRAR),
      }),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "POST_STATE_MISMATCH",
  );
});

test("transaction submission is not success when post-state mismatches", async () => {
  const { dependencies } = happyDependencies();
  let lookups = 0;
  dependencies.lookupName = async () => {
    lookups += 1;
    return lookups <= 3
      ? availableSnapshot()
      : foundSnapshot(ROOT_REGISTRAR);
  };

  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          dependencies,
          postStateMaxAttempts: 1,
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "POST_STATE_MISMATCH",
  );
});

test("supports caller abort without broadcasting", async () => {
  const controller = new AbortController();
  let sends = 0;
  const pending = purchaseThruName(
    WALLET_ACCOUNT,
    {
      label: LABEL,
      years: 1,
      payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
    },
    {
      signal: controller.signal,
      dependencies: {
        lookupName: (_label, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new Error("cancelled")),
              { once: true },
            );
          }),
        sendAndTrack: async function* () {
          sends += 1;
        },
      },
    },
  );
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "OPERATION_ABORTED",
  );
  assert.equal(sends, 0);
});

test("maps the operation deadline to TRANSACTION_TIMEOUT", async () => {
  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          timeoutMs: 5,
          dependencies: {
            lookupName: () => new Promise(() => {}),
          },
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "TRANSACTION_TIMEOUT",
  );
});

test("the deadline also interrupts a silent transaction tracker", async () => {
  const { dependencies } = happyDependencies();
  dependencies.sendAndTrack = () => {
    const iterator: AsyncIterableIterator<SendAndTrackTxnUpdate> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => new Promise<IteratorResult<SendAndTrackTxnUpdate>>(() => {}),
      return: async () => ({ done: true, value: undefined }),
    };
    return iterator;
  };

  await assert.rejects(
    () =>
      purchaseThruName(
        WALLET_ACCOUNT,
        {
          label: LABEL,
          years: 1,
          payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
        },
        {
          timeoutMs: 10,
          dependencies,
        },
      ),
    (error: unknown) =>
      error instanceof PurchaseError && error.code === "TRANSACTION_TIMEOUT",
  );
});

test("does not log secrets or add custom analytics tracking", async () => {
  const source = readFileSync(
    join(process.cwd(), "lib/thru/name-service/purchase.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bconsole\./);
  assert.doesNotMatch(source, /@vercel\/analytics|analytics\.|captureEvent/i);

  const originalLog = console.log;
  const logged: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const { dependencies } = happyDependencies();
    dependencies.buildTransaction = async () => ({
      async sign() {
        throw new Error("private material: 5a5a5a5a");
      },
      toWire: () => new Uint8Array([1]),
    });
    await assert.rejects(
      () =>
        purchaseThruName(
          WALLET_ACCOUNT,
          {
            label: LABEL,
            years: 1,
            payerTokenAccountAddress: PAYER_TOKEN_ACCOUNT,
          },
          { dependencies },
        ),
      (error: unknown) => {
        assert.ok(error instanceof PurchaseError);
        assert.equal(error.code, "TRANSACTION_BUILD_FAILED");
        assert.doesNotMatch(error.message, /5a5a5a5a|private material/i);
        return true;
      },
    );
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(logged, []);
});

test("disabled Identity purchase engine has no memory-only uncertain deadlock map", () => {
  const source = readFileSync(
    join(process.cwd(), "lib/thru/name-service/purchase.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /UNCERTAIN_PURCHASES/);
});
