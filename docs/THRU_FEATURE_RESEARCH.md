# Thru Studio Özellikleri Teknik Araştırması

Tarih: 23 Temmuz 2026  
Kapsam: Token Studio, Name Studio ve NFT Studio  
Durum: Araştırma ve uygulama öncesi karar dokümanı; bu çalışma uygulama kodu içermez.

## 1. Kapsam ve kanıt sınıfları

Bu rapor yalnızca görevde belirtilen resmî Thru dokümanları ile projede yerel olarak
kurulu paketlerin gerçek JavaScript kaynakları ve TypeScript tanımları kullanılarak
hazırlandı.

Rapordaki sonuçlar şu sınıflardan biriyle değerlendirilmelidir:

- **Dokümante:** Görevde verilen resmî Thru sayfasında açıkça belirtiliyor.
- **Yerelde doğrulandı:** Kurulu paketin yayımlanmış JavaScript veya `.d.ts`
  dosyasında mevcut.
- **Çıkarım:** Dokümante edilen veri modelinin teknik sonucu; API taahhüdü değildir.
- **Belirsiz/engel:** Verilen kaynaklar güvenli bir uygulama yapmak için yeterli
  değildir.

Özellikle belirsiz olarak işaretlenen program adresleri, hesap listeleri veya
instruction encoding ayrıntıları tahmin edilmemelidir.

## 2. Sürüm ve uyumluluk sonucu

### 2.1 Projede fiilen kurulu paketler

| Paket | `package.json` | `node_modules` | Sonuç |
|---|---:|---:|---|
| `@thru/sdk` | `^0.2.39` | `0.2.39` | Kaynak ve tipler incelendi |
| `@thru/programs` | Yok | Yok | Kurulu değil; kaynak ve tipler incelenemedi |

Kritik sonuç: Görev tanımında `@thru/programs` kurulu olarak anılıyor olsa da proje
manifestinde, lock dosyasının doğrudan bağımlılıklarında ve `node_modules` altında
bu paket bulunmuyor. Bu araştırma sırasında paket kurulmadı. Dolayısıyla
`@thru/programs/token` dokümanındaki builder adlarının güncel bir paket sürümünde
gerçekten bulunduğu veya imzalarının örneklerle birebir aynı olduğu yerel olarak
doğrulanmış değildir.

### 2.2 `@thru/sdk@0.2.39` için doğrulanan yüzey

Kurulu paketin export haritasında şu girişler var:

- `@thru/sdk`
- `@thru/sdk/client`
- `@thru/sdk/proto`
- `@thru/sdk/helpers`
- `@thru/sdk/crypto`
- `@thru/sdk/abi`

Yerel kaynak ve tiplerde doğrulanan ilgili yetenekler:

- `createThruClient`
- `thru.transactions.build`, `buildAndSign`, `send`, `sendAndTrack`, `track`,
  `getStatus`
- `thru.accounts.get`, `getRaw`, `list`, `stream`, `create`
- `thru.proofs.generate`
- `StateProofType.CREATING`, `UPDATING`, `EXISTING`
- `thru.helpers.deriveProgramAddress`, `deriveAddress`
- `@thru/sdk/abi` altında ABI reflection/layout/on-chain ABI okuma yardımcıları

`transactions.build` girdisi yerel tiplerde fee payer, program, read-write/read-only
hesaplar, instruction data ve fee-payer state proof alanlarını destekliyor.
Instruction data doğrudan byte dizisi olabildiği gibi son hesap sıralamasını alan
bir callback de olabiliyor. Bu, ABI builder’larının hesap indekslerini transaction
oluşturulurken çözebilmesine imkân veriyor.

`sendAndTrack` güncellemelerinde submission status, signature, numeric consensus
status ve varsa `executionResult.vmError`, `executionResult.userErrorCode` ile
`consumedComputeUnits` bulunuyor.

### 2.3 Güncel dokümanlarla uyumluluk

| Alan | Doküman ↔ `@thru/sdk@0.2.39` |
|---|---|
| Client, transaction build/send/track | Temel yüzey uyumlu görünüyor |
| Read-write/read-only hesap listeleri | Yerel tiplerle uyumlu |
| State proof üretimi | Yerel pakette mevcut |
| Program address derivation | Yerel pakette mevcut |
| ABI reflection ve on-chain ABI okuma | Yerel pakette mevcut |
| TypeScript ABI codegen | `@thru/sdk/abi` runtime export’u olarak doğrulanmadı; doküman CLI/codegen akışına dayanıyor |
| Token instruction builder’ları | Dokümanda `@thru/programs/token`; paket yerelde yok, uyumluluk doğrulanamaz |
| Name/NFT instruction builder’ları | `@thru/programs` dokümanında bu modüller için public subpath gösterilmiyor |

