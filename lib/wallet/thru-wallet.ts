/**
 * Thru AlphaNet — tarayıcı-native cüzdan modülü.
 *
 * KRİTİK GÜVENLİK KURALI:
 * Bu dosyadaki hiçbir fonksiyon private key'i fetch/XMLHttpRequest ile
 * hiçbir yere göndermez. Tüm işlemler (keypair üretimi, imzalama,
 * mnemonic türetimi) tamamen `@thru/sdk`'nın istemci tarafı (browser-uyumlu,
 * @noble/ed25519 + @noble/hashes + @scure/bip39 tabanlı) kodu ile,
 * bu sekmenin belleğinde gerçekleşir.
 *
 * Bu modül @thru/sdk@0.4.1 üzerinde, npm registry'den indirilip
 * `dist/*.d.ts` dosyaları incelenerek doğrulanmış gerçek API'ye göre yazıldı:
 *   - thru.keys.generateKeyPair()
 *   - thru.keys.fromPrivateKey(privateKey)
 *   - MnemonicGenerator (@thru/sdk/crypto)
 *   - ThruHDWallet (@thru/sdk/crypto)
 */

import {
  ConsensusStatus,
  Signature,
  type GeneratedKeyPair,
} from "@thru/sdk";
import { MnemonicGenerator, ThruHDWallet } from "@thru/sdk/crypto";
import { ACCOUNT_CREATION_RESOURCES } from "@thru/programs/resources";
import {
  ALPHANET_RPC_URL,
  thru,
} from "../thru/client";
import {
  assertFinalizedAccount,
  assertUsableTransactionContext,
  signTransactionForSubmission,
  SubmittedTransactionUncertainError,
  verifySubmittedTransaction,
} from "../thru/transactions";

export { ALPHANET_RPC_URL, thru };

// Resmi Thru block explorer'ı (scan.thru.org) — adres sayfası deseni doğrulandı.
export function explorerAddressUrl(address: string): string {
  return `https://scan.thru.org/address/${address}`;
}

export interface ThruAccount {
  address: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  /** Yalnızca "yeni hesap" akışında dolu olur; import edilen hesaplarda yoktur. */
  mnemonic?: string;
}

export function isAccountNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    (err as { code?: number } | null)?.code === 5 ||
    /not.?found/i.test(message)
  );
}

/**
 * Yepyeni bir Thru AlphaNet hesabı üretir.
 *
 * İki üretim yolu sunuyoruz:
 *  - withMnemonic = true  → 12 kelimelik BIP-39 mnemonic'ten SLIP-0010 ile türetilir.
 *                           Kullanıcı bu 12 kelimeyi yedekler (dosya indirmekten
 *                           çok daha kullanıcı dostu bir yedekleme yöntemi).
 *  - withMnemonic = false → thru.keys.generateKeyPair() ile doğrudan,
 *                           SDK'nın kendi rastgele-seed + HD türetme
 *                           pipeline'ı kullanılır (mnemonic dönmez, sadece
 *                           ham private key döner — "Download private key"
 *                           akışı için).
 */
