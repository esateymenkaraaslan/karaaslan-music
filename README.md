# Karaaslan Müzik

Oda tabanlı ortak müzik dinleme uygulaması. Node.js, Express, MongoDB ve Socket.IO kullanır.

## Gereksinimler

- Node.js 18 veya üzeri
- Çalışan MongoDB sunucusu/Atlas bağlantısı
- YouTube araması için YouTube Data API v3 anahtarı

## Kurulum

1. Bağımlılıkları yükleyin: `npm install`
2. `.env.example` dosyasını `.env` olarak kopyalayın.
3. `MONGODB_URI` ve en az 32 karakterlik `JWT_SECRET` değerlerini ayarlayın.
4. İlk admin hesabı için `ADMIN_USERNAME`, `ADMIN_EMAIL` ve güçlü bir `ADMIN_PASSWORD` belirleyin. İlk açılışta mevcut kullanıcı bulunursa yalnızca admin olarak işaretlenir; sonraki açılışlar panelden yapılan hesap/şifre düzenlemelerini geri almaz.
5. YouTube araması için `YOUTUBE_API_KEY` ekleyin.
6. Başlatın: `npm start`
7. Tarayıcıda `http://localhost:3000` adresini açın.

## Container ile yayın

Proje, Docker uyumlu bir Node web servisine dağıtılabilir. Ortam değişkenlerine `.env.example` içindeki değerleri ekleyin; `/app/uploads` için kalıcı volume bağlayın. Socket.IO tek uygulama örneğinde çalışacak şekilde tasarlanmıştır; yatay ölçekleme için Socket.IO adapter ve WebRTC SFU gerekir.

## Önemli yapılandırma

- `.env` gizli bilgiler içerir ve Git'e eklenmez.
- YouTube araması resmi gömülü video oynatıcıyı kullanır; bu nedenle seçilen YouTube içeriğinin görüntüsü de görünebilir. Bu proje YouTube'dan sesi ayırıp indirmez. Yalnızca ses çalma şartı varsa, kaynak için ayrıca resmi ve ses odaklı bir playback entegrasyonu seçmek gerekir.
- Profil ve ses dosyaları `uploads/` altında tutulur. Bu klasör yedeklenmelidir; üretim ortamında kalıcı dosya depolama kullanın.
- Kamera ve mikrofon odada isteğe bağlıdır. Görüşme şu an WebRTC eşler arası bağlantı kullanır. `TURN_URL`, `TURN_USERNAME` ve `TURN_PASSWORD` ile TURN sunucusu tanımlanabilir. 20 katılımcı için üretim kalitesinde görüşme adına TURN ve SFU servisi (LiveKit/benzeri) gerekir; TURN/SFU kimlik bilgileri sağlanmadan görüşme tüm ağlarda garanti edilemez.
- İki cihazla ses/kamera denemesinde ikisinin de aynı odaya girmesi, görüşme sekmesini açması ve tarayıcı izinlerini vermesi gerekir. Oda ekranında bağlantı durumu gösterilir. Bazı mobil operatör ve kurumsal ağlar STUN ile eşler arası bağlantıyı engeller; bu ağlarda Render ortam değişkenlerine bir TURN servisinin `TURN_URL`, `TURN_USERNAME` ve `TURN_PASSWORD` değerlerini ekleyin. Bu değerleri kaynak koda veya herkese açık depoya koymayın.
- JSON dosyası yerine MongoDB kullanılır. Oda kuyruğu ve hesaplar MongoDB'ye yazılır.

## Uygulama notları

Oda oluştururken herkese açık veya özel seçilebilir. Açık odalar sahibi odadan ayrılsa da dizinde kalır; özel odalar listelenmez ve davet koduyla açılır. Oda sahibi otomatik DJ olur; verdiği DJ yetkileri kalıcı olarak saklanır. Oda sahibi ve DJ kuyruğa ekleme/kaldırma, parça değiştirme ve oynatma kontrolü yapabilir. Normal üyeler şarkı isteği gönderebilir; DJ istekleri kabul veya reddedebilir. Oda duyurusu, şarkı geçmişi, dinleme süresi, favori odalar ve kişisel çalma listeleri bulunur. Kullanıcılar profil durumu, favori türleri ve görünürlüklerini düzenleyebilir; bildirimler yeni istekleri ve DJ yetkisi değişikliklerini gösterir. Üyeler kullanıcı adı ve şifreyle giriş yapar; kayıt sırasında e-posta adresi de saklanır. Giriş sayfasında “Bu cihazda oturumu açık tut” seçeneği bulunur.

Yönetim panelinde odalar, üye hesapları ve yüklenen şarkılar yönetilebilir. Admin hesap adı/e-postası/hakkında bilgisini ve yetki düzeyini düzenleyebilir, yeni şifre atayabilir veya hesabı silebilir. Katalogdan kaldırılan yüklemeler kuyruklardan da temizlenir.