Resmî sayfalarda dokümanın hangi `@thru/sdk` ve `@thru/programs` sürümlerini hedeflediğini
gösteren sabit bir sürüm matrisi yok. Bu yüzden yalnızca benzer API şekli görülmesi
tam uyumluluk kanıtı değildir. Uygulamadan önce tam paket sürümü sabitlenmeli ve
builder imzaları TypeScript derlemesi ile doğrulanmalıdır.

## 3. Ortak transaction ve doğrulama modeli

Üç Studio için de güvenli ortak model şudur:

1. Ağ/chain kimliği ile program adresleri güvenilir, uygulama tarafından kontrol
   edilen bir konfigürasyondan alınır.
2. Hesap adresleri dokümante edilen seed ve program adresiyle türetilir.
3. Yeni on-chain hesap gerekiyorsa güncel slot için `CREATING` state proof üretilir.
4. Instruction yalnızca doğrulanmış builder veya doğrulanmış ABI çıktısıyla
   encode edilir.
5. Transaction fee payer tarafından yerelde imzalanır. Private key ve mnemonic
   instruction’a, RPC isteğine, analytics’e veya loga konmaz.
6. `sendAndTrack` akışı terminal duruma kadar izlenir.
7. Başarı için yalnızca signature oluşması yeterli sayılmaz:
   - submission başarısı,
   - final consensus durumu,
   - `vmError === 0`,
   - `userErrorCode === 0`
   kontrol edilir.
8. Son olarak etkilenen hesaplar RPC’den yeniden okunur ve beklenen state değişimi
   doğrulanır.

Numeric consensus değerleri sihirli sayı olarak kullanılmamalı; kurulu
`@thru/sdk/proto` enum sabitiyle karşılaştırılmalıdır. Timeout sonucu da başarısızlık
olarak etiketlenmeden önce signature ile transaction status yeniden sorgulanmalıdır.

## 4. Token Studio

### 4.1 Desteklenen işlemler

Resmî Token Program dokümanı şu instruction’ları tanımlar:

- `initialize_mint`
- `initialize_account`
- `transfer`
- `mint_to`
- `burn`
- `close_account`
- `freeze_account`
- `thaw_account`

İki ana state hesabı vardır:

- `TokenMintAccount`: decimals, supply, creator, mint authority, opsiyonel freeze
  authority ve en fazla 8 karakterlik ticker.
- `TokenAccount`: mint, owner, amount ve frozen durumu.

İstenen Token Studio akışlarının sonucu:

| İşlem | Doğrulama |
|---|---|
| Mint oluşturma | `initialize_mint` ile destekleniyor |
| Token account oluşturma | `initialize_account` ile destekleniyor |
| İlk arz | Mint oluşturmanın alanı değil; token account açıldıktan sonra ayrı `mint_to` gerekir |
| Sonradan mint | `mint_to` ile destekleniyor |
| Transfer | `transfer` ile destekleniyor |
| Burn | `burn` ile destekleniyor |
| Freeze / thaw | İkisi de destekleniyor; mintte freeze authority tanımlı olmalı |
| Authority | Mint ve opsiyonel freeze authority oluşturma sırasında ayarlanıyor |
| Authority değiştirme | Verilen Token Program ve CLI belgelerinde `set_authority` benzeri instruction yok |

“İlk arz” tek atomik işlem gibi sunulmamalıdır. Dokümante edilen modelde en az
`initialize_mint` + `initialize_account` + `mint_to` adımları gerekir. Multicall ile
atomiklik mümkün olabilir, fakat Token dokümanı bu özel akışın multicall uyumunu
garanti etmiyor; ayrıca `@thru/programs` yerelde yoktur.

### 4.2 Paketler ve import yolları

Dokümante edilen öneri:

```ts
import { createThruClient } from "@thru/sdk";
import {
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  createTransferInstruction,
  deriveMintAddress,
  deriveTokenAccountAddress,
  deriveWalletSeed,
  parseMintAccountData,
  parseTokenAccountData,
  formatRawAmount,
} from "@thru/programs/token";
```

Ancak ikinci import mevcut projede bugün çalışmaz; `@thru/programs` kurulu değildir.
Dokümandaki “important exports” listesinde burn, close, freeze ve thaw builder’ları
da gösterilmemektedir. Bunların gerçek export adları bir paket sürümü kurularak
tiplerden doğrulanmadan kod yazılmamalıdır.

