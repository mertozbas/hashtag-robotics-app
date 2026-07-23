# Uygulama Durumu

**Sürüm:** `0.1.0`
**Anlık görüntü:** 23 Temmuz 2026
**Durum:** Software-only baseline tamamlandı; fiziksel HIL testleri bekleniyor

## 1. Sonuç

Platform bütün roadmap fazlarının yazılım iskeletini ve güvenlik sınırını tek
çalışan uygulamada birleştirir. Bu, bütün production özelliklerinin bitmiş
olduğu anlamına gelmez.

Tamamlanan eşik:

```text
install/build
  → local dashboard
  → doctor/capability
  → persisted jobs
  → leases/approval/audit
  → safe mock robot workflows
  → dataset/training/policy
  → Strands planner boundary
  → MuJoCo contract simulation
  → LeRobot physical command adapter
  → HIL gate
```

Bekleyen eşik:

```text
gerçek leader/follower bağla
  → port/fingerprint
  → calibration backup
  → camera mapping
  → düşük limitli teleop
  → gerçek recording
  → gerçek policy rollout
```

## 2. Faz durumu

| Faz | Software-only durum | Fiziksel/harici doğrulama |
|---|---|---|
| Faz 0 | Tamamlandı | Temiz OS matrisi genişletilecek |
| Faz 1 | Mock + real LeRobot command contract hazır | Leader/follower/camera HIL bekliyor |
| Faz 2 | Dataset/training/policy/evaluation pipeline hazır | Gerçek dataset ve training benchmark bekliyor |
| Faz 3 | Deterministic gateway + optional Strands planner hazır | Model provider ve red-team oturumu bekliyor |
| Faz 4 | MuJoCo contract sim + remote TLS contract hazır | Validated digital twin ve remote GPU bekliyor |
| Faz 5 | Wheel, diagnostics, fleet-local ve update status hazır | Installer signing, cloud ve support operasyonu bekliyor |

## 3. Çalışan backend yüzeyi

### Control plane

- FastAPI application factory
- Local-only varsayılan bind
- SQLite WAL
- Startup seed ve interrupted job recovery
- Typed Pydantic domain modelleri
- REST ve WebSocket event snapshot

### İş yönetimi

- Persisted job state machine
- Worker queue
- Progress
- Safe cancel/abort
- Emergency stop
- Restart sonrası `interrupted`
- Correlation ID

### Resource yönetimi

- Exclusive ve shared-read lease
- Transactional acquisition
- Heartbeat ve TTL
- Job sonunda kesin release
- Çakışmada deterministic `resource_busy`

### Safety

- `read_only`, `sim`, `real` target ayrımı
- Physical mode environment gate
- LeRobot executable doğrulaması
- Calibration, joint limit ve E-stop preflight
- Feature mapping gate
- Parameters hash'e bağlı beş dakikalık approval
- Confirmation öncesi ve sonrası yeniden preflight

## 4. Faz 1 robot yüzeyi

### Hazır

- Read-only serial discovery
- Stable fingerprint
- Simulated SO-101 ve local compute inventory
- Robot, camera ve calibration revision sözleşmeleri
- Kamera semantic key modeli
- Teleop/record/replay/calibration mock workflow
- LeRobot CLI command preview
- Shell kullanmadan LeRobot subprocess adapter
- SIGINT → timeout → kill güvenli stop sırası
- Output redaction

### Fiziksel test bekleyen

- Feetech follower/leader kimlik eşleme
- Gerçek kalibrasyon dosya import/export
- OpenCV kamera discovery ve canlı preview
- Gerçek loop telemetry
- Torque/power durumu
- Donanım E-stop yolu

## 5. Faz 2 data/policy yüzeyi

### Hazır

- DatasetManifest
- Recording sonucunda immutable provenance
- Dataset validation job
- Training job
- PolicyManifest
- Action shape ve camera mapping
- Evaluation sonucu:
  - episodes
  - successes/failures
  - success rate
  - p50/p95 latency
- `lerobot-train` typed command builder

### Gerçek benchmark bekleyen

