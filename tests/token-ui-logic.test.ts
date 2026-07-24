import test from "node:test";
import assert from "node:assert/strict";
import { classifyPortfolio } from "../lib/token/portfolio";
import { ITEMS } from "../components/WorkspaceNav";
import type { TokenPortfolioItem, TokenPortfolioAccount } from "../lib/token/thru-token";
import type { MintAccountInfo, TokenAccountInfo } from "@thru/programs/token";

const ACTIVE_WALLET = "taActiveWallet123456789012345678901234567";
const OTHER_WALLET = "taOtherWallet1234567890123456789012345678";

test("classifyPortfolio categorizes by owner and mint authority", () => {
  const portfolio = [
    {
      mintAddress: "mint1",
      mint: { mintAuthority: ACTIVE_WALLET } as unknown as MintAccountInfo,
      tokenAccounts: [],
    },
    {
      mintAddress: "mint2",
      mint: { mintAuthority: OTHER_WALLET } as unknown as MintAccountInfo,
      tokenAccounts: [{ address: "addr1", state: { owner: ACTIVE_WALLET } as unknown as TokenAccountInfo } as TokenPortfolioAccount],
    },
    {
      mintAddress: "mint3",
      mint: { mintAuthority: OTHER_WALLET } as unknown as MintAccountInfo,
      tokenAccounts: [{ address: "addr2", state: { owner: OTHER_WALLET } as unknown as TokenAccountInfo } as TokenPortfolioAccount],
    },
    {
      mintAddress: "mint4",
      tokenAccounts: [{ address: "addr4", state: { owner: OTHER_WALLET } as unknown as TokenAccountInfo } as TokenPortfolioAccount],
    }
  ] as unknown as TokenPortfolioItem[];

  const result = classifyPortfolio(portfolio, ACTIVE_WALLET);
  
  assert.equal(result.activeAssets.length, 2);
  assert.equal(result.activeAssets[0].mintAddress, "mint1", "Mint authority is active wallet");
  assert.equal(result.activeAssets[1].mintAddress, "mint2", "Token account owned by active wallet");
  
  assert.equal(result.externalAssets.length, 2);
  assert.equal(result.externalAssets[0].mintAddress, "mint3", "Neither mint authority nor owner");
  assert.equal(result.externalAssets[1].mintAddress, "mint4", "Neither mint authority nor owner (no mint state)");
});

test("classifyPortfolio returns all as external if no active wallet is connected", () => {
  const portfolio = [
    {
      mintAddress: "mint1",
      mint: { mintAuthority: ACTIVE_WALLET } as unknown as MintAccountInfo,
      tokenAccounts: [{ address: "addr3", state: { owner: ACTIVE_WALLET } as unknown as TokenAccountInfo } as TokenPortfolioAccount],
    },
  ] as unknown as TokenPortfolioItem[];

  const result = classifyPortfolio(portfolio, undefined);
  
  assert.equal(result.activeAssets.length, 0);
  assert.equal(result.externalAssets.length, 1);
});

test("Token Studio nav item does not require an account", () => {
  const tokenNav = ITEMS.find((item) => item.id === "token");
  assert.equal(tokenNav?.requiresAccount, undefined);
});