### 4.3 Program adresi

Resmî Token Program sayfasında on-chain program adresi şu şekilde verilir:

```text
taAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKqq
```

Bu değer uygulama içinde kullanıcı girdisinden alınmamalıdır. Chain kimliğine göre
salt-okunur güvenilir ağ konfigürasyonunda tutulmalı ve transaction öncesi beklenen
program adresiyle eşleşmesi doğrulanmalıdır. `@thru/programs/token` örnekleri
derivation helper’larına program adresinin dışarıdan verildiğini gösterir; yerelde
paket olmadığı için güvenli bir sabit export ettiği varsayılamaz.

### 4.4 Hesaplar, signer ve fee payer

| Akış | Temel hesaplar/otorite | Signer ve fee payer sonucu |
|---|---|---|
| Initialize mint | Yeni mint PDA, creator, mint authority, opsiyonel freeze authority | CLI’de creator fiilen fee payer ile aynı olmalı |
| Initialize token account | Yeni token account PDA, mint, owner | Fee payer transaction’ı imzalar |
| Mint to | Mint, hedef token account, mint authority | Mint authority yetkisi gerekir; ayrı fee payer ile çoklu imza davranışı belgede açık değil |
| Transfer | Kaynak ve hedef token account | CLI açıkça fee payer’ın kaynak owner olmasını ister |
| Burn | Token account, mint, owner authority | Owner yetkisi gerekir; ayrı fee payer imzası belirsiz |
| Freeze/thaw | Token account, mint, freeze authority | Freeze authority gerekir; ayrı fee payer imzası belirsiz |
| Close | Sıfır bakiyeli token account ve owner | Owner yetkisi gerekir |

İlk güvenli web sürümünde, protokolün ayrı authority imzasını nasıl taşıdığı
doğrulanana kadar yetki gerektiren akışlarda fee payer ile authority aynı hesapla
sınırlandırılmalıdır. UI farklı bir authority adresi girilmesine izin verip onu
imzalamadan kullanmamalıdır.

### 4.5 Builder veya elle encoding

- Initialize mint/account, mint-to ve transfer için dokümante edilmiş
  `@thru/programs/token` builder’ları var.
- Yerel paket eksik olduğundan bugün bu builder’lar kullanılamaz.
- Burn, close, freeze ve thaw builder adları verilen paket dokümanında açıkça
  listelenmemiştir.
- Elle byte encoding, ancak resmî ABI/spec ile oluşturulan ve golden test
  vektörleriyle doğrulanmışsa kabul edilebilir. Alanları tahmin ederek encoding
  yapılmamalıdır.

### 4.6 State proof ve address derivation

Dokümante edilen türetmeler:

- Mint seed’i: creator + kullanıcı seed’inin hash’i, Token Program altında PDA.
- Token account seed’i: owner + mint + kullanıcı seed’inin hash’i, Token Program
  altında PDA.

Yeni mint ve yeni token account için `CREATING` state proof gerekir. CLI proof
verilmezse otomatik üretir. Web uygulaması da transaction build’e çok erken
hazırlanmış/stale proof taşımamalı; gönderime yakın üretmeli ve proof’un türetilen
hedef adresle eşleşmesini kontrol etmelidir.

### 4.7 Başarı ve finalization

Final consensus ve sıfır execution error sonrasında:

- Mint creation: mint hesabı parse edilerek creator, ticker, decimals, authority
  alanları doğrulanır.
- Initial supply/mint-to: mint supply ve hedef token amount yeniden okunur.
- Transfer: kaynak ve hedef bakiyeler yeniden okunur.
- Burn: supply ile token balance birlikte doğrulanır.
- Freeze/thaw: `is_frozen` yeniden okunur.
- Close: hesabın artık bulunmaması doğrulanır.

Token event’leri faydalı ek kanıttır, fakat account refetch’in yerine geçmemelidir.

### 4.8 AlphaNet test gereksinimleri

- AlphaNet RPC’ye bağlanan doğrulanmış client/chain ID.
- Zincirde var olan ve gerekli işlem kaynaklarına sahip fee payer.
- Doğrulanmış Token Program adresi.
- Her create testi için çakışmayan seed ve güncel state proof.
- Mint/burn/freeze testleri için doğru authority anahtarı.
- Transfer için aynı mint’e ait iki token account.
- En küçük birim/bigint kullanan miktar testleri.
- Finalization sonrası tekrar okuma.