- Mevcut gerçek LeRobotDataset v3 import
- Video/frame integrity
- Hub push/pull
- ACT gerçek training
- MPS/CUDA kaynak ölçümü
- Gerçek policy processor extraction
- Rollout video ve manual outcome annotation

## 6. Faz 3 agent yüzeyi

### Hazır

- Beş rol:
  - Lab Assistant
  - Dataset Curator
  - Training Advisor
  - Evaluation Analyst
  - Robot Operator
- Role → allowed action allowlist
- Deterministic command conversion
- Permission denial
- Agent/job correlation
- Optional Strands `1.48.0` structured planner
- Model planı ile execution ayrımı
- Strands'e raw robot tool verilmemesi

### Harici doğrulama bekleyen

- Seçilecek model provider
- Credential/keychain
- Gerçek prompt/trace redaction
- Prompt injection dataset'i
- Human-in-the-loop UI resume
- OTLP/observability backend

## 7. Faz 4 simulation/remote yüzeyi

### Hazır

- Safe mock simulation
- Gerçek MuJoCo runtime
- Altı joint'li SO-101 contract MJCF
- 30 Hz control / 500 Hz physics test
- Joint range violation ölçümü
- Kamera contract
- Remote endpoint TLS requirement
- Remote probe'un network access yapmayan dry-run sonucu

### Açık sınır

MuJoCo modeli bir **contract modelidir**, ölçülmüş SO-101 digital twin değildir.
Link geometrisi, kütle, inertia, actuator dynamics, backlash ve Feetech davranışı
gerçek robot üzerinden tanımlanmamıştır.

## 8. Faz 5 productization yüzeyi

### Hazır

- Production React build
- Frontend asset'lerini içeren Python wheel
- `hashtag-robotics` CLI
- `doctor`
- `capabilities`
- `hil-checklist`
- Diagnostics API
- Local fleet view
- Update status contract
- Build ve verification scripts

### Bekleyen

- PyPI publish
- Package/marka adı kesin kararı
- macOS signing/notarization
- Windows installer kararı
- Automatic update ve rollback
- Hashtag SKU provisioning servisi
- Cloud user/organization/fleet

## 9. Test sonucu

Software-only test paketi:

- API ve seed
- Read-only discovery
- Simulation job
- Real teleop HIL öncesi block
- Recording → dataset
- Dataset validation
- Training → policy
- Policy evaluation
- Agent role denial
- Deterministic agent job
- Strands model configuration gate
- Remote TLS rejection
- Emergency stop
- Exclusive/shared resource lease
- Expired lease cleanup
- LeRobot command contract
- MuJoCo joint-limit contract

Son doğrulamada bütün testler geçti. Güncel sayı değişebileceği için kesin sonuç
`bash scripts/verify.sh` çıktısından alınmalıdır.

## 10. Kod haritası

```text
src/hashtag_robotics/
├── api.py               API ve runtime composition
├── models.py            Domain contract'ları
├── repository.py        SQLite, jobs, leases, approvals, audit
├── jobs.py              Job coordinator ve worker
├── safety.py            Deterministic preflight
├── workflows.py         Workflow engine
├── hardware.py          LeRobot CLI adapter
├── simulation.py        MuJoCo contract adapter
├── agents.py            Deterministic agent gateway
├── strands_runtime.py   Optional structured Strands planner
├── doctor.py            Capability ve compatibility
├── discovery.py         Read-only device discovery
├── seeding.py           Safe başlangıç profilleri
└── web/                 Derlenmiş dashboard

frontend/
├── src/App.tsx
├── src/api.ts
└── src/styles.css

tests/
├── test_api.py
├── test_hardware.py
├── test_repository.py
└── test_simulation.py
```

## 11. Doğru sonraki adım

Yeni feature eklemek değil, [HIL Test Planı](HIL_TEST_PLANI_TR.md) ile:

1. read-only port/camera discovery,
2. leader/follower identity,
3. calibration artifact,
4. emergency stop,
5. düşük limitli teleop

doğrulamasına geçmektir.
