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
4. Admin hesabı için `ADMIN_USERNAME`, `ADMIN_EMAIL` ve güçlü bir `ADMIN_PASSWORD` belirleyin. Bu hesap ilk açılışta oluşturulur; mevcut hesap varsa admin yetkisi tanımlanır.
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
- JSON dosyası yerine MongoDB kullanılır. Oda kuyruğu ve hesaplar MongoDB'ye yazılır.

## Uygulama notları

Oda kodu davet bağlantısında kullanılır. Oda sahibi ve DJ kuyruk ekleme, kaldırma ve oynatma kontrolü yapabilir. Üyeler kullanıcı adı ve şifreyle giriş yapar; yeni hesaplarda e-posta adresi de saklanır.