CLI dokümanı bazı ücret alanlarını şu an sıfır gösterebilir; ürün bunu kalıcı ücretsiz
işlem garantisi gibi sunmamalıdır.

### 4.9 Eksik veya belirsiz belgeler

- Doküman ↔ npm sürüm eşlemesi yok.
- `@thru/programs` tam export listesi ve burn/freeze/thaw builder adları verilen
  sayfada yok.
- Mint/freeze authority değiştirme veya iptal etme instruction’ı belgelenmiyor.
- Authority ile fee payer farklı olduğunda imza modeli net değil.
- Amount taşması, supply üst sınırı ve kesin program hata kodları tablolanmıyor.
- Multicall ile atomik initial-supply akışının destek durumu belirtilmiyor.

### 4.10 Güvenlik riskleri

- Yanlış/spoof program adresine transaction imzalatma.
- Ondalık gösterim ile smallest-unit dönüşümünde yuvarlama veya JavaScript
  `number` taşması; `bigint` kullanılmalı.
- Yanlış mint’e ait hedef hesaba işlem denemesi.
- Authority anahtarının kaybı veya yetkisiz kullanım.
- Freeze authority varlığını kullanıcıya göstermeden dondurulabilir token üretme.
- Tekrarlanan submit sonrası çift mint/transfer; signature ve on-chain state ile
  idempotency kontrol edilmeli.
- Finalization öncesi başarı gösterme.
- Private key/mnemonic’i instruction verisi, telemetry veya loga sızdırma.

## 5. Name Studio

Name Studio iki ayrı program alanını birbirine karıştırmamalıdır:

- **Registrar:** `.thru` domain için ücretli lease satın alma, yenileme ve expired
  lease claim etme.
- **Name Service:** registrar/root/subdomain state’i, domain kayıtları ve resolve.

### 5.1 Ayrıştırılmış işlemler

| Akış | Program/komut ailesi | Sonuç |
|---|---|---|
| `.thru` domain satın alma | Registrar `purchase-domain` | 1–255 yıllık yeni lease ve domain |
| Lease süresi | Purchase/renew argümanı | `u8`, 1–255 yıl; yılın saniye tanımı belgede yok |
| Yenileme | Registrar `renew-lease` | Mevcut lease’e 1–255 yıl ekler |
| Süresi dolmuş domaini claim | Registrar `claim-expired-domain` | Expired lease için yeni 1–255 yıllık dönem |
| Subdomain | Name Service `register-subdomain` / `unregister-subdomain` | Parent registrar/domain altında domain hesabı |
| Record ekleme | Name Service `append-record` | Key en fazla 32 byte, value en fazla 256 byte |
| Record silme | Name Service `delete-record` | Owner yetkisiyle record kaldırır |
| Resolve | Name Service `resolve` | Domain state/record çözümleme |
| Record listeleme | Name Service `list-records` | Domain record’larını okur |

Registrar kurulumu için ayrıca `initialize-registry` vardır. Root varsayılan olarak
`thru` olabilir; registrar config’inde token mint, treasurer token account ve yıllık
fiyatın base-unit değeri bulunur.

Satın alma native coin ödemesi olarak varsayılmamalıdır. Dokümante edilen registry,
belirli bir token mint ve aynı mint’e ait treasurer/payer token account’larıyla
çalışır.

### 5.2 Paketler ve import yolları

İstemci ve transaction için `@thru/sdk` kullanılabilir. Ancak verilen
`@thru/programs` sayfasında Name Service veya Registrar için public import subpath’i
belgelenmiyor. Dolayısıyla aşağıdakilerden biri doğrulanmadan uygulama yapılmamalıdır:

1. Resmî on-chain ABI’den üretilmiş, repoya sabitlenmiş TypeScript builder’ları.
2. Resmî bir Name/Registrar web paketi ve onun gerçek `.d.ts` yüzeyi.

CLI komut dokümanı, browser instruction encoder API’si değildir. CLI argümanlarını
doğrudan instruction alan sırası kabul ederek elle encoding yapmak güvenli değildir.

### 5.3 Program adresleri

Verilen Name/Registrar sayfaları sabit bir on-chain adres yayımlamak yerine CLI
config ve şu override bayraklarını tarif ediyor:

- `--name-service-program`
- `--thru-registrar-program`
- `--token-program`

Global config varsayılan olarak kullanıcının Thru CLI konfigürasyonunda tutulur.
Web uygulaması yerel CLI dosyasına güvenemez; aynı değerler resmi olarak doğrulanmış
chain-specific uygulama konfigürasyonuna aktarılmalıdır. Name Service ve Registrar
program adresleri verilen kaynaklarda sabit olarak doğrulanamadığı için şu anda
uygulama engelidir. UI’dan serbest program adresi alınmamalıdır.

