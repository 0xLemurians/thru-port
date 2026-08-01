# Thru Port

Thru Port, Thru AlphaNet üzerinde çalışan browser tabanlı bir wallet ve fungible-token dApp'idir. Uygulama Next.js, React ve TypeScript kullanır; zincir erişimi için exact `@thru/sdk@0.3.2` ve `@thru/programs@0.3.2` paketlerine bağlıdır.

AlphaNet bir test ağıdır ve sıfırlanabilir. Buradaki test birimlerinin parasal değeri yoktur.

## Aktif özellikler

### Wallet

- Browser içinde wallet üretimi
- Tam olarak 32-byte Ed25519 private key importu
- Encrypted Backup importu
- IndexedDB üzerinde encrypted wallet persistence
- Browser vault kayıtlarında AES-256-GCM authenticated encryption
- Refresh sonrasında tamamlanmamış yeni-wallet backup adımını koruyan `setupPending` akışı
- AlphaNet account creation ve doğrulanmış account-existence kontrolü
- Kullanıcı tarafından başlatılan AlphaNet faucet akışı
- Public address, transaction signature ve Thru Scan bağlantıları

Visible Recovery Phrase importu bulunmaz. Yeni wallet oluşturma akışı gereksiz mnemonic değerini persisted wallet kaydına eklemez; eski mnemonic içeren wallet kayıtları geriye dönük olarak restore edilmeye devam eder.

### Encrypted Backup

Backup v2 formatı şu ürün kararını bilinçli olarak korur:

- Wallet payload'u AES-GCM ile şifrelenir.
- Top-level `privateKey` alanı plaintext olarak backup JSON içinde bulunur.
- Backup password yalnız encrypted payload'u korur; top-level `privateKey` alanını korumaz.
- Export öncesinde bu durum açıkça uyarılır ve kullanıcı acknowledgment'ı gerekir.
- Import sırasında decrypted payload, public address ve top-level private key tutarlılığı doğrulanır.
- Legacy encrypted backup v1 importu desteklenir.
- Created-token public metadata backup içinde restore edilebilir.

Backup dosyasına erişen herkes wallet'ı kontrol edebilir. Backup hiçbir zaman güvenilmeyen bir yere yüklenmemeli veya paylaşılmamalıdır.

### Token Studio

- Fungible token mint oluşturma
- Wallet'a ait token account oluşturma
- Initial token mint
- Yetkili wallet ile ek supply mint etme
- Token transferi ve destination token-account hazırlama
- Exact `bigint` amount validation ve post-state balance/supply doğrulaması
- Created-token public referanslarının local persistence'ı
- Bounded transaction-history discovery ve yarım kalan setup için resume akışı
- Submitted fakat sonucu belirsiz token işlemleri için public, versioned pending-operation journal

Journal yalnız public adresleri, public transaction signature'larını, raw amount değerlerini ve beklenen public post-state bilgisini tutar. Private key, mnemonic, password veya signed transaction bytes journal'a yazılmaz.

### Identity

Identity registration AlphaNet üzerinde şu anda kapalıdır. Read-only notice/lookup güvenlik kodu korunur ancak UI `.thru` registration transaction'ı başlatmaz.

## Native THRU balance

Resmî Web SDK içinde native THRU decimal denomination sabiti doğrulanamadığı için Dashboard ve wallet popover bakiyeyi kayıpsız raw `native units` olarak gösterir. Rastgele 9 veya 18 decimal varsayımı yapılmaz.

Native THRU send şu anda aktif değildir. Resmî `@thru/sdk` browser API'sinde doğrulanmış bir native-transfer instruction builder bulunmadan manuel protocol bytes oluşturulmaz.

## Transaction güvenliği

- Production transaction signing yalnız resmî SDK `Transaction.sign()` RFC8032 yolu üzerinden yapılır.
- Transaction context ve body imzalamadan önce tamamlanıp doğrulanır.
- `legacySign()` veya Legacy scheme production path'lerinde kullanılmaz.
- Her operation için tek submission yapılır.
- Tracker erken biterse aynı transaction rebuild, re-sign veya rebroadcast edilmez.
- Finalized transaction lookup ve operation'a özgü exact post-state salt-okunur biçimde reconcile edilir.
- Unresolved public signature varken aynı operation tekrar gönderilemez.

## Aktif olmayan özellikler

Bu repository şu anda aşağıdakileri aktif uygulama özelliği olarak sunmaz:

- Native THRU send
- AMM, Swap veya Pools
- Add/Remove Liquidity
- CLOB
- Bonding curve veya launchpad
- Graduation ve LP lock/burn
- Indexer/backend, chart, volume veya holder sistemi
- Passkey wallet migration
- Identity registration

## Çalıştırma

Node.js 20 veya daha yeni bir sürüm gerekir.

```bash
npm install
npm run dev
```

Uygulama varsayılan olarak `http://localhost:3000` adresinde açılır.

## Kontroller

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Hepsini repository script'iyle çalıştırmak için:

```bash
npm run check
```

## Ağ adresleri

- RPC: `https://rpc.alphanet.thru.org`
- Explorer: `https://scan.thru.org`
