# Uyumluluk Matrisi

**Doğrulama tarihi:** 23 Temmuz 2026
**Makine:** macOS arm64 geliştirme ortamı
**Kanal:** development

## 1. Doğrulanan ortam

| Bileşen | Sürüm/durum | Sonuç |
|---|---|---|
| Python | `3.12.11` | Geçti |
| Node.js | `24.6.0` | Frontend build geçti |
| npm | `11.5.1` | Install/build geçti |
| uv | `0.8.14` | Sync/build geçti |
| FFmpeg | `7.1.1` | Bulundu |
| LeRobot | `0.6.0` | Import ve console scripts geçti |
| Torch | `2.11.0` | Import geçti |
| Strands Agents | `1.48.0` | Import/API contract geçti |
| MuJoCo | `3.10.0` | Gerçek simulation test geçti |
| Strands Robots | Kurulmadı | Bilinen LeRobot conflict nedeniyle |

Bu matris geliştirme makinesi doğrulamasıdır; bütün müşteri işletim sistemleri
için destek garantisi değildir.

## 2. Doğrulanan LeRobot console scripts

Proje environment'ında mevcut olduğu doğrulanan komutlar:

```text
lerobot-find-port
lerobot-find-cameras
lerobot-setup-motors
lerobot-calibrate
lerobot-teleoperate
lerobot-record
lerobot-replay
lerobot-train
lerobot-rollout
```

Hashtag adapter yalnız argüman listesi kullanır; shell string üretmez.

## 3. Strands Robots kararı

Yayımlanmış `strands-robots==0.4.1`, LeRobot için `<0.6.0` aralığı tanımlar.
Platformun doğruladığı LeRobot ise `0.6.0`'dır.

Bu nedenle:

- Stable environment'a `strands-robots==0.4.1` eklenmedi.
- Doküman/main özelliği installed capability kabul edilmedi.
- Agent runtime için bağımsız `strands-agents==1.48.0` kullanıldı.
- Strands Robots daha sonra uyumlu release veya açık commit pin'i ile ayrı
  preview channel'da test edilecek.

## 4. Package extras

```text
hashtag-robotics
├── core
├── [agents]  Strands Agents
├── [sim]     MuJoCo
├── [so101]   LeRobot 0.6
└── [dev]     test/lint araçları
```

Geliştirme doğrulaması:

```bash
uv sync --extra dev --extra agents --extra sim --extra so101
```

Core wheel, ağır training/sim paketlerini zorunlu olarak kurmaz.

## 5. Release compatibility kuralı

Her upgrade'te:

1. Yeni lock resolve edilir.
2. `hashtag-robotics doctor` çalıştırılır.
3. LeRobot console script listesi doğrulanır.
4. Typed command builder testleri geçer.
5. MuJoCo contract test edilir.
6. Frontend build edilir.
7. Wheel temiz Python 3.12 environment'ına kurulur.
8. HIL gereken değişiklik release blocker olarak işaretlenir.

## 6. Destek iddiası olmayan yüzeyler

Bu sürüm henüz şu ortamları doğrulamadı:

- Windows + Feetech
- Ubuntu + CUDA
- Intel macOS
- RealSense
- ROS 2
- Isaac/Newton
- Uzak GPU gerçek inference
- Strands Robots preview

Doctor'da görünmesi destek garantisi değildir; test matrisi sonucu ayrıca
gereklidir.