### 5.4 Hesaplar, signer ve fee payer

| Akış | Gerekli state/hesaplar | Yetki |
|---|---|---|
| Initialize registry | Yeni config/root, registrar, token mint, treasurer token account | Registry authority/fee payer; treasurer doğru mint/token program ve aktif olmalı |
| Purchase | Config, payer token account, yeni lease ve domain | Payer token account fee payer’a ait olmalı |
| Renew | Config, mevcut lease, payer token account | Payer fee payer’a ait olmalı |
| Claim expired | Config, expired lease/domain, payer token account | Payer fee payer’a ait olmalı |
| Init root | Yeni root, türetilmiş registrar, authority | Doküman authority’nin fee payer ile eşleşmesini ister |
| Register subdomain | Parent registrar/domain, yeni domain, owner/authority | Doküman yalnız fee payer imzası nedeniyle owner/authority eşleşmesi ister |
| Append/delete record | Domain ve record verisi | Owner fee payer ile eşleşmeli |
| Resolve/list | Domain | Salt-okunur; signer gerekmemeli |

CLI belgelerindeki “yalnız fee payer imzası” sınırı, keyfi ayrı owner/authority
destekleyen bir web formunun bugün güvenli olmadığını gösterir.

### 5.5 Builder veya elle encoding

Verilen Web SDK paket belgelerinde hazır Name/Registrar builder’ı yoktur.
CLI mevcut olsa da TypeScript instruction şeması verilmemiştir. Önerilen uygulama
kapısı:

- doğru AlphaNet program ve ABI adreslerini doğrula,
- ABI’yi zincirden al,
- codegen çıktısını sabitle,
- instruction/account listelerini ABI reflection ve test vektörleriyle karşılaştır.

Bu veriler olmadan elle encoding yapılmamalıdır.

### 5.6 State proof ve derivation

Dokümante edilen create akışları:

- Registry initialization: config ve root için create proof.
- Domain purchase: lease ve domain için create proof.
- Subdomain registration: yeni domain için create proof.
- Root initialization: yeni root/domain state’i için create proof.

CLI ayrıca domain, registrar, config ve lease adreslerini türeten read-only komutlar
sunuyor. Bunlar PDA/account derivation’ın gerekli olduğunu gösterir; fakat verilen
sayfalarda web için tam byte-level seed reçeteleri yoktur. CLI çıktısı veya ABI
builder davranışı golden vector olarak alınmadan yeniden uygulanmamalıdır.

Renew, record güncelleme ve resolve mevcut hesaplar üzerinde çalışır; yeni hesap
oluşturmadıkları ölçüde create proof gerektirmemeleri beklenir. Bu son cümle bir
çıkarımdır; kesin hesap/proof listesi ABI ile doğrulanmalıdır.

### 5.7 Başarı ve finalization

Transaction finalization ve execution sonucu doğrulandıktan sonra:

- Purchase: domain resolve edilmeli, lease owner ve expiry okunmalı, token ödemesi
  payer/treasurer bakiyelerinde doğrulanmalı.
- Renew: önceki ve yeni expiry karşılaştırılmalı.
- Expired claim: yeni owner ve yeni expiry doğrulanmalı.
- Subdomain: parent ilişkisi ve owner resolve ile doğrulanmalı.
- Append/delete record: resolve/list-records sonucu tekrar okunmalı.
- Unregister: domainin artık çözümlenmemesi veya beklenen tombstone state’i
  doğrulanmalı.

Sadece CLI/SDK’nin transaction signature döndürmesi domainin kullanılabilir olduğu
anlamına gelmez.

### 5.8 AlphaNet test gereksinimleri

- Resmî AlphaNet Name Service ve Registrar program adresleri.
- Programların on-chain ABI adresleri veya doğrulanmış builder paketi.
- Geçerli registry config, `.thru` root, fiyat, ödeme token mint’i ve treasurer.
- Registry’nin ödeme mint’ine ait, fee payer sahipliğinde ve bakiyeli token account.
- Yeni domain/lease/subdomain adresleri için güncel state proof.
- Expired claim testi için gerçekten süresi dolmuş kontrollü fixture veya
  AlphaNet test kolaylığı.
- Zaman/expiry kontrolleri için zincir zamanı esas alınmalı.
- Resolve ve token-balance refetch.

### 5.9 Eksik veya belirsiz belgeler

