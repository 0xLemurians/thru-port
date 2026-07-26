import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Pubkey, type Account } from "@thru/sdk";
import {
  TokenAccount,
  TokenMintAccount,
  deriveTokenAccountAddress,
} from "@thru/programs/token";
import { buildTokenSidebarEntries } from "../components/port/token/PortTokenSidebar";
import {
  createdTokensForWallet,
  loadKnownTokens,
  mergeCreatedTokenRecords,
  restoreCreatedTokenCatalog,
  saveKnownTokens,
  tokenDisplayLabels,
  upsertKnownToken,
  type KnownTokenRecord,
} from "../lib/token/portfolio";
import {
  TOKEN_PROGRAM_ADDRESS,
  discoverControlledTokensOnAlphaNet,
  type CreatedTokenDiscoveryDependencies,
} from "../lib/token/thru-token";
import { thru } from "../lib/wallet/thru-wallet";

function publicAddress(seed: number): string {
  return Pubkey.from(new Uint8Array(32).fill(seed)).toThruFmt();
}

const WALLET = publicAddress(11);
const OTHER_WALLET = publicAddress(12);
const CONTROLLED_MINT = publicAddress(21);
const CREATED_MINT = publicAddress(22);
const FOREIGN_MINT = publicAddress(23);
const TOKEN_PROGRAM = Pubkey.from(TOKEN_PROGRAM_ADDRESS);

function tickerField(ticker: string): Uint8Array {
  const bytes = new TextEncoder().encode(ticker);
  const field = new Uint8Array(9);
  field[0] = bytes.length;
  field.set(bytes, 1);
  return field;
}

function mintAccount(
  address: string,
  creator: string,
  mintAuthority: string,
  ticker: string,
): Account {
  const data = TokenMintAccount.builder()
    .set_decimals(6)
    .set_supply(0n)
    .set_creator(Pubkey.from(creator).toBytes())
    .set_mint_authority(Pubkey.from(mintAuthority).toBytes())
    .set_freeze_authority(new Uint8Array(32))
    .set_has_freeze_authority(0)
    .set_ticker(tickerField(ticker))
    .build();
  return tokenProgramAccount(address, data);
}

function tokenAccount(
  address: string,
  mintAddress: string,
  ownerAddress: string,
  amount: bigint,
): Account {
  const data = TokenAccount.builder()
    .set_mint(Pubkey.from(mintAddress).toBytes())
    .set_owner(Pubkey.from(ownerAddress).toBytes())
    .set_amount(amount)
    .set_is_frozen(0)
    .build();
  return tokenProgramAccount(address, data);
}

function tokenProgramAccount(address: string, data: Uint8Array): Account {
  return {
    address: Pubkey.from(address),
    meta: {
      owner: TOKEN_PROGRAM,
      dataSize: data.length,
    },
    data: { data },
  } as unknown as Account;
}

function discoveryDependencies(
  accounts: Map<string, Account>,
  candidates: string[],
): CreatedTokenDiscoveryDependencies {
  return {
    async listTransactionsForAccount() {
      return {
        transactions: [
          {
            program: TOKEN_PROGRAM,
            readWriteAccounts: candidates.map((address) =>
              Pubkey.from(address),
            ),
          },
        ],
      };
    },
    async getAccount(address) {
      const account = accounts.get(address);
      if (!account) throw new Error("mock account not found");
      return account;
    },
  };
}

test("local name is primary and on-chain ticker is secondary without duplication", () => {
  assert.deepEqual(tokenDisplayLabels("Alper", "ALP"), {
    primary: "Alper",
    secondary: "ALP",
  });
  assert.deepEqual(tokenDisplayLabels(undefined, "ALP"), {
    primary: "ALP",
  });

  const entries = buildTokenSidebarEntries(
    [
      {
        mintAddress: CONTROLLED_MINT,
        label: "Alper",
        mint: { ticker: "ALP" },
        tokenAccounts: [],
      },
    ] as never,
    [
      {
        mintAddress: CONTROLLED_MINT,
        walletAddress: WALLET,
        label: "Alper",
        ticker: "ALP",
        tokenAccountAddresses: [],
      },
    ],
  );
  assert.equal(entries[0].label, "Alper");
  assert.equal(entries[0].secondaryLabel, "ALP");
});

test("valid Unicode, capitalization, and spaces in local names survive persistence", () => {
  const label = "Çılgın Alper Token";
  const record = upsertKnownToken([], {
    mintAddress: CONTROLLED_MINT,
    walletAddress: WALLET,
    label,
    ticker: "ALP",
    decimals: 6,
  });
  let serialized = "";
  saveKnownTokens(
    {
      setItem: (_key, value) => {
        serialized = value;
      },
    },
    record,
  );
  const loaded = loadKnownTokens({
    getItem: () => serialized,
  });
  assert.equal(loaded[0].label, label);
  assert.equal(loaded[0].ticker, "ALP");
});

test("wallet-keyed public records survive removal and reattach only to the same wallet", () => {
  const records = [
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: WALLET,
      label: "Alper",
      ticker: "ALP",
      decimals: 6,
      tokenAccountAddresses: [],
    },
  ];
  assert.equal(createdTokensForWallet(records, WALLET).length, 1);
  assert.equal(createdTokensForWallet(records, OTHER_WALLET).length, 0);

  let serialized = "";
  const storage = {
    getItem: () => serialized || null,
    setItem: (_key: string, value: string) => {
      serialized = value;
    },
  };
  saveKnownTokens(storage, records);
  assert.equal(createdTokensForWallet(loadKnownTokens(storage), WALLET).length, 1);
});