export async function createNewAccount(
  withMnemonic: boolean,
): Promise<ThruAccount> {
  if (withMnemonic) {
    const mnemonic = MnemonicGenerator.generate();
    return accountFromMnemonic(mnemonic);
  }

  const generated: GeneratedKeyPair = await thru.keys.generateKeyPair();
  return {
    address: generated.address,
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
}

/**
 * 12 kelimelik mnemonic'ten hesabı yeniden türetir (restore akışı).
 */
export async function accountFromMnemonic(mnemonic: string): Promise<ThruAccount> {
  if (!MnemonicGenerator.validate(mnemonic)) {
    throw new Error("Invalid recovery phrase (mnemonic).");
  }

  const seed = MnemonicGenerator.toSeed(mnemonic);
  try {
    const account = await ThruHDWallet.getAccount(seed, 0);
    return {
      address: account.address,
      publicKey: account.publicKey,
      privateKey: account.privateKey,
      mnemonic,
    };
  } finally {
    seed.fill(0);
  }
}

/**
 * Ham private key bytes'tan (dosyadan içe aktarma akışı) hesabı yeniden kurar.
 */
export async function accountFromPrivateKey(
  privateKey: Uint8Array,
): Promise<ThruAccount> {
  if (privateKey.length !== 32) {
    throw new Error("Private key must be exactly 32 bytes (64 hex characters).");
  }

  // Caller-owned buffer ile account state'inin aynı mutable byte dizisini
  // paylaşmasını önle.
  const privateKeyCopy = new Uint8Array(privateKey);
  const publicKey = await thru.keys.fromPrivateKey(privateKeyCopy);
  // encodeAddress helper'ı @thru/sdk/helpers altında; burada dolaylı olarak
  // ThruHDWallet'ın kullandığı aynı adres kodlamasına thru.helpers üzerinden erişiyoruz.
  const address = await addressFromPublicKey(publicKey);

  return { address, publicKey, privateKey: privateKeyCopy };
}

function secureBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export async function assertAccountIdentity(
  account: ThruAccount,
): Promise<void> {
  let reconstructed: ThruAccount | null = null;
  let mnemonicAccount: ThruAccount | null = null;
  try {
    reconstructed = await accountFromPrivateKey(account.privateKey);
    if (
      reconstructed.address !== account.address ||
      !secureBytesEqual(reconstructed.publicKey, account.publicKey)
    ) {
      throw new Error(
        "Wallet key material does not match its public address.",
      );
    }
    if (account.mnemonic) {
      mnemonicAccount = await accountFromMnemonic(account.mnemonic);
      if (
        mnemonicAccount.address !== account.address ||
        !secureBytesEqual(mnemonicAccount.publicKey, account.publicKey) ||
        !secureBytesEqual(mnemonicAccount.privateKey, account.privateKey)
      ) {
        throw new Error(
          "Wallet recovery material does not match its public address.",
        );
      }
    }
  } finally {
    reconstructed?.privateKey.fill(0);
    mnemonicAccount?.privateKey.fill(0);
    if (mnemonicAccount) mnemonicAccount.mnemonic = undefined;
  }
}

async function addressFromPublicKey(publicKey: Uint8Array): Promise<string> {
  const { encodeAddress } = await import("@thru/sdk/helpers");
  return encodeAddress(publicKey);
}

/**
 * Yeni üretilen bir keypair, ilk on-chain işlemine kadar zincirde "var"
 * sayılmaz — `thru.accounts.get()` "[not_found] account not found" hatası
 * döner ve normal transaction'lar (ör. faucet withdraw) nonce alamadığı
 * için başarısız olur.
 *
 * Bunun çözümü normal bir transfer değil, özel bir "state proof" tabanlı
 * create transaction'ı (Rust CLI: `TransactionBuilder::build_create_with_
 * fee_payer_proof` + `makeStateProof` RPC). @thru/sdk bunu `thru.accounts.
 * create()` ile sarmalıyor; kalıbı Unto-Labs/thru reposundaki resmi test
 * script'inden (thru-ts-client-sdk/test-scripts/counter-2.ts:270-280)
 * birebir aldık.
 */
export interface EnsureAccountOptions {
  timeoutMs?: number;
  verificationTimeoutMs?: number;
  signal?: AbortSignal;
}

const ACTIVE_ACCOUNT_CREATIONS = new Set<string>();
const UNCERTAIN_ACCOUNT_CREATIONS = new Map<string, string>();

async function waitForAccountVisibility(
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal?.throwIfAborted();
    try {
      const account = await thru.accounts.get(address);
      assertFinalizedAccount(account);
      if (account.address.toThruFmt() !== address) {
        throw new Error(
          "The finalized account does not match the active wallet.",
        );
      }
      return;
    } catch (err) {
      lastError = err;
      if (!isAccountNotFoundError(err)) throw err;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeout);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.min(500 * 2 ** attempt, 4_000));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  throw new Error(
    `Account creation was submitted but the account is still unavailable: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function ensureAccountExists(
  account: ThruAccount,
  options: EnsureAccountOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 30_000,
    verificationTimeoutMs = Math.min(timeoutMs, 45_000),
    signal,
  } = options;
  signal?.throwIfAborted();
  try {
    await thru.accounts.get(account.address);
    UNCERTAIN_ACCOUNT_CREATIONS.delete(account.address);
    return false; // zaten vardı, oluşturmaya gerek yoktu
  } catch (err) {
    if (!isAccountNotFoundError(err)) throw err;
  }

  const uncertainSignature = UNCERTAIN_ACCOUNT_CREATIONS.get(account.address);
  if (uncertainSignature) {
    throw new SubmittedTransactionUncertainError(
      uncertainSignature,
    );
  }
  if (ACTIVE_ACCOUNT_CREATIONS.has(account.address)) {
    throw new Error("Account creation is already in progress.");
  }

  ACTIVE_ACCOUNT_CREATIONS.add(account.address);
  let submitted = false;
  let submittedSignature = "";
  let definitiveExecutionFailure = false;
  try {
    const createTx = await thru.accounts.create({
      publicKey: account.publicKey,
      header: { ...ACCOUNT_CREATION_RESOURCES },
    });
    signal?.throwIfAborted();
    assertUsableTransactionContext(createTx);
    await signTransactionForSubmission(
      createTx,
      account.privateKey,
      signal,
    );
    let signature = createTx.getSignature()?.toThruFmt() ?? "";
    submittedSignature = signature;

    let executionFailure: string | null = null;
    let executionSucceeded = false;
    let finalized = false;
    const signedTransaction = createTx.toWire();
    signal?.throwIfAborted();
    submitted = true;
    try {
      for await (const update of thru.transactions.sendAndTrack(
        signedTransaction,
        {
          timeoutMs,
          signal,
        },
      )) {
        if (update.executionResult) {
          const { vmError, userErrorCode } = update.executionResult;
          if (vmError !== 0 || userErrorCode !== 0n) {
            executionFailure =
              `Account creation failed (vmError: ${vmError}, ` +
              `userErrorCode: ${userErrorCode}).`;
            definitiveExecutionFailure = true;
          } else {
            executionSucceeded = true;
          }
        }
        if (update.signature?.value) {
          const trackedSignature = Signature.from(
            update.signature.value,
          ).toThruFmt();
          if (signature && trackedSignature !== signature) {
            definitiveExecutionFailure = true;
            throw new Error(
              "The tracked account-creation signature does not match.",
            );
          }
          signature = trackedSignature;
          submittedSignature = trackedSignature;
        }
        if (update.consensusStatus === ConsensusStatus.FINALIZED) {
          finalized = true;
        }
        if (executionFailure || (executionSucceeded && finalized)) break;
      }
    } catch (error) {
      if (!submitted || definitiveExecutionFailure || !signature) {
        throw error;
      }
      // The original signed transaction is already submitted. Continue with
      // bounded read-only verification; never rebuild, sign, or send again.
    }
    if (executionFailure) {
      throw new Error(executionFailure);
    }
    if (!executionSucceeded || !finalized) {
      const verification = await verifySubmittedTransaction({
        signature,
        verifyExpectedState: async () => {
          try {
            const createdAccount = await thru.accounts.get(account.address);
            assertFinalizedAccount(createdAccount);
            if (createdAccount.address.toThruFmt() !== account.address) {
              throw new Error(
                "The finalized account does not match the active wallet.",
              );
            }
            return true;
          } catch (error) {
            if (isAccountNotFoundError(error)) return false;
            throw error;
          }
        },
        classifyExpectedStateError: (error) =>
          error instanceof Error &&
          /does not match the active wallet/i.test(error.message)
            ? "failure"
            : "pending",
        // Submission has already started. Caller cancellation must not stop
        // read-only reconciliation or make an automatic retry appear safe.
        signal: undefined,
        timeoutMs: verificationTimeoutMs,
      });
      if (verification.outcome === "failure") {
        definitiveExecutionFailure = true;
        throw new Error(
          "Account creation could not be verified for the active wallet.",
        );
      }
    }

    await waitForAccountVisibility(
      account.address,
      submitted ? undefined : signal,
    );
    UNCERTAIN_ACCOUNT_CREATIONS.delete(account.address);
    return true; // yeni oluşturuldu
  } catch (error) {
    if (submitted && !definitiveExecutionFailure) {
      if (submittedSignature) {
        UNCERTAIN_ACCOUNT_CREATIONS.set(
          account.address,
          submittedSignature,
        );
      }
    }
    throw error;
  } finally {
    ACTIVE_ACCOUNT_CREATIONS.delete(account.address);
  }
}

/**
 * Hesap bakiyesini sorgular (salt-okunur, key gerektirmez).
 * Balance alanı raw birimde döner (repo'daki CLI ile tutarlı — 10_000 birim
 * = faucet'in tek seferde verdiği miktar).
 */
export async function getBalance(address: string): Promise<bigint> {
  const account = await thru.accounts.get(address);
  return account.meta?.balance ?? 0n;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length !== 64) {
    throw new Error("Private key must be exactly 64 hex characters.");
  }
  if (!/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("Private key can only contain hex characters (0-9, a-f).");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