- AlphaNet Name Service/Registrar program adresleri.
- Web SDK builder/import yolları.
- Tam instruction account sırası ve encoding.
- PDA seed’lerinin byte-level tanımı.
- Bir “yıl”ın zincirdeki kesin süre karşılığı.
- Grace period, redemption period veya expired claim yarış kuralları.
- Domain normalizasyonu: case, Unicode, punycode ve benzer görünüşlü karakterler.
- Fiyat/config için önerilen web read API’si.
- Claim sonrası eski records/subdomain’lerin durumu.
- Aynı domain için eşzamanlı purchase/claim yarışının kullanıcıya nasıl
  açıklanacağı.

### 5.10 Güvenlik riskleri

- Homograph/Unicode ile yanıltıcı domain.
- Zincir state’i okunmadan sabit/eski fiyat göstermek.
- Yanlış ödeme mint’i veya treasurer hesabına token göndermek.
- Kullanıcı girdisinden program/config/treasurer adresi almak.
- Expiry için tarayıcı saatine güvenmek.
- Claim ve purchase yarışında finalization öncesi sahiplik göstermek.
- Record value’yu HTML/URL olarak güvenmeden render etmek; XSS ve phishing.
- Record key/value sınırlarını karakter değil UTF-8 byte uzunluğuyla kontrol
  etmemek.
- Ayrı owner/authority için imzasız bir transaction hazırlamak.

## 6. NFT Studio

### 6.1 Desteklenen işlemler

Resmî NFT Program sayfası şu instruction’ları tanımlar:

- `initialize_mint`
- `mint_to`
- `transfer`
- `burn`
- `update_metadata`
- `set_authority`

State:

- `NftMintAccount`: mint authority, supply, next ID.
- `NftAccount`: mint, owner, ID ve metadata.
- `NftMetadata`: flags ve `external_metadata_uri`.

NFT Program bugün standart event envelope yayımlamıyor. Bu nedenle transaction
sonrası hesap state’i temel doğrulama kaynağıdır.

### 6.2 Paketler ve import yolları

Temel client/transaction ve ABI runtime araçları:

```ts
import { createThruClient } from "@thru/sdk";
import {
  configureWasm,
  reflect,
  buildLayoutIr,
  OnchainFetcher,
} from "@thru/sdk/abi";
```

NFT instruction’ları için `@thru/programs/nft` benzeri bir public subpath verilen
kaynaklarda yoktur. NFT quickstart, on-chain ABI’nin alınmasını, TypeScript codegen
çalıştırılmasını ve üretilmiş tip/builder dosyalarının projeden import edilmesini
gösterir. Kurulu `@thru/sdk/abi` reflection ve layout yetenekleri içerir; npm runtime
export’u olarak TypeScript codegen komutu doğrulanmadı. Codegen build-time/CLI
adımı olarak ele alınmalıdır.

### 6.3 Program adresi

Verilen NFT Program ve ABI sayfaları production/AlphaNet NFT Program adresini veya
on-chain ABI account adresini yayımlamıyor. Quickstart’taki adresler uygulamaya
kopyalanabilecek doğrulanmış sabit olarak değerlendirilmemelidir.

NFT Studio için program ve ABI adresi resmî chain konfigürasyonundan edinilmeden
transaction özelliği açılmamalıdır. ABI account’un sahibi/program ilişkisi ve ABI
hash’i de doğrulanıp sürümle sabitlenmelidir.

### 6.4 Hesaplar, signer ve fee payer

Dokümante edilen yüksek seviyeli roller:

| Akış | State/otorite |
|---|---|
| Initialize mint | Yeni NFT mint account, başlangıç mint authority, fee payer |
| Mint to | Mint, yeni NFT account/ID, hedef owner, mint authority |
| Transfer | NFT account, mevcut owner authority, yeni owner |
| Burn | NFT account/mint ve owner authority |
| Update metadata | NFT account ve gerekli authority |
| Set authority | Mint ve mevcut mint authority, yeni authority |

Ancak kesin read-write/read-only hesap sırası, ayrı authority imza modeli ve
`mint_to` sırasında yeni NFT account adresinin proof hesapları verilen program
sayfasında tam listelenmiyor. Quickstart örneği fee payer imzasını gösterir; ayrı
authority imzası açıkça tanımlanana kadar authority=fee payer kısıtı güvenli
başlangıçtır.

### 6.5 Builder veya elle encoding

Hazır bir NFT web-package builder’ı belgelenmiyor. Resmî öneri flattened ABI ve
codegen tabanlı builder üretimidir.

ABI için önemli kurallar:

