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
 * Bu modül @thru/sdk@0.2.39 üzerinde, npm registry'den indirilip
 * `dist/*.d.ts` dosyaları incelenerek doğrulanmış gerçek API'ye göre yazıldı:
 *   - thru.keys.generateKeyPair()
 *   - thru.keys.fromPrivateKey(privateKey)
 *   - MnemonicGenerator (@thru/sdk/crypto)
 *   - ThruHDWallet (@thru/sdk/crypto)
 */

import { createThruClient, type GeneratedKeyPair } from "@thru/sdk";
import { MnemonicGenerator, ThruHDWallet } from "@thru/sdk/crypto";

// Thru AlphaNet resmi RPC endpoint'i (@thru/sdk README'sinde belirtilen adres)
export const ALPHANET_RPC_URL = "https://rpc.alphanet.thru.org";

// Resmi Thru block explorer'ı (scan.thru.org) — adres sayfası deseni doğrulandı.
export function explorerAddressUrl(address: string): string {
  return `https://scan.thru.org/address/${address}`;
}

export const thru = createThruClient({
  baseUrl: ALPHANET_RPC_URL,
});

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
    throw new Error("Geçersiz kurtarma ifadesi (mnemonic).");
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
    throw new Error("Private key tam olarak 32 byte (64 hex karakter) olmalıdır.");
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
  signal?: AbortSignal;
}

async function waitForAccountVisibility(
  address: string,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    signal?.throwIfAborted();
    try {
      await thru.accounts.get(address);
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
  const { timeoutMs = 30_000, signal } = options;
  signal?.throwIfAborted();
  try {
    await thru.accounts.get(account.address);
    return false; // zaten vardı, oluşturmaya gerek yoktu
  } catch (err) {
    if (!isAccountNotFoundError(err)) throw err;

    const createTx = await thru.accounts.create({ publicKey: account.publicKey });
    await createTx.sign(account.privateKey);
    let executionFailure: string | null = null;
    for await (const update of thru.transactions.sendAndTrack(createTx.toWire(), {
      timeoutMs,
      signal,
    })) {
      if (!update.executionResult) continue;
      const { vmError, userErrorCode } = update.executionResult;
      if (vmError !== 0 || userErrorCode !== 0n) {
        executionFailure =
          `Account creation failed (vmError: ${vmError}, ` +
          `userErrorCode: ${userErrorCode}).`;
      }
      break;
    }
    if (executionFailure) {
      throw new Error(executionFailure);
    }
    await waitForAccountVisibility(account.address, signal);
    return true; // yeni oluşturuldu
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

/**
 * Private key + (varsa) mnemonic'i tek bir JSON yedek dosyası olarak
 * indirtir. Bu fonksiyon HİÇBİR AĞ İSTEĞİ YAPMAZ — sadece tarayıcının
 * yerel Blob/indirme mekanizmasını kullanır.
 */
export function downloadBackupFile(account: ThruAccount): void {
  const payload = {
    warning:
      "BU DOSYAYI KİMSEYLE PAYLAŞMAYIN. Bu dosyayı gören/ele geçiren herkes " +
      "hesabınızı tam olarak kontrol eder. Şifre sıfırlama YOKTUR.",
    network: "thru-alphanet-testnet",
    address: account.address,
    privateKeyHex: bytesToHex(account.privateKey),
    mnemonic: account.mnemonic ?? null,
    createdAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `thru-alphanet-backup-${account.address.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length !== 64) {
    throw new Error("Private key tam olarak 64 hex karakter olmalıdır.");
  }
  if (!/^[0-9a-f]+$/i.test(clean)) {
    throw new Error("Private key yalnızca 0-9 ve a-f hex karakterlerini içerebilir.");
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
