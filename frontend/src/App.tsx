import {
  Activity,
  Bot,
  BrainCircuit,
  Camera,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  HardDrive,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Octagon,
  Play,
  Radio,
  RefreshCw,
  Router,
  ShieldCheck,
  Square,
  TerminalSquare,
  Usb,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type AgentSession,
  type AuditEvent,
  type Camera as CameraProfile,
  type Dataset,
  type Device,
  type DoctorReport,
  type HilChecklist,
  type Job,
  type Policy,
  type Robot,
  type Scenario,
  type Summary,
  type TargetMode,
} from "./api";

type View =
  | "overview"
  | "lab"
  | "operate"
  | "data"
  | "training"
  | "agents"
  | "simulation"
  | "activity"
  | "system";

const NAVIGATION: Array<{
  id: View;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { id: "overview", label: "Genel Bakış", description: "Control plane", icon: Gauge },
  { id: "lab", label: "Robot Lab", description: "Cihazlar ve kamera", icon: Usb },
  { id: "operate", label: "Operate", description: "Teleop ve kayıt", icon: Radio },
  { id: "data", label: "Dataset", description: "Veri yaşam döngüsü", icon: Database },
  { id: "training", label: "Training", description: "Policy ve evaluation", icon: Cpu },
  { id: "agents", label: "Agents", description: "Strands gateway", icon: BrainCircuit },
  { id: "simulation", label: "Simulation", description: "Sim ve remote", icon: FlaskConical },
  { id: "activity", label: "Activity", description: "Job ve audit", icon: Activity },
  { id: "system", label: "System", description: "Doctor ve HIL", icon: TerminalSquare },
];

const PAGE_COPY: Record<View, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: "LOCAL CONTROL PLANE",
    title: "SO-101 operasyon merkezi",
    description: "Donanımdan policy'ye kadar bütün yaşam döngüsünü güvenli bir yerde yönet.",
  },
  lab: {
    eyebrow: "PHASE 1 · ROBOT LAB",
    title: "Cihaz, profil ve kamera",
    description: "Önce gözlemle, kimliği çöz, sonra fiziksel kaynaklara izin ver.",
  },
  operate: {
    eyebrow: "PHASE 1 · OPERATE",
    title: "Teleop ve recording workflow'ları",
    description: "Şu anda bütün akışlar simülasyon ve güvenli mock adapter üzerinde.",
  },
  data: {
    eyebrow: "PHASE 2 · DATASET",
    title: "Dataset Studio",
    description: "Schema, episode, feature mapping ve integrity tek manifestte.",
  },
  training: {
    eyebrow: "PHASE 2 · POLICY",
    title: "Training ve evaluation",
    description: "Capability tabanlı policy işleri ve tekrar üretilebilir job kayıtları.",
  },
  agents: {
    eyebrow: "PHASE 3 · AGENT STUDIO",
    title: "Dar yetkili robot ajanları",
    description: "Ajan talepleri doğrudan robota değil deterministic command gateway'e gider.",
  },
  simulation: {
    eyebrow: "PHASE 4 · SIMULATION",
    title: "Sim-first doğrulama",
    description: "Policy ve workflow'ları gerçek donanıma geçmeden önce güvenli ortamda çalıştır.",
  },
  activity: {
    eyebrow: "CONTROL PLANE · ACTIVITY",
    title: "Job ve audit akışı",
    description: "Her command, state transition ve safety sonucu izlenebilir.",
  },
  system: {
    eyebrow: "PHASE 5 · PRODUCT READINESS",
    title: "Doctor, packaging ve HIL kapısı",
    description: "Yazılım hazır olduğunda fiziksel doğrulamanın tam sınırını gör.",
  },
};