- Layout little-endian ve deterministiktir.
- Packed ve aligned layout ayrımı vardır; padding tahmin edilmemelidir.
- Dynamic array/string boyut alanları veri alanından önce gelmelidir.
- El yazımı ABI zincir programıyla otomatik senkron kalmaz.
- ABI `analyze`, reflection ve codegen ile doğrulanmalıdır.

Elle encoder yazmak yerine doğrulanmış codegen çıktısı repoya sabitlenmeli, ABI
byte’ları/hash’i kaydedilmeli ve golden transaction testleri tutulmalıdır.

### 6.6 State proof ve derivation

`initialize_mint` yeni mint hesabı oluşturduğu için create state proof gerektirir.
`mint_to` yeni bir NFT account/ID oluşturur; ancak verilen sayfa bu hesabın tam PDA
türetmesini ve ayrı create proof gereksinimini açıkça vermiyor. Bu, implementasyon
öncesinde ABI ve AlphaNet ile çözülmesi gereken bir engeldir.

Transfer, metadata update, burn ve authority değişimi mevcut state üzerinde çalışır.
Bunların gereken proof türleri kesin ABI/account meta çıktısından doğrulanmalıdır.

### 6.7 Başarı ve finalization

Final consensus ve sıfır execution error sonrasında:

- Initialize: mint authority, supply ve next ID okunur.
- Mint-to: supply/next ID artışı ve yeni NFT account’un mint, owner, ID, metadata
  alanları okunur.
- Transfer: owner alanı yeniden okunur.
- Burn: NFT state’i ile mint supply yeniden okunur.
- Metadata update: URI ve flags byte-for-byte doğrulanır.
- Set authority: yeni authority yeniden okunur.

Program standart event envelope yayımlamadığından event beklemek doğru başarı
mekanizması değildir.

### 6.8 AlphaNet test gereksinimleri

- Resmî NFT Program ve ABI account adresi.
- ABI’nin program sürümüyle eşleştiğini gösteren hash/version kontrolü.
- Build-time codegen ve derlenen builder’lar.
- Zincirde mevcut/fonlanmış fee payer ve authority.
- Yeni mint ve muhtemel NFT account için state proof.
- Erişilebilir test metadata URI’si.
- Mint, transfer, update, authority ve burn sonrası account refetch.
- Harici metadata içeriğinin hata, timeout ve kaybolma senaryoları.

### 6.9 Görsel ve external metadata

Dokümante edilen on-chain NFT metadata alanında yalnızca:

- flags,
- sabit alan ayrılmış `external_metadata_uri`

bulunur. Görsel byte’ları veya medya blob’u NFT account modelinde yer almıyor.
Dolayısıyla bir NFT görseli kullanılacaksa görsel ve çoğu zengin metadata zincir
dışında tutulur; zincirde yalnız URI saklanır.

Flattened ABI `external_metadata_uri` için **256 byte** ayırır. Bu değer 256 Unicode
karakter olarak yorumlanmamalıdır; UTF-8 encode edilmiş URI’nin byte uzunluğu
kontrol edilmelidir. Doküman null terminator/trailing-zero kuralını ve tam 256
byte’ın mı yoksa güvenli olarak 255 byte payload’ın mı kullanılabileceğini açıkça
belirtmiyor. Generated ABI serializer ve AlphaNet round-trip testi kesin sınırı
belirlemelidir.

IPFS zorunlu değildir; verilen kaynaklar belirli bir URI şeması veya depolama
sağlayıcısı şart koşmuyor. Bu nedenle IPFS, Arweave, HTTPS object storage veya başka
bir kalıcı içerik adresleme çözümü ürün kararıdır. “NFT zincirde saklandı” ifadesi
yanıltıcı olur; yalnız program state’i ve external URI zincirdedir.

### 6.10 Eksik/belirsiz belgeler ve güvenlik riskleri

Eksikler:

- AlphaNet NFT Program ve ABI account adresi.
- Tam signer/account meta listeleri.
- NFT account PDA/seed reçetesi.
- `mint_to` create proof gereksinimi.
- URI’nin encoding/padding ve kesin kullanılabilir byte sınırı.
- Metadata JSON şeması, MIME tipleri ve desteklenen URI protokolleri.
- Burn sonrası account lifecycle/tombstone ayrıntısı.
- Program hata kodları ve authority=fee payer kısıtının kesinliği.

Riskler:

- Sahte program veya sahte on-chain ABI kullanmak.
- ABI değiştiği halde eski generated builder ile transaction oluşturmak.
- URI içeriğini güvenilir HTML/görsel kabul etmek: XSS, SVG script, kötü MIME,
  tracking ve phishing riski.