test("backup-style catalog restoration merges duplicates and preserves an existing local name", () => {
  const existing: KnownTokenRecord[] = [
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: WALLET,
      label: "Alper",
      ticker: "ALP",
      decimals: 6,
      tokenAccountAddresses: [],
    },
  ];
  const incoming: KnownTokenRecord[] = [
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: WALLET,
      label: "ALP",
      ticker: "ALP",
      decimals: 6,
      tokenAccountAddresses: [publicAddress(31)],
    },
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: WALLET,
      ticker: "ALP",
      decimals: 6,
      tokenAccountAddresses: [publicAddress(32)],
    },
  ];
  const merged = mergeCreatedTokenRecords(existing, incoming, WALLET);
  const walletRecords = createdTokensForWallet(merged, WALLET);
  assert.equal(walletRecords.length, 1);
  assert.equal(walletRecords[0].label, "Alper");
  assert.deepEqual(walletRecords[0].tokenAccountAddresses, [
    publicAddress(31),
    publicAddress(32),
  ]);
});

test("restored catalog ignores foreign-wallet records", () => {
  let serialized: string | null = null;
  const storage = {
    getItem: () => serialized,
    setItem: (_key: string, value: string) => {
      serialized = value;
    },
  };
  const restored = restoreCreatedTokenCatalog(storage, WALLET, [
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: OTHER_WALLET,
      label: "Foreign",
      ticker: "FOR",
      decimals: 6,
      tokenAccountAddresses: [],
    },
  ]);
  assert.equal(createdTokensForWallet(restored, WALLET).length, 0);
});

test("official history discovery includes creator or current authority and excludes received-only mints", async () => {
  const controlledTokenAccount = deriveTokenAccountAddress(
    thru,
    WALLET,
    CONTROLLED_MINT,
    TOKEN_PROGRAM_ADDRESS,
    new Uint8Array(32),
  ).address;
  const accounts = new Map<string, Account>([
    [
      CONTROLLED_MINT,
      mintAccount(CONTROLLED_MINT, OTHER_WALLET, WALLET, "CTRL"),
    ],
    [
      CREATED_MINT,
      mintAccount(CREATED_MINT, WALLET, OTHER_WALLET, "MADE"),
    ],
    [
      FOREIGN_MINT,
      mintAccount(FOREIGN_MINT, OTHER_WALLET, OTHER_WALLET, "HELD"),
    ],
    [
      controlledTokenAccount,
      tokenAccount(controlledTokenAccount, CONTROLLED_MINT, WALLET, 0n),
    ],
  ]);
  const discovered = await discoverControlledTokensOnAlphaNet(WALLET, {
    dependencies: discoveryDependencies(accounts, [
      CONTROLLED_MINT,
      CREATED_MINT,
      FOREIGN_MINT,
    ]),
  });

  assert.deepEqual(
    discovered.map((record) => record.mintAddress),
    [CONTROLLED_MINT, CREATED_MINT],
  );
  assert.deepEqual(discovered[0].tokenAccountAddresses, [
    controlledTokenAccount,
  ]);
  assert.equal(discovered[0].ticker, "CTRL");
  assert.equal(discovered[1].creatorAddress, WALLET);
  assert.equal(
    discovered.some((record) => record.mintAddress === FOREIGN_MINT),
    false,
  );
});

test("discovery is bounded and uses no signing, submission, faucet, or private key path", async () => {
  let listCalls = 0;
  const dependencies: CreatedTokenDiscoveryDependencies = {
    async listTransactionsForAccount() {
      listCalls += 1;
      return {
        transactions: [],
        nextPageToken: "more",
      };
    },
    async getAccount() {
      throw new Error("unexpected account read");
    },
  };
  const discovered = await discoverControlledTokensOnAlphaNet(WALLET, {
    dependencies,
    maxTransactions: 1,
    maxCandidates: 1,
  });
  assert.deepEqual(discovered, []);
  assert.equal(listCalls, 1);

  const source = fs.readFileSync(
    path.join(process.cwd(), "lib/token/thru-token.ts"),
    "utf8",
  );
  const discoverySource = source.slice(
    source.indexOf("export async function discoverControlledTokensOnAlphaNet"),
    source.indexOf("export function isCreatedTokenControlledByWallet"),
  );
  assert.doesNotMatch(
    discoverySource,
    /privateKey|signTransaction|submit|sendTransaction|faucet/i,
  );
  assert.match(discoverySource, /listTransactionsForAccount/);
  assert.match(
    source,
    /transaction\.header\.program_pubkey\.value == params\.pubkey/,
  );
  assert.match(discoverySource, /getVerifiedMintWith/);
});

test("an RPC discovery failure never deletes retained public records", async () => {
  const retained: KnownTokenRecord[] = [
    {
      mintAddress: CONTROLLED_MINT,
      walletAddress: WALLET,
      label: "Alper",
      ticker: "ALP",
      decimals: 6,
      tokenAccountAddresses: [],
    },
  ];
  await assert.rejects(
    discoverControlledTokensOnAlphaNet(WALLET, {
      dependencies: {
        async listTransactionsForAccount() {
          throw new Error("mock offline");
        },
        async getAccount() {
          throw new Error("unexpected");
        },
      },
    }),
  );
  assert.deepEqual(mergeCreatedTokenRecords(retained, [], WALLET), retained);
});
