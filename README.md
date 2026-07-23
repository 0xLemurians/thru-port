# thru-web — AlphaNet onboarding ve C editörü

Tarayıcı içinde Thru AlphaNet hesabı oluşturma/içe aktarma, hesabı on-chain
faucet ile fonlama ve başlangıç C şablonlarını Monaco editöründe düzenleme
prototipi.

> Build backend ve program deploy bu aşamada bağlı değildir. Arayüz bunları
> çalışan özellikler olarak sunmaz.

## Mevcut akış

1. **Account**
   - 12 kelimelik BIP-39 recovery phrase ile yeni hesap üretme
   - Recovery phrase veya 32-byte hex private key ile import
   - Public address ve bakiye görüntüleme
   - Açık risk onayından sonra plaintext yerel backup indirme
2. **Fund**
   - Zincirde henüz bulunmayan hesabı state-proof tabanlı create transaction
     ile oluşturma
   - Hesap görünürlüğünü doğrulama
   - Faucet transaction'ını tarayıcıda imzalama
   - Retry öncesi ve başarı sonrasında bakiye artışını doğrulama
   - Uzun isteği iptal edebilme
3. **Code**
   - Counter, Message Storage, Game Score ve Blank C şablonları
   - Yerel npm paketinden yüklenen Monaco Editor
   - Template metadata, reset ve kaydedilmemiş değişiklik uyarısı

## Güvenlik modeli

- Private key ve mnemonic uygulama backend'ine veya RPC'ye gönderilmez.
- Key üretimi, mnemonic türetme ve transaction imzalama tarayıcıda
  `@thru/sdk` ile yapılır.
- RPC yalnızca public hesap verilerini, state-proof isteklerini ve imzalı wire
  transaction'ları görür.
- Monaco üçüncü taraf CDN'den değil, kurulu yerel `monaco-editor` paketinden
  yüklenir.
- Secret import alanında autocomplete, autocapitalize ve spellcheck kapalıdır.
- Private key importu tam olarak 32 byte / 64 hex karakter olarak doğrulanır.
- "Forget account" işlemi mutable private-key byte dizisini sıfırlar.
- İndirilen backup **şifresiz plaintext JSON** dosyasıdır. Bu dosyayı ele
  geçiren kişi hesabı kontrol edebilir.

JavaScript stringleri güvenilir biçimde sıfırlanamadığından mnemonic için
mutlak bellek silme garantisi verilmez. Tarayıcı eklentileri ve cihaz güvenliği
de tehdit modelinin parçasıdır.

## Faucet tasarımı

`@thru/sdk` hazır bir faucet builder sunmadığı için 16-byte withdraw instruction
Thru faucet formatına göre oluşturulur:

- `u32 LE`: withdraw discriminant (`1`)
- `u16 LE`: faucet account index
- `u16 LE`: recipient account index
- `u64 LE`: amount

Account indeksleri sabit sayılarla yazılmaz; SDK'nın transaction context'i
üzerinden hesaplanır. Yeni hesap create transaction'ı `sendAndTrack` ile
gönderilir ve hesap RPC'de görünür olana kadar doğrulanır. Faucet başarı durumu,
yalnızca bakiyenin başlangıç değerinden arttığı gözlemlendiğinde döner.

## C şablonları

| Şablon | State | Instruction |
| --- | ---: | --- |
| Counter | 8 byte | Yok |
| Message Storage | En az 8 byte | Raw mesaj byte'ları |
| Game Score | 8 byte | 8-byte little-endian unsigned puan |
| Blank | 0 byte | Yok |

Şablonlar daha önce Thru C SDK/RISC-V toolchain ile manuel olarak derlenmiştir.
Bu repo henüz gerçek toolchain'i çalıştıran otomatik bir build testi içermez;
bu nedenle derleme veya on-chain davranış garantisi verilmez. Docker build
altyapısı sonraki aşamadır.

## Çalıştırma

Node.js 20 veya daha yeni bir sürüm gerekir.

```bash
npm install
npm run dev
```

Uygulama varsayılan olarak `http://localhost:3000` adresinde açılır.

## Kontroller

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Hepsini sırayla çalıştırmak için:

```bash
npm run check
```

## Henüz kapsamda olmayanlar

- Docker/RISC-V build backend
- Build log ve artifact indirme
- Program deploy
- Invoke/test transaction'ları
- Şifreli backup formatı
- Gerçek AlphaNet'e karşı otomatik end-to-end test

## Ağ adresleri

- RPC: `https://rpc.alphanet.thru.org`
- Explorer: `https://scan.thru.org`

AlphaNet test ağı sıfırlanabilir. Test unit'lerinin parasal değeri yoktur.