- Uygulama backend’inin keyfi URI fetch etmesi halinde SSRF.
- Merkezi URL’nin kaybolması veya içeriğinin sonradan değiştirilmesi.
- 256 byte sınırını karakter sayısıyla ölçmek.
- Authority transferinin geri döndürülemez sonuçlarını açıkça göstermemek.
- Burn işleminde yeterli onay/özet vermemek.
- Finalization öncesi mint edilmiş NFT göstermek.

## 7. Uygulama öncesi karar kapıları

Kodlama onayı verilse bile aşağıdaki sırayla ilerlemek gerekir:

1. `@thru/sdk@0.2.39` korunacak mı, yükseltilecek mi karar ver ve exact sürümü
   sabitle.
2. `@thru/programs` için hedef sürümü belirle; paketi kurmadan önce bu SDK sürümüyle
   peer/dependency ve tip uyumluluğunu doğrula.
3. Token builder export’larının tamamını, özellikle burn/close/freeze/thaw’ı gerçek
   kaynak ve `.d.ts` üzerinden doğrula.
4. AlphaNet Name Service, Registrar, NFT Program ve NFT ABI account adreslerini
   resmî chain konfigürasyonundan edin.
5. Name ve NFT ABI’lerini indir, hash’le, analyze/codegen çalıştır ve generated
   çıktıların program sürümüyle bağını kaydet.
6. Ayrı authority ve fee payer imza modelini her program için küçük AlphaNet
   transaction’larıyla doğrula; kanıtlanana kadar eşitlik kısıtı uygula.
7. Derivation ve state proof’lar için CLI ↔ web golden vectors oluştur.
8. Her mutation için finalization + execution result + account refetch standardını
   ortak bir transaction durum modeliyle uygula.
9. Metadata/domain/token girdilerine byte-level doğrulama ve güvenlik sınırları
   koy.
10. Önce AlphaNet üzerinde düşük riskli fixture’larla uçtan uca doğrula; sonuçları
    dokümante etmeden özellikleri “çalışıyor” olarak etiketleme.

## 8. Sonuç

- **Token Studio:** Protokol işlemleri büyük ölçüde belgeli ve Token Program adresi
  mevcut. Ancak projede `@thru/programs` olmadığı, tam builder yüzeyi ve authority
  imza modeli doğrulanmadığı için hemen kodlamaya hazır değildir.
- **Name Studio:** Kullanıcı akışları CLI seviyesinde ayrıntılıdır; browser
  instruction builder’ları, program adresleri ve kesin encoding/derivation eksiktir.
  Bunlar çözülmeden transaction üretmek güvenli değildir.
- **NFT Studio:** State ve instruction ailesi açıktır; önerilen yol ABI codegen’dir.
  Program/ABI adresi, account derivation ve proof ayrıntıları eksiktir. Görseller
  zincirde değil, external URI arkasındaki depolamadadır; IPFS zorunlu değildir.

Bu rapor uygulama kaynaklarında, navigasyonda veya arayüzde herhangi bir değişiklik
yapmaz. Bir sonraki aşama açık onay ve yukarıdaki karar kapılarının çözülmesini
gerektirir.

## 9. Kullanılan resmî kaynaklar

Genel ve Web SDK:

- [Build with an LLM](https://thru.org/docs/getting-started/build-with-an-llm.md)
- [Core Programs Overview](https://thru.org/docs/core-programs/overview.md)
- [Web SDK](https://thru.org/docs/sdks/web.md)
- [`@thru/programs`](https://thru.org/docs/sdks/web-packages/programs.md)
- [API Overview](https://thru.org/docs/api-ref/overview.md)

Token Studio:

- [Token Program](https://thru.org/docs/core-programs/token-program.md)
- [Token Commands](https://thru.org/docs/cli-reference/token-commands.md)
- [`@thru/programs`](https://thru.org/docs/sdks/web-packages/programs.md)

Name Studio:

- [Name Service Commands](https://thru.org/docs/cli-reference/name-service-commands.md)
- [Registrar Commands](https://thru.org/docs/cli-reference/registrar-commands.md)
- [Global Flags and Configuration](https://thru.org/docs/cli-reference/global-flags-and-config.md)

NFT Studio:

- [NFT Program](https://thru.org/docs/core-programs/nft-program.md)
- [ABI Overview](https://thru.org/docs/abi/overview.md)
- [ABI Examples](https://thru.org/docs/abi/examples.md)
- [ABI Specification](https://thru.org/docs/abi/specification.md)