function App() {
  const [view, setView] = useState<View>("overview");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [cameras, setCameras] = useState<CameraProfile[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [hil, setHil] = useState<HilChecklist | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const [
        summaryData,
        doctorData,
        deviceData,
        robotData,
        cameraData,
        datasetData,
        policyData,
        agentData,
        scenarioData,
        jobData,
        auditData,
        hilData,
      ] = await Promise.all([
        api.get<Summary>("/summary"),
        api.get<DoctorReport>("/system/doctor"),
        api.get<Device[]>("/devices"),
        api.get<Robot[]>("/robots"),
        api.get<CameraProfile[]>("/cameras"),
        api.get<Dataset[]>("/datasets"),
        api.get<Policy[]>("/policies"),
        api.get<AgentSession[]>("/agents/sessions"),
        api.get<Scenario[]>("/simulation/scenarios"),
        api.get<Job[]>("/jobs?limit=100"),
        api.get<AuditEvent[]>("/audit?limit=100"),
        api.get<HilChecklist>("/system/hil-checklist"),
      ]);
      setSummary(summaryData);
      setDoctor(doctorData);
      setDevices(deviceData);
      setRobots(robotData);
      setCameras(cameraData);
      setDatasets(datasetData);
      setPolicies(policyData);
      setAgents(agentData);
      setScenarios(scenarioData);
      setJobs(jobData);
      setAudit(auditData);
      setHil(hilData);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Bağlantı hatası");
    } finally {
      if (!quiet) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(true), 1800);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const runAction = useCallback(
    async <T,>(action: () => Promise<T>, successMessage: string): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        const result = await action();
        setNotice(successMessage);
        window.setTimeout(() => setNotice(null), 3200);
        await refresh(true);
        return result;
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : "İşlem başarısız");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const createJob = useCallback(
    (
      kind: string,
      targetMode: TargetMode,
      parameters: Record<string, unknown> = {},
      resources: Array<Record<string, string>> = [],
    ) =>
      runAction(
        () =>
          api.post<Job>("/jobs", {
            kind,
            target_mode: targetMode,
            parameters,
            resources,
            requested_by: "dashboard",
          }),
        `${kind} workflow'u control plane'e gönderildi.`,
      ),
    [runAction],
  );

  const discover = useCallback(
    () =>
      runAction(
        () => api.post<Device[]>("/devices/discover?include_simulated=true"),
        "Read-only cihaz keşfi tamamlandı.",
      ),
    [runAction],
  );

  const cancelJob = useCallback(
    (jobId: string) =>
      runAction(
        () => api.post<Job>(`/jobs/${jobId}/cancel`),
        "Job için güvenli durdurma istendi.",
      ),
    [runAction],
  );

  const emergencyStop = useCallback(
    () =>
      runAction(
        () => api.post<Job[]>("/safety/emergency-stop"),
        "Emergency stop bütün aktif işlere uygulandı.",
      ),
    [runAction],
  );

  const page = PAGE_COPY[view];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("overview")} aria-label="Genel bakış">
          <span className="brand-mark">#</span>
          <span className="brand-copy">
            <strong>HASHTAG</strong>
            <small>ROBOTICS</small>
          </span>
        </button>

        <div className="workspace-badge">
          <span className="workspace-dot" />
          <div>
            <small>WORKSPACE</small>
            <strong>SO-101 Lab</strong>
          </div>
          <ChevronRight size={15} />
        </div>

        <nav className="nav-list" aria-label="Ana navigasyon">
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item ${view === item.id ? "active" : ""}`}
                onClick={() => setView(item.id)}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="safety-lock">
            <LockKeyhole size={16} />
            <span>
              <small>PHYSICAL GATE</small>
              <strong>{summary?.physical_enabled ? "HIL active" : "Locked safely"}</strong>
            </span>
          </div>
          <span className="version">control plane v0.1.0</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">{page.eyebrow}</span>
            <h1>{page.title}</h1>
            <p>{page.description}</p>
          </div>
          <div className="topbar-actions">
            <StatusPill status={summary?.system_status ?? "warning"} />
            <button
              className="icon-button"
              onClick={() => void refresh()}
              disabled={busy}
              aria-label="Yenile"
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button className="estop" onClick={() => void emergencyStop()}>
              <Octagon size={17} fill="currentColor" />
              E-STOP
            </button>
          </div>
        </header>

        {!summary?.physical_enabled && (
          <div className="safety-banner">
            <ShieldCheck size={19} />
            <div>
              <strong>Software-only güvenlik modu</strong>
              <span>
                Gerçek robot actuation kapalı. Simülasyon, mock workflow ve read-only discovery
                kullanılabilir.
              </span>
            </div>
            <button onClick={() => setView("system")}>
              HIL kapısını gör <ChevronRight size={15} />
            </button>
          </div>
        )}

        {error && (
          <div className="toast error-toast">
            <CircleAlert size={18} />
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="Kapat">
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast notice-toast">
            <CircleCheck size={18} />
            <span>{notice}</span>
          </div>
        )}

        <div className="page-content">
          {view === "overview" && (
            <Overview
              summary={summary}
              doctor={doctor}
              jobs={jobs}
              onNavigate={setView}
              onDiscover={discover}
              onCreateJob={createJob}
            />
          )}
          {view === "lab" && (
            <Lab
              devices={devices}
              robots={robots}
              cameras={cameras}
              doctor={doctor}
              onDiscover={discover}
              onCreateJob={createJob}
            />
          )}
          {view === "operate" && (
            <Operate robots={robots} cameras={cameras} onCreateJob={createJob} />
          )}
          {view === "data" && (
            <DataStudio datasets={datasets} robots={robots} onCreateJob={createJob} />
          )}
          {view === "training" && (
            <TrainingStudio
              datasets={datasets}
              policies={policies}
              onCreateJob={createJob}
            />
          )}
          {view === "agents" && (
            <AgentStudio agents={agents} onAction={runAction} />
          )}
          {view === "simulation" && (
            <SimulationStudio scenarios={scenarios} onCreateJob={createJob} />
          )}
          {view === "activity" && (
            <ActivityCenter jobs={jobs} audit={audit} onCancel={cancelJob} />
          )}
          {view === "system" && (
            <SystemReadiness doctor={doctor} hil={hil} onEmergencyStop={emergencyStop} />
          )}
        </div>
      </main>
    </div>
  );
}

function Overview({
  summary,
  doctor,
  jobs,
  onNavigate,
  onDiscover,
  onCreateJob,
}: {
  summary: Summary | null;
  doctor: DoctorReport | null;
  jobs: Job[];
  onNavigate: (view: View) => void;
  onDiscover: () => Promise<unknown>;
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const blockedChecks = doctor?.checks.filter((item) => item.status === "blocked") ?? [];
  const passingChecks = doctor?.checks.filter((item) => item.status === "pass").length ?? 0;
  return (
    <>
      <section className="metric-grid">
        <MetricCard
          label="System readiness"
          value={doctor ? `${passingChecks}/${doctor.checks.length}` : "—"}
          detail={blockedChecks.length ? `${blockedChecks.length} blocked check` : "Safety checks clear"}
          icon={ShieldCheck}
          tone={blockedChecks.length ? "warning" : "good"}
        />
        <MetricCard
          label="Resolved devices"
          value={summary?.devices ?? 0}
          detail={`${summary?.robots ?? 0} robot profile`}
          icon={Usb}
        />
        <MetricCard
          label="Data assets"
          value={summary?.datasets ?? 0}
          detail={`${summary?.policies ?? 0} registered policy`}
          icon={Database}
        />
        <MetricCard
          label="Active workflows"
          value={summary?.active_jobs ?? 0}
          detail={`${summary?.blocked_jobs ?? 0} blocked by gates`}
          icon={Workflow}
          tone={summary?.blocked_jobs ? "warning" : "neutral"}
        />
      </section>

      <section className="overview-grid">
        <Panel className="mission-panel">
          <div className="panel-kicker">SAFE START</div>
          <h2>Robotu bağlamadan önce bütün control plane'i doğrula.</h2>
          <p>
            Bu çalışma alanı gerçek SO-101'i hareket ettirmeden discovery, job orchestration,
            dataset, training, agent ve simülasyon akışlarını test eder.
          </p>
          <div className="mission-actions">
            <button className="primary-button" onClick={() => void onDiscover()}>
              <Usb size={17} />
              Read-only discovery
            </button>
            <button
              className="secondary-button"
              onClick={() =>
                void onCreateJob("simulation", "sim", {
                  scenario_id: "scenario_tabletop",
                })
              }
            >
              <Play size={17} />
              Safety simulation
            </button>
          </div>
          <div className="flow-strip">
            {["Discover", "Validate", "Lease", "Approve", "Execute", "Audit"].map(
              (step, index) => (
                <div key={step} className="flow-step">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{step}</strong>
                </div>
              ),
            )}
          </div>
        </Panel>

        <Panel className="readiness-panel">
          <PanelHeader
            title="Runtime capability"
            subtitle="Kurulu gerçek yüzey"
            action={<button onClick={() => onNavigate("system")}>Tümünü gör</button>}
          />
          <div className="capability-list">
            <CapabilityRow
              label="Python"
              value={doctor?.capabilities.python_version ?? "—"}
              status="pass"
            />
            <CapabilityRow
              label="Accelerator"
              value={doctor?.capabilities.accelerator ?? "—"}
              status="pass"
            />
            <CapabilityRow
              label="LeRobot"
              value={doctor?.capabilities.packages.lerobot ?? "not installed"}
              status={doctor?.capabilities.packages.lerobot ? "pass" : "not_applicable"}
            />
            <CapabilityRow
              label="Strands Agents"
              value={doctor?.capabilities.packages["strands-agents"] ?? "not installed"}
              status={
                doctor?.capabilities.packages["strands-agents"] ? "pass" : "not_applicable"
              }
            />
            <CapabilityRow
              label="Physical adapter"
              value={summary?.physical_enabled ? "enabled" : "locked"}
              status={summary?.physical_enabled ? "warning" : "pass"}
            />
          </div>
        </Panel>
      </section>

      <Panel>
        <PanelHeader
          title="Son workflow'lar"
          subtitle="Kalıcı job state ve safety sonucu"
          action={<button onClick={() => onNavigate("activity")}>Activity aç</button>}
        />
        <JobTable jobs={jobs.slice(0, 6)} compact />
      </Panel>
    </>
  );
}

function Lab({
  devices,
  robots,
  cameras,
  doctor,
  onDiscover,
  onCreateJob,
}: {
  devices: Device[];
  robots: Robot[];
  cameras: CameraProfile[];
  doctor: DoctorReport | null;
  onDiscover: () => Promise<unknown>;
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  return (
    <>
      <div className="action-row">
        <button className="primary-button" onClick={() => void onDiscover()}>
          <RefreshCw size={17} />
          Cihazları tara
        </button>
        <button
          className="secondary-button"
          onClick={() => void onCreateJob("camera_preview", "sim")}
        >
          <Camera size={17} />
          Kamera contract testi
        </button>
        <span className="inline-note">
          <LockKeyhole size={14} />
          Discovery read-only çalışır.
        </span>
      </div>

      <section className="two-column">
        <Panel>
          <PanelHeader title="Device inventory" subtitle={`${devices.length} resolved device`} />
          <div className="card-list">
            {devices.length === 0 ? (
              <EmptyState icon={Usb} title="Henüz cihaz keşfi yapılmadı" />
            ) : (
              devices.map((device) => (
                <div className="device-card" key={device.id}>
                  <div className={`device-icon ${device.is_simulated ? "sim" : ""}`}>
                    {device.kind === "gpu" ? (
                      <Cpu size={19} />
                    ) : device.kind === "camera" ? (
                      <Camera size={19} />
                    ) : (
                      <Usb size={19} />
                    )}
                  </div>
                  <div className="device-main">
                    <strong>{device.name}</strong>
                    <span>{device.transient_path ?? device.stable_fingerprint}</span>
                    <div className="tag-row">
                      <Tag>{device.kind}</Tag>
                      {device.is_simulated && <Tag tone="blue">simulated</Tag>}
                      <Tag tone={device.health === "ready" ? "green" : "neutral"}>
                        {device.health}
                      </Tag>
                    </div>
                  </div>
                  <CircleCheck size={18} className="success-icon" />
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Robot profiles" subtitle="Hashtag product identity" />
          <div className="card-list">
            {robots.map((robot) => (
              <div className="robot-card" key={robot.id}>
                <div className="robot-card-head">
                  <div>
                    <span className="mono-label">{robot.product_sku}</span>
                    <h3>{robot.name}</h3>
                    <p>{robot.serial_number ?? "serial unresolved"}</p>
                  </div>
                  <StatusBadge value={robot.target_mode} />
                </div>
                <div className="verification-grid">
                  <Verification label="Calibration" value={robot.calibration_verified} />
                  <Verification label="Joint limits" value={robot.joint_limits_verified} />
                  <Verification label="E-stop" value={robot.emergency_stop_ready} />
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </section>

      <section className="two-column">
        <Panel>
          <PanelHeader title="Camera mapping" subtitle="Stable identity → semantic key" />
          {cameras.map((camera) => (
            <div className="camera-row" key={camera.id}>
              <div className="camera-preview">
                <Camera size={24} />
                <span>SAFE MOCK</span>
              </div>
              <div>
                <strong>{camera.name}</strong>
                <span>
                  {camera.width}×{camera.height} · {camera.fps} FPS · {camera.backend}
                </span>
              </div>
              <div className="semantic-key">observation.images.{camera.semantic_name}</div>
            </div>
          ))}
        </Panel>
        <Panel>
          <PanelHeader title="Compatibility alerts" subtitle="Doctor sonucu" />
          <div className="check-list">
            {doctor?.checks
              .filter((check) => check.status !== "pass")
              .slice(0, 6)
              .map((check) => (
                <div className="check-row" key={check.code}>
                  <StatusIcon status={check.status} />
                  <div>
                    <strong>{check.label}</strong>
                    <span>{check.detail}</span>
                  </div>
                </div>
              ))}
          </div>
        </Panel>
      </section>
    </>
  );
}

function Operate({
  robots,
  cameras,
  onCreateJob,
}: {
  robots: Robot[];
  cameras: CameraProfile[];
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
    resources?: Array<Record<string, string>>,
  ) => Promise<unknown>;
}) {
  const [task, setTask] = useState("Pick the object and place it in the target area");
  const [episodes, setEpisodes] = useState(3);
  const robot = robots.find((item) => item.target_mode === "sim");
  return (
    <section className="operate-layout">
      <Panel className="control-panel">
        <PanelHeader title="Session builder" subtitle="Target, resources ve safety context" />
        <div className="form-grid">
          <label>
            Target robot
            <select value={robot?.id ?? ""} disabled>
              <option>{robot?.name ?? "SO-101 simulator"}</option>
            </select>
          </label>
          <label>
            Execution mode
            <select value="sim" disabled>
              <option value="sim">Safe simulation</option>
            </select>
          </label>
          <label className="form-span">
            Task
            <input value={task} onChange={(event) => setTask(event.target.value)} />
          </label>
          <label>
            Episode count
            <input
              type="number"
              min={1}
              max={100}
              value={episodes}
              onChange={(event) => setEpisodes(Number(event.target.value))}
            />
          </label>
          <label>
            Control frequency
            <select value="30" disabled>
              <option value="30">30 Hz</option>
            </select>
          </label>
        </div>
        <div className="preflight-card">
          <div className="preflight-title">
            <ShieldCheck size={18} />
            <strong>Resolved preflight</strong>
            <StatusBadge value="ready" />
          </div>
          <div className="preflight-grid">
            <Verification label="Sim target" value />
            <Verification label="Calibration contract" value />
            <Verification label="Joint limits" value />
            <Verification label="Watchdog" value />
            <Verification label="Front camera" value={cameras.length > 0} />
            <Verification label="Physical torque" value={false} neutral />
          </div>
        </div>
        <div className="button-cluster">
          <button
            className="primary-button"
            onClick={() =>
              void onCreateJob(
                "teleoperation",
                "sim",
                { robot_profile_id: robot?.id, duration_seconds: 8, control_hz: 30 },
                [{ resource_id: "sim-so101", resource_type: "robot", mode: "exclusive" }],
              )
            }
          >
            <Radio size={17} />
            Sim teleop başlat
          </button>
          <button
            className="secondary-button"
            onClick={() =>
              void onCreateJob(
                "recording",
                "sim",
                {
                  name: "SO-101 safe simulation dataset",
                  task,
                  episodes,
                  fps: 30,
                  robot_profile_id: robot?.id,
                  camera_mapping: { front: "observation.images.front" },
                },
                [
                  { resource_id: "sim-so101", resource_type: "robot", mode: "exclusive" },
                  { resource_id: "sim-camera-front", resource_type: "camera", mode: "shared_read" },
                ],
              )
            }
          >
            <Database size={17} />
            Dataset kaydet
          </button>
        </div>
      </Panel>

      <Panel className="telemetry-panel">
        <div className="telemetry-stage">
          <div className="stage-grid" />
          <div className="robot-abstract">
            <span className="robot-base" />
            <span className="robot-arm arm-one" />
            <span className="robot-joint joint-one" />
            <span className="robot-arm arm-two" />
            <span className="robot-joint joint-two" />
            <span className="robot-gripper" />
          </div>
          <div className="stage-label">
            <Radio size={14} />
            SAFE MOCK TELEMETRY
          </div>
        </div>
        <div className="telemetry-metrics">
          <Telemetry label="Control loop" value="30.0 Hz" />
          <Telemetry label="p95 latency" value="27.9 ms" />
          <Telemetry label="Frame age" value="4.0 ms" />
          <Telemetry label="Constraints" value="0" good />
        </div>
      </Panel>
    </section>
  );
}

function DataStudio({
  datasets,
  robots,
  onCreateJob,
}: {
  datasets: Dataset[];
  robots: Robot[];
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const [task, setTask] = useState("Move the foam cube into the bowl");
  return (
    <>
      <section className="two-column">
        <Panel>
          <PanelHeader title="Yeni recording" subtitle="Schema önce, capture sonra" />
          <div className="form-grid">
            <label className="form-span">
              Task instruction
              <input value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
            <label>
              Robot profile
              <select>
                {robots.map((robot) => (
                  <option key={robot.id}>{robot.name}</option>
                ))}
              </select>
            </label>
            <label>
              Dataset FPS
              <select defaultValue="30">
                <option value="30">30 FPS</option>
              </select>
            </label>
          </div>
          <div className="schema-preview">
            <span>FEATURE CONTRACT</span>
            <code>observation.state [6]</code>
            <code>action [6]</code>
            <code>observation.images.front [480, 640, 3]</code>
          </div>
          <button
            className="primary-button full-button"
            onClick={() =>
              void onCreateJob("recording", "sim", {
                name: `Dataset ${datasets.length + 1}`,
                task,
                episodes: 5,
                fps: 30,
                camera_mapping: { front: "observation.images.front" },
              })
            }
          >
            <Play size={17} />
            Safe recording workflow
          </button>
        </Panel>
        <Panel>
          <PanelHeader title="Dataset health" subtitle="Toplam kayıt yüzeyi" />
          <div className="large-stat">
            <strong>{datasets.reduce((total, item) => total + item.episodes, 0)}</strong>
            <span>verified episodes</span>
          </div>
          <div className="health-bars">
            <HealthBar label="Schema coverage" value={datasets.length ? 100 : 0} />
            <HealthBar label="Camera mapping" value={datasets.length ? 100 : 0} />
            <HealthBar label="Provenance" value={datasets.length ? 100 : 0} />
          </div>
        </Panel>
      </section>

      <Panel>
        <PanelHeader title="Dataset registry" subtitle={`${datasets.length} local artifact`} />
        {datasets.length === 0 ? (
          <EmptyState icon={Database} title="İlk safe recording job'ını çalıştır" />
        ) : (
          <div className="registry-table">
            <div className="registry-head">
              <span>Dataset</span>
              <span>Schema</span>
              <span>Episodes</span>
              <span>Integrity</span>
              <span />
            </div>
            {datasets.map((dataset) => (
              <div className="registry-row" key={dataset.id}>
                <div>
                  <strong>{dataset.name}</strong>
                  <span>{dataset.task}</span>
                </div>
                <span className="mono-copy">{dataset.features.length} features · {dataset.fps} FPS</span>
                <strong>{dataset.episodes}</strong>
                <StatusBadge value={dataset.integrity_status} />
                <button
                  className="table-action"
                  onClick={() =>
                    void onCreateJob("dataset_validate", "read_only", {
                      dataset_id: dataset.id,
                    })
                  }
                >
                  Validate
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

function TrainingStudio({
  datasets,
  policies,
  onCreateJob,
}: {
  datasets: Dataset[];
  policies: Policy[];
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const [policyType, setPolicyType] = useState("act");
  const [datasetId, setDatasetId] = useState("");
  useEffect(() => {
    if (!datasetId && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasetId, datasets]);
  return (
    <>
      <section className="two-column training-grid">
        <Panel>
          <PanelHeader title="Training builder" subtitle="Typed, reproducible job config" />
          <div className="form-grid">
            <label className="form-span">
              Source dataset
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                <option value="">Dataset seç</option>
                {datasets.map((dataset) => (
                  <option value={dataset.id} key={dataset.id}>
                    {dataset.name} · {dataset.episodes} episodes
                  </option>
                ))}
              </select>
            </label>
            <label>
              Policy preset
              <select value={policyType} onChange={(event) => setPolicyType(event.target.value)}>
                <option value="act">ACT baseline</option>
                <option value="smolvla">SmolVLA preview</option>
                <option value="diffusion">Diffusion preview</option>
              </select>
            </label>
            <label>
              Runtime
              <select defaultValue="safe-mock">
                <option value="safe-mock">Safe mock trainer</option>
              </select>
            </label>
            <label>
              Action shape
              <input value="[6]" disabled />
            </label>
            <label>
              Accelerator
              <input value="Capability resolved" disabled />
            </label>
          </div>
          <button
            className="primary-button full-button"
            disabled={!datasetId}
            onClick={() =>
              void onCreateJob("training", "sim", {
                dataset_id: datasetId,
                policy_type: policyType,
                name: `${policyType.toUpperCase()} · ${datasets.find((d) => d.id === datasetId)?.name}`,
                action_shape: [6],
                camera_mapping: { front: "observation.images.front" },
              })
            }
          >
            <Cpu size={17} />
            Training job oluştur
          </button>
        </Panel>
        <Panel>
          <PanelHeader title="Compatibility gate" subtitle="Rollout öncesi zorunlu" />
          <div className="compatibility-stack">
            <CompatibilityItem index="01" title="Dataset schema" detail="state/action [6]" />
            <CompatibilityItem index="02" title="Camera mapping" detail="front → observation.images.front" />
            <CompatibilityItem index="03" title="Processor chain" detail="normalization + limits" />
            <CompatibilityItem index="04" title="Target runtime" detail="sim-compatible" />
          </div>
        </Panel>
      </section>

      <Panel>
        <PanelHeader title="Policy registry" subtitle={`${policies.length} policy manifest`} />
        <div className="policy-grid">
          {policies.map((policy) => (
            <div className="policy-card" key={policy.id}>
              <div className="policy-type">{policy.policy_type}</div>
              <h3>{policy.name}</h3>
              <span className="mono-copy">{policy.checkpoint}</span>
              <div className="policy-meta">
                <span>Action {JSON.stringify(policy.action_shape)}</span>
                <StatusBadge value={policy.compatibility_status} />
              </div>
              <button
                className="secondary-button full-button"
                onClick={() =>
                  void onCreateJob("evaluation", "sim", {
                    policy_id: policy.id,
                    episodes: 5,
                    feature_mapping_verified: true,
                  })
                }
              >
                <FlaskConical size={16} />
                Sim evaluation
              </button>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}

function AgentStudio({
  agents,
  onAction,
}: {
  agents: AgentSession[];
  onAction: <T>(action: () => Promise<T>, successMessage: string) => Promise<T | null>;
}) {
  const [selectedId, setSelectedId] = useState("agent_lab_assistant");
  const [selectedAction, setSelectedAction] = useState("inspect_lab");
  const [output, setOutput] = useState<Record<string, unknown> | null>(null);
  const [prompt, setPrompt] = useState(
    "Laboratuvar durumunu analiz et ve bir sonraki güvenli adımı planla.",
  );
  const selected = agents.find((agent) => agent.id === selectedId);

  useEffect(() => {
    if (selected && !selected.permissions.includes(selectedAction)) {
      setSelectedAction(selected.permissions[0] ?? "inspect_lab");
    }
  }, [selected, selectedAction]);

  const run = async () => {
    const parameters: Record<string, unknown> = {};
    if (selectedAction === "prepare_training") {
      parameters.policy_type = "act";
      parameters.target_mode = "sim";
    }
    if (selectedAction === "prepare_evaluation" || selectedAction === "request_rollout") {
      parameters.feature_mapping_verified = true;
      parameters.target_mode = "sim";
      parameters.episodes = 3;
    }
    if (selectedAction === "prepare_recording") {
      parameters.target_mode = "sim";
      parameters.task = "Agent-prepared safe simulation";
      parameters.episodes = 2;
    }
    if (selectedAction === "prepare_teleoperation") {
      parameters.target_mode = "sim";
    }
    const result = await onAction(
      () =>
        api.post<Record<string, unknown>>("/agents/commands", {
          session_id: selectedId,
          action: selectedAction,
          parameters,
        }),
      "Agent command gateway tarafından işlendi.",
    );
    if (result) setOutput(result);
  };

  const planWithStrands = async () => {
    const result = await onAction(
      () =>
        api.post<Record<string, unknown>>("/agents/plan", {
          session_id: selectedId,
          prompt,
          execute: false,
        }),
      "Strands planı üretildi; henüz execute edilmedi.",
    );
    if (result) setOutput(result);
  };

  return (
    <section className="agent-layout">
      <Panel className="agent-roster">
        <PanelHeader title="Agent roster" subtitle="Role-scoped tool registry" />
        <div className="agent-list">
          {agents.map((agent) => (
            <button
              className={`agent-item ${selectedId === agent.id ? "active" : ""}`}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <span className="agent-avatar">
                <Bot size={19} />
              </span>
              <span>
                <strong>{agent.name}</strong>
                <small>{agent.role.replaceAll("_", " ")}</small>
              </span>
              <span className="online-dot" />
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="agent-console">
        <div className="console-head">
          <div>
            <span className="mono-label">DETERMINISTIC COMMAND GATEWAY</span>
            <h2>{selected?.name ?? "Agent"}</h2>
          </div>
          <StatusBadge value={selected?.model_provider ?? "deterministic"} />
        </div>

        <div className="permission-strip">
          <ShieldCheck size={16} />
          <span>
            Bu ajan yalnızca <strong>{selected?.permissions.length ?? 0}</strong> kayıtlı command
            görebilir. Raw serial, shell ve servo stream erişimi yok.
          </span>
        </div>

        <div className="planner-block">
          <label>
            Strands planning prompt
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <button className="secondary-button" onClick={() => void planWithStrands()}>
            <BrainCircuit size={17} />
            Strands ile planla
          </button>
        </div>

        <div className="command-builder">
          <label>
            Allowed action
            <select
              value={selectedAction}
              onChange={(event) => setSelectedAction(event.target.value)}
            >
              {selected?.permissions.map((permission) => (
                <option key={permission} value={permission}>
                  {permission}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" onClick={() => void run()}>
            <BrainCircuit size={17} />
            Command çalıştır
          </button>
        </div>

        <div className="agent-output">
          <div className="output-head">
            <TerminalSquare size={15} />
            <span>Structured result</span>
          </div>
          {output ? (
            <pre>{JSON.stringify(output, null, 2)}</pre>
          ) : (
            <div className="console-empty">
              <BrainCircuit size={24} />
              <span>Bir command seç; sonuç ve safety state burada görünecek.</span>
            </div>
          )}
        </div>
      </Panel>
    </section>
  );
}

function SimulationStudio({
  scenarios,
  onCreateJob,
}: {
  scenarios: Scenario[];
  onCreateJob: (
    kind: string,
    mode: TargetMode,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>;
}) {
  const [remoteUrl, setRemoteUrl] = useState("grpcs://gpu-lab.local:8443");
  return (
    <>
      <section className="scenario-grid">
        {scenarios.map((scenario) => (
          <Panel className="scenario-card" key={scenario.id}>
            <div className="scenario-visual">
              <div className="sim-orbit" />
              <FlaskConical size={30} />
              <span>{scenario.backend.toUpperCase()}</span>
            </div>
            <span className="mono-label">{scenario.scene}</span>
            <h3>{scenario.name}</h3>
            <p>{scenario.task}</p>
            <button
              className="primary-button full-button"
              onClick={() =>
                void onCreateJob("simulation", "sim", {
                  scenario_id: scenario.id,
                })
              }
            >
              <Play size={16} />
              Scenario çalıştır
            </button>
          </Panel>
        ))}
        <Panel className="scenario-card future-card">
          <div className="scenario-visual">
            <div className="sim-orbit alt" />
            <Cpu size={30} />
            <span>CAPABILITY PACK</span>
          </div>
          <span className="mono-label">NEXT ADAPTER</span>
          <h3>MuJoCo contract</h3>
          <p>Kurulu capability görüldüğünde safe mock yerine gerçek sim adapter'ı açılacak.</p>
          <button className="secondary-button full-button" disabled>
            Not installed
          </button>
        </Panel>
      </section>

      <Panel>
        <PanelHeader title="Remote inference gate" subtitle="Ağ erişimi yapmadan protocol preflight" />
        <div className="remote-row">
          <Router size={22} />
          <label>
            TLS endpoint
            <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} />
          </label>
          <button
            className="secondary-button"
            onClick={() =>
              void onCreateJob("remote_inference_probe", "sim", {
                url: remoteUrl,
                tls_required: true,
                transport: "grpc",
              })
            }
          >
            Contract probe
          </button>
        </div>
        <div className="remote-contracts">
          {["TLS required", "Heartbeat", "Stale action reject", "Version manifest"].map(
            (item) => (
              <span key={item}>
                <Check size={13} /> {item}
              </span>
            ),
          )}
        </div>
      </Panel>
    </>
  );
}

function ActivityCenter({
  jobs,
  audit,
  onCancel,
}: {
  jobs: Job[];
  audit: AuditEvent[];
  onCancel: (jobId: string) => Promise<unknown>;
}) {
  return (
    <section className="activity-layout">
      <Panel>
        <PanelHeader title="Job ledger" subtitle={`${jobs.length} persisted workflow`} />
        <JobTable jobs={jobs} onCancel={onCancel} />
      </Panel>
      <Panel>
        <PanelHeader title="Audit trail" subtitle="Command → state → result" />
        <div className="audit-list">
          {audit.map((event) => (
            <div className="audit-row" key={event.id}>
              <span className="audit-node" />
              <div>
                <strong>{event.action}</strong>
                <span>
                  {event.actor} · {event.target}
                </span>
              </div>
              <div className="audit-outcome">
                <StatusBadge value={event.outcome} />
                <small>{formatTime(event.timestamp)}</small>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function SystemReadiness({
  doctor,
  hil,
  onEmergencyStop,
}: {
  doctor: DoctorReport | null;
  hil: HilChecklist | null;
  onEmergencyStop: () => Promise<unknown>;
}) {
  return (
    <>
      <section className="two-column system-grid">
        <Panel>
          <PanelHeader title="System doctor" subtitle={doctor?.overall ?? "loading"} />
          <div className="check-list full">
            {doctor?.checks.map((check) => (
              <div className="check-row" key={check.code}>
                <StatusIcon status={check.status} />
                <div>
                  <strong>{check.label}</strong>
                  <span>{check.detail}</span>
                  {check.remediation && <small>{check.remediation}</small>}
                </div>
                <StatusBadge value={check.status} />
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="hil-panel">
          <div className="hil-lock">
            <LockKeyhole size={30} />
          </div>
          <span className="mono-label">HARDWARE-IN-THE-LOOP GATE</span>
          <h2>Fiziksel test sınırı</h2>
          <p>
            Yazılım akışları tamamlandıktan sonra gerçek SO-101 bağlandığında bu maddeler
            birlikte doğrulanacak.
          </p>
          <div className="hil-list">
            {hil?.checks.map((check) => (
              <div key={check.id}>
                <span className={check.status === "pending" ? "pending-box" : "manual-box"} />
                <strong>{check.label}</strong>
                <small>{check.status}</small>
              </div>
            ))}
          </div>
          <button className="estop large" onClick={() => void onEmergencyStop()}>
            <Octagon size={18} fill="currentColor" />
            Emergency stop yolunu doğrula
          </button>
        </Panel>
      </section>

      <Panel>
        <PanelHeader title="Release surface" subtitle="Local-first product packaging" />
        <div className="release-grid">
          <ReleaseItem icon={HardDrive} title="Local state" detail="SQLite + artifact directory" />
          <ReleaseItem icon={TerminalSquare} title="Python package" detail="uv tool / pipx entrypoint" />
          <ReleaseItem icon={ShieldCheck} title="Safe default" detail="Physical adapters locked" />
          <ReleaseItem icon={ListChecks} title="Diagnostics" detail="Redacted support payload" />
        </div>
      </Panel>
    </>
  );
}

function Panel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={`panel ${className}`}>{children}</section>;
}

function PanelHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        <span>{subtitle}</span>
      </div>
      {action && <div className="panel-action">{action}</div>}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: LucideIcon;
  tone?: "neutral" | "good" | "warning";
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-icon">
        <Icon size={19} />
      </div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function CapabilityRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: string;
}) {
  return (
    <div className="capability-row">
      <StatusIcon status={status} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <div className={`status-pill status-${status}`}>
      <span />
      {status === "pass" ? "System nominal" : status.replaceAll("_", " ")}
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return <span className={`status-badge value-${normalized}`}>{value.replaceAll("_", " ")}</span>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "pass" || status === "completed" || status === "ready") {
    return <CircleCheck size={18} className="success-icon" />;
  }
  if (status === "blocked" || status === "failed") {
    return <CircleAlert size={18} className="danger-icon" />;
  }
  return <CircleAlert size={18} className="warning-icon" />;
}

function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "blue";
}) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

function Verification({
  label,
  value,
  neutral = false,
}: {
  label: string;
  value: boolean;
  neutral?: boolean;
}) {
  return (
    <span className={`verification ${value ? "verified" : neutral ? "neutral" : "missing"}`}>
      {value ? <Check size={13} /> : neutral ? <Square size={12} /> : <X size={13} />}
      {label}
    </span>
  );
}

function JobTable({
  jobs,
  compact = false,
  onCancel,
}: {
  jobs: Job[];
  compact?: boolean;
  onCancel?: (jobId: string) => Promise<unknown>;
}) {
  if (jobs.length === 0) {
    return <EmptyState icon={Workflow} title="Henüz job oluşturulmadı" />;
  }
  return (
    <div className={`job-table ${compact ? "compact" : ""}`}>
      {jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <div className={`job-state-icon state-${job.state}`}>
            {["queued", "starting", "running", "stopping"].includes(job.state) ? (
              <LoaderCircle size={17} className="spin" />
            ) : job.state === "completed" ? (
              <Check size={17} />
            ) : job.state === "blocked" || job.state === "failed" ? (
              <CircleAlert size={17} />
            ) : (
              <Workflow size={17} />
            )}
          </div>
          <div className="job-main">
            <div>
              <strong>{job.kind.replaceAll("_", " ")}</strong>
              <span className="job-id">{job.id}</span>
            </div>
            <span>{job.message}</span>
            <div className="progress-track">
              <span style={{ width: `${Math.max(2, job.progress * 100)}%` }} />
            </div>
          </div>
          <div className="job-meta">
            <StatusBadge value={job.state} />
            <small>{formatTime(job.updated_at)}</small>
          </div>
          {onCancel &&
            ["queued", "starting", "running", "stopping", "awaiting_confirmation"].includes(
              job.state,
            ) && (
              <button className="job-cancel" onClick={() => void onCancel(job.id)}>
                <Square size={13} fill="currentColor" />
              </button>
            )}
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={24} />
      <span>{title}</span>
    </div>
  );
}

function Telemetry({
  label,
  value,
  good = false,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={good ? "good-text" : ""}>{value}</strong>
    </div>
  );
}

function HealthBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="health-bar">
      <div>
        <span>{label}</span>
        <strong>{value}%</strong>
      </div>
      <div className="health-track">
        <span style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function CompatibilityItem({
  index,
  title,
  detail,
}: {
  index: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="compatibility-item">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
      </div>
      <CircleCheck size={17} className="success-icon" />
    </div>
  );
}

function ReleaseItem({
  icon: Icon,
  title,
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
}) {
  return (
    <div className="release-item">
      <Icon size={20} />
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export default App;
