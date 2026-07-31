import {
  Activity,
  Bot,
  BrainCircuit,
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Cpu,
  Database,
  FlaskConical,
  Gauge,
  HardDrive,
  Info,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Moon,
  Octagon,
  Play,
  Radio,
  RefreshCw,
  Router,
  ShieldCheck,
  Square,
  Sun,
  TerminalSquare,
  Usb,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  subscribeEvents,
  type AgentAction,
  type AgentPlanResult,
  type AgentSession,
  type AgentTurn,
  type AuditEvent,
  type CalibrationArtifact,
  type Camera as CameraProfile,
  type CommandPreview,
  type Dataset,
  type DatasetComparison,
  type DatasetEpisode,
  type DatasetEpisodes,
  type Device,
  type DeviceIdentification,
  type DoctorReport,
  type HilChecklist,
  type Job,
  type JobSnapshot,
  type PlannerStatus,
  type Policy,
  type Robot,
  type SafetyCheck,
  type SafetyStatus,
  type Scenario,
  type SimulationBackends,
  type SetupStatus,
  type SetupStep,
  type SetupStepState,
  type Summary,
  type TargetMode,
  type Teleoperator,
  type TelemetrySummary,
} from "./api";

/** Mirrors JOB_INPUT_KEYS in jobs.py; the server rejects anything else. */
const OPERATOR_KEYS: Record<string, Array<{ key: string; label: string }>> = {
  calibration: [
    { key: "enter", label: "ENTER gönder" },
    { key: "use_existing_calibration", label: "Mevcut kalibrasyonu kullan" },
    { key: "recalibrate", label: "Yeniden kalibre et" },
  ],
  motor_setup: [{ key: "enter", label: "ENTER gönder" }],
  recording: [
    { key: "end_episode", label: "Bölümü bitir" },
    { key: "rerecord_episode", label: "Bölümü tekrar kaydet" },
    { key: "stop_recording", label: "Kaydı durdur" },
  ],
  // The simulated recorder listens for the same escape sequences, so the same
  // three buttons drive it. Without them a simulated session could only be
  // cancelled, which kills the process and loses the take in progress.
  sim_recording: [
    { key: "end_episode", label: "Bölümü bitir" },
    { key: "rerecord_episode", label: "Bölümü tekrar kaydet" },
    { key: "stop_recording", label: "Kaydı durdur" },
  ],
  evaluation: [
    { key: "end_episode", label: "Bölümü bitir" },
    { key: "rerecord_episode", label: "Bölümü tekrar kaydet" },
    { key: "stop_recording", label: "Rollout'u durdur" },
  ],
  policy_rollout: [
    { key: "end_episode", label: "Bölümü bitir" },
    { key: "rerecord_episode", label: "Bölümü tekrar kaydet" },
    { key: "stop_recording", label: "Rollout'u durdur" },
  ],
};

const ACTIVE_STATES = ["queued", "starting", "running", "stopping"];

/** Which page owns a job, so its approval card and live output appear once. */
const JOB_PAGE: Record<string, View> = {
  motor_setup: "setup",
  calibration: "setup",
  teleoperation: "operate",
  recording: "collect",
  replay: "operate",
  evaluation: "operate",
  policy_rollout: "operate",
  sim_teleoperation: "operate",
  // Recording is the whole point of the collection page, so its approval card
  // and its live output belong there rather than beside teleoperation.
  sim_recording: "collect",
  // Editing a dataset is a job too, and the page that owns it is the one where
  // the operator asked for it.
  dataset_transform: "data",
  hub_sync: "data",
};

/**
 * How a recording came to exist, as the operator needs to read it.
 *
 * Four states, not two. A recording made before the source was written down
 * says nothing about where it came from, and showing "real arm" for it would be
 * inventing the answer. A merge of simulated and real takes is neither one nor
 * the other -- and that mixture is the normal shape of a co-training set, so it
 * gets said out loud rather than rounded to whichever input came first.
 */
const PROVENANCE: Record<string, { label: string; tone: "blue" | "green" | "amber" }> = {
  simulation: { label: "simülasyon", tone: "blue" },
  // The string the recorder writes is "real-arm", not "real". Keying this map
  // on a guess is how a real recording ends up labelled "source not recorded".
  "real-arm": { label: "gerçek kol", tone: "green" },
  mixed: { label: "karışık (sim + gerçek)", tone: "amber" },
};

/**
 * A comparison's `values` as lines a person reads, rather than one JSON blob.
 *
 * The shape varies: usually `{repo_id: value}`, but a feature disagreement
 * nests down to the field that differs. The blob hid the one line that mattered
 * -- a video info key renamed between LeRobot versions -- inside a wall of
 * punctuation.
 */
function differenceLines(values: unknown, prefix = ""): string[] {
  if (values == null || typeof values !== "object") {
    return [`${prefix}${JSON.stringify(values)}`];
  }
  const entries = Object.entries(values as Record<string, unknown>);
  const pair = entries.length === 2 && entries.every(([key]) => key === "a" || key === "b");
  if (pair) {
    const record = values as Record<string, unknown>;
    return [`${prefix.replace(/\.$/, "")}: ${JSON.stringify(record.a)} ↔ ${JSON.stringify(record.b)}`];
  }
  return entries.flatMap(([key, value]) =>
    value != null && typeof value === "object"
      ? differenceLines(value, `${prefix}${key}.`)
      : [`${prefix}${key}: ${JSON.stringify(value)}`],
  );
}

const JOB_LABEL: Record<string, string> = {
  motor_setup: "Motor setup",
  calibration: "Kalibrasyon",
  teleoperation: "Teleoperation",
  recording: "Kayıt",
  replay: "Replay",
  evaluation: "Evaluation",
  policy_rollout: "Policy rollout",
  sim_teleoperation: "Sim prova",
  sim_recording: "Sim kaydı",
  dataset_transform: "Veri seti düzenleme",
  hub_sync: "Hub'a gönderim",
};

/**
 * Jobs worth opening the camera window for on their own. Teleoperation is here
 * because the dashboard can show it live; recording is here because the
 * operator still needs to see what the take is framed on, even frozen.
 */
const CAMERA_MODAL_JOB_KINDS = ["teleoperation", "recording", "evaluation", "policy_rollout"];

const SETUP_JOB_KINDS = ["motor_setup", "calibration"];
const OPERATE_JOB_KINDS = [
  "teleoperation",
  "sim_teleoperation",
  "replay",
  "evaluation",
  "policy_rollout",
];

function pendingApprovalFor(jobs: Job[], kinds: string[]): Job | undefined {
  return jobs.find((job) => job.state === "awaiting_confirmation" && kinds.includes(job.kind));
}

function activeJobFor(jobs: Job[], kinds: string[]): Job | undefined {
  return jobs.find((job) => ACTIVE_STATES.includes(job.state) && kinds.includes(job.kind));
}

type View =
  | "overview"
  | "setup"
  | "lab"
  | "operate"
  | "collect"
  | "data"
  | "training"
  | "agents"
  | "activity"
  | "system";

/**
 * The sidebar is the pipeline, read top to bottom.
 *
 * It used to describe the software instead: recording could be started from
 * Operate and from Simulation, dataset management sat somewhere else, and
 * Simulation was a page even though the server had already made simulation a
 * *target*. Three doors to one activity is the shape of "scattered".
 *
 * Now: prepare the arm, drive it, then collect -> curate -> train, in that
 * order, each step consuming what the one above it produced.
 */
const NAVIGATION: Array<{
  id: View;
  label: string;
  description: string;
  icon: LucideIcon;
  group?: string;
}> = [
  { id: "overview", label: "Genel Bakış", description: "Control plane", icon: Gauge },
  { id: "setup", label: "Kurulum", description: "Kimlik ve kalibrasyon", icon: Wrench },
  { id: "lab", label: "Robot Lab", description: "Cihazlar ve kamera", icon: Usb },
  { id: "operate", label: "Operate", description: "Kolu sür: teleop, replay", icon: Radio },
  {
    id: "collect",
    label: "Veri Topla",
    description: "Gerçek kol veya simülasyon",
    icon: FlaskConical,
    group: "VERİ HATTI",
  },
  { id: "data", label: "Veri Setleri", description: "Bölüm, karşılaştır, birleştir", icon: Database },
  { id: "training", label: "Eğitim", description: "Politika eğit ve değerlendir", icon: Cpu },
  { id: "agents", label: "Agents", description: "Strands gateway", icon: BrainCircuit, group: "ARAÇLAR" },
  { id: "activity", label: "Activity", description: "Job ve audit", icon: Activity },
  { id: "system", label: "System", description: "Doctor ve HIL", icon: TerminalSquare },
];

const PAGE_COPY: Record<View, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: "LOCAL CONTROL PLANE",
    title: "SO-101 operasyon merkezi",
    description: "Donanımdan policy'ye kadar bütün yaşam döngüsünü güvenli bir yerde yönet.",
  },
  setup: {
    eyebrow: "PHASE 1 · SETUP",
    title: "Kolu tanıt, motorları kur, kalibre et",
    description: "Portu sunucu çözer; sen kolun adını verir ve fiziksel adımları onaylarsın.",
  },
  lab: {
    eyebrow: "PHASE 1 · ROBOT LAB",
    title: "Cihaz, profil ve kamera",
    description: "Önce gözlemle, kimliği çöz, sonra fiziksel kaynaklara izin ver.",
  },
  operate: {
    eyebrow: "PHASE 1 · OPERATE",
    title: "Teleop ve recording workflow'ları",
    description: "Sim güvenli varsayılan; gerçek hareket çözümlenmiş onay kartından geçer.",
  },
  collect: {
    eyebrow: "VERİ HATTI · 1/3",
    title: "Veri topla",
    description:
      "Gerçek kolla ya da simülasyonda gösterim kaydet. Hedef bir anahtar; kayıt aynı biçimde yazılır.",
  },
  data: {
    eyebrow: "VERİ HATTI · 2/3",
    title: "Veri setlerini yönet",
    description:
      "Bölümleri gör, bozuk çekimi çıkar, birlikte eğitilebilir mi bak, birleştir.",
  },
  training: {
    eyebrow: "VERİ HATTI · 3/3",
    title: "Eğit ve değerlendir",
    description: "Yönettiğin veri setiyle politika eğit; çıkanı gerçek kolda değerlendir.",
  },
  agents: {
    eyebrow: "PHASE 3 · AGENT STUDIO",
    title: "Dar yetkili robot ajanları",
    description: "Ajan talepleri doğrudan robota değil deterministic command gateway'e gider.",
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

const VIEW_IDS = NAVIGATION.map((item) => item.id);

function initialView(): View {
  const hash = window.location.hash.replace("#", "") as View;
  return VIEW_IDS.includes(hash) ? hash : "overview";
}

function App() {
  const [view, setViewState] = useState<View>(initialView);

  /** Views are bookmarkable so a bench session can be reopened where it left off. */
  const setView = useCallback((next: View) => {
    setViewState(next);
    window.history.replaceState(null, "", `#${next}`);
  }, []);

  useEffect(() => {
    const onHashChange = () => setViewState(initialView());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [teleoperators, setTeleoperators] = useState<Teleoperator[]>([]);
  const [calibrations, setCalibrations] = useState<CalibrationArtifact[]>([]);
  const [safety, setSafety] = useState<SafetyStatus | null>(null);
  const [telemetry, setTelemetry] = useState<Record<string, TelemetrySummary>>({});
  const [live, setLive] = useState(false);
  const [cameras, setCameras] = useState<CameraProfile[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [agents, setAgents] = useState<AgentSession[]>([]);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [hil, setHil] = useState<HilChecklist | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraModalId, setCameraModalId] = useState<string | null>(null);
  const [cameraModalDismissed, setCameraModalDismissed] = useState<string | null>(null);
  const [leases, setLeases] = useState<JobSnapshot["leases"]>([]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const [
        summaryData,
        doctorData,
        deviceData,
        robotData,
        teleoperatorData,
        calibrationData,
        safetyData,
        cameraData,
        datasetData,
        policyData,
        agentData,
        scenarioData,
        jobData,
        auditData,
        hilData,
        setupData,
      ] = await Promise.all([
        api.get<Summary>("/summary"),
        api.get<DoctorReport>("/system/doctor"),
        api.get<Device[]>("/devices"),
        api.get<Robot[]>("/robots"),
        api.get<Teleoperator[]>("/teleoperators"),
        api.get<CalibrationArtifact[]>("/calibrations"),
        api.get<SafetyStatus>("/safety/status"),
        api.get<CameraProfile[]>("/cameras"),
        api.get<Dataset[]>("/datasets"),
        api.get<Policy[]>("/policies"),
        api.get<AgentSession[]>("/agents/sessions"),
        api.get<Scenario[]>("/simulation/scenarios"),
        api.get<Job[]>("/jobs?limit=100"),
        api.get<AuditEvent[]>("/audit?limit=100"),
        api.get<HilChecklist>("/system/hil-checklist"),
        api.get<SetupStatus>("/setup/status"),
      ]);
      setSummary(summaryData);
      setDoctor(doctorData);
      setDevices(deviceData);
      setRobots(robotData);
      setTeleoperators(teleoperatorData);
      setCalibrations(calibrationData);
      setSafety(safetyData);
      setCameras(cameraData);
      setDatasets(datasetData);
      setPolicies(policyData);
      setAgents(agentData);
      setScenarios(scenarioData);
      setJobs(jobData);
      setAudit(auditData);
      setHil(hilData);
      setSetup(setupData);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Bağlantı hatası");
    } finally {
      if (!quiet) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Jobs and telemetry arrive over the socket; this only re-reads the slow surfaces.
    const interval = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(
    () =>
      subscribeEvents((snapshot) => {
        setJobs(snapshot.jobs);
        setTelemetry(snapshot.telemetry ?? {});
        setLeases(snapshot.leases ?? []);
      }, setLive),
    [],
  );

  /**
   * The arm is about to move with a camera pointed at it, so put the camera on
   * screen without being asked. Dismissing it is remembered per job: an operator
   * who closed the window during this recording does not want it back on the
   * next telemetry frame.
   */
  const cameraJob = useMemo(
    () =>
      jobs.find(
        (job) =>
          ACTIVE_STATES.includes(job.state) &&
          job.target_mode === "real" &&
          CAMERA_MODAL_JOB_KINDS.includes(job.kind) &&
          Object.keys(job.resolved_targets?.camera_profile_ids ?? {}).length > 0,
      ) ?? null,
    [jobs],
  );

  useEffect(() => {
    if (!cameraJob) return;
    if (cameraModalDismissed === cameraJob.id) return;
    const mapped = Object.values(cameraJob.resolved_targets?.camera_profile_ids ?? {})[0];
    if (mapped) setCameraModalId(mapped);
  }, [cameraJob, cameraModalDismissed]);

  const modalCamera = cameras.find((item) => item.id === cameraModalId) ?? null;
  const cameraHolderId = leases.find(
    (lease) => lease.resource_type === "camera" && lease.resource_id === cameraModalId,
  )?.owner_job_id;
  const cameraHolder = jobs.find((job) => job.id === cameraHolderId) ?? null;

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

  const clearEstop = useCallback(
    () =>
      runAction(
        () => api.post<{ was_engaged: boolean }>("/safety/clear-estop"),
        "Emergency stop mandalı açıldı.",
      ),
    [runAction],
  );

  const confirmJob = useCallback(
    (jobId: string, approvalId: string) =>
      runAction(
        () => api.post<Job>(`/jobs/${jobId}/confirm`, { approval_id: approvalId }),
        "Fiziksel hareket onaylandı ve kuyruğa alındı.",
      ),
    [runAction],
  );

  const annotateJob = useCallback(
    (jobId: string, episode: number, outcome: "success" | "failure") =>
      runAction(
        () => api.post<Job>(`/jobs/${jobId}/annotate`, { episode, outcome }),
        `Bölüm ${episode} işaretlendi: ${outcome}`,
      ),
    [runAction],
  );

  const sendJobInput = useCallback(
    (jobId: string, key: string) =>
      runAction(
        () => api.post<Job>(`/jobs/${jobId}/input`, { key }),
        `Operatör tuşu gönderildi: ${key}`,
      ),
    [runAction],
  );

  const saveRobot = useCallback(
    (profile: Partial<Robot>) =>
      runAction(() => api.post<Robot>("/robots", profile), "Follower profili kaydedildi."),
    [runAction],
  );

  const discoverCameras = useCallback(
    () => runAction(() => api.post<Device[]>("/cameras/discover"), "Kamera keşfi tamamlandı."),
    [runAction],
  );

  const saveDataset = useCallback(
    (dataset: Partial<Dataset>) =>
      runAction(() => api.post<Dataset>("/datasets", dataset), "Dataset kaydedildi."),
    [runAction],
  );

  const saveCamera = useCallback(
    (profile: Partial<CameraProfile>) =>
      runAction(() => api.post<CameraProfile>("/cameras", profile), "Kamera profili kaydedildi."),
    [runAction],
  );

  const saveTeleoperator = useCallback(
    (profile: Partial<Teleoperator>) =>
      runAction(
        () => api.post<Teleoperator>("/teleoperators", profile),
        "Leader profili kaydedildi.",
      ),
    [runAction],
  );

  const validateRobot = useCallback(
    (robotId: string) => api.post<SafetyCheck[]>(`/robots/${robotId}/validate`),
    [],
  );

  const identifyDevice = useCallback(
    (deviceId: string) =>
      runAction(
        () => api.post<DeviceIdentification>("/setup/identify", { device_id: deviceId }),
        "Kol tanındı; hiçbir eklem oynatılmadı.",
      ),
    [runAction],
  );

  const assignSlot = useCallback(
    (role: string, deviceId: string, maxRelativeTarget?: number) =>
      runAction(
        () =>
          api.post<SetupStatus>("/setup/slots", {
            role,
            device_id: deviceId,
            ...(maxRelativeTarget === undefined
              ? {}
              : { max_relative_target: maxRelativeTarget }),
          }),
        "Kol yuvaya atandı.",
      ),
    [runAction],
  );

  const releaseSlot = useCallback(
    (role: string) =>
      runAction(
        () => api.post<SetupStatus>("/setup/slots", { role, device_id: null }),
        "Yuva boşaltıldı.",
      ),
    [runAction],
  );

  const page = PAGE_COPY[view];
  const estopEngaged = safety?.emergency_stop_engaged ?? false;
  const awaitingApproval = jobs.find(
    (job) => job.state === "awaiting_confirmation" && JOB_PAGE[job.kind],
  );
  const runningElsewhere = jobs.find(
    (job) =>
      ACTIVE_STATES.includes(job.state) &&
      JOB_PAGE[job.kind] &&
      JOB_PAGE[job.kind] !== view &&
      job.target_mode === "real",
  );
  const physicalRunning = jobs.some(
    (job) => job.target_mode === "real" && ACTIVE_STATES.includes(job.state),
  );

  /**
   * HEDEF_MIMARI 8.4 asks for a keyboard path next to the button. Escape only
   * arms while real hardware is moving, and stopping is always the safe outcome.
   */
  useEffect(() => {
    if (!physicalRunning) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void emergencyStop();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [physicalRunning, emergencyStop]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setView("overview")} aria-label="Genel bakış">
          <BrandMark />
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
              <Fragment key={item.id}>
                {item.group && <span className="nav-group">{item.group}</span>}
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
              </Fragment>
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
            <span className={`live-pill ${live ? "on" : "off"}`} title="Canlı job akışı">
              <span />
              {live ? "LIVE" : "OFFLINE"}
            </span>
            <StatusPill status={summary?.system_status ?? "warning"} />
            <ThemeToggle />
            <button
              className="icon-button"
              onClick={() => void refresh()}
              disabled={busy}
              aria-label="Yenile"
            >
              <RefreshCw size={17} className={busy ? "spin" : ""} />
            </button>
            <button
              className={`estop ${physicalRunning ? "armed" : ""}`}
              title={physicalRunning ? "ESC tuşu da acil durdurur" : "Acil durdurma"}
              onClick={() => void emergencyStop()}
            >
              <Octagon size={17} fill="currentColor" />
              E-STOP{physicalRunning ? " · ESC" : ""}
            </button>
          </div>
        </header>

        {/* An approval expires in five minutes, so it must be findable from
            wherever the operator happens to be standing. */}
        {awaitingApproval && JOB_PAGE[awaitingApproval.kind] !== view && (
          <div className="approval-banner">
            <ListChecks size={19} />
            <div>
              <strong>Onay bekleyen fiziksel iş var</strong>
              <span>
                {JOB_LABEL[awaitingApproval.kind] ?? awaitingApproval.kind} · onaylanmazsa beş
                dakika içinde düşer
              </span>
            </div>
            <button onClick={() => setView(JOB_PAGE[awaitingApproval.kind])}>
              Onay kartına git <ChevronRight size={15} />
            </button>
          </div>
        )}

        {runningElsewhere && (
          <div className="running-banner">
            <LoaderCircle size={19} className="spin" />
            <div>
              <strong>
                {JOB_LABEL[runningElsewhere.kind] ?? runningElsewhere.kind} çalışıyor
              </strong>
              <span>{runningElsewhere.message}</span>
            </div>
            <button onClick={() => setView(JOB_PAGE[runningElsewhere.kind])}>
              Canlı karta git <ChevronRight size={15} />
            </button>
          </div>
        )}

        {estopEngaged && (
          <div className="estop-banner">
            <Octagon size={19} fill="currentColor" />
            <div>
              <strong>Emergency stop mandallı</strong>
              <span>
                Bütün fiziksel işler bloklu. Çalışma alanının güvenli olduğunu doğruladıktan
                sonra mandalı aç.
              </span>
            </div>
            <button onClick={() => void clearEstop()}>Mandalı aç</button>
          </div>
        )}

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
          {view === "setup" && (
            <SetupWizard
              status={setup}
              devices={devices}
              jobs={jobs}
              telemetry={telemetry}
              onDiscover={discover}
              onIdentify={identifyDevice}
              onAssignSlot={assignSlot}
              onReleaseSlot={releaseSlot}
              onCreateJob={createJob}
              onConfirm={confirmJob}
              onInput={sendJobInput}
              onCancel={cancelJob}
            />
          )}
          {view === "lab" && (
            <Lab
              devices={devices}
              robots={robots}
              cameras={cameras}
              doctor={doctor}
              onDiscover={discover}
              onDiscoverCameras={discoverCameras}
              onSaveCamera={saveCamera}
              onSaveRobot={saveRobot}
              onCreateJob={createJob}
            />
          )}
          {view === "operate" && (
            <Operate
              robots={robots}
              teleoperators={teleoperators}
              cameras={cameras}
              jobs={jobs}
              telemetry={telemetry}
              safety={safety}
              onCreateJob={createJob}
              onConfirm={confirmJob}
              onInput={sendJobInput}
              onCancel={cancelJob}
              onEmergencyStop={emergencyStop}
            />
          )}
          {view === "data" && (
            <DataStudio
              datasets={datasets}
              jobs={jobs}
              telemetry={telemetry}
              onCreateJob={createJob}
              onSaveDataset={saveDataset}
              onInput={sendJobInput}
              onCancel={cancelJob}
              onRefresh={() => refresh(true)}
            />
          )}
          {view === "training" && (
            <TrainingStudio
              datasets={datasets}
              policies={policies}
              jobs={jobs}
              onCreateJob={createJob}
              onAnnotate={annotateJob}
            />
          )}
          {view === "agents" && (
            <AgentStudio agents={agents} onAction={runAction} />
          )}
          {view === "collect" && (
            <CollectStudio
              robots={robots}
              teleoperators={teleoperators}
              scenarios={scenarios}
              jobs={jobs}
              telemetry={telemetry}
              safety={safety}
              onCreateJob={createJob}
              onConfirm={confirmJob}
              onInput={sendJobInput}
              onCancel={cancelJob}
            />
          )}
          {view === "activity" && (
            <ActivityCenter jobs={jobs} audit={audit} onCancel={cancelJob} />
          )}
          {view === "system" && (
            <SystemReadiness doctor={doctor} hil={hil} onEmergencyStop={emergencyStop} />
          )}
        </div>
      </main>
      {modalCamera && (
        <CameraLiveModal
          camera={modalCamera}
          holder={cameraHolder}
          telemetry={cameraHolder ? telemetry[cameraHolder.id] : undefined}
          onClose={() => {
            setCameraModalId(null);
            setCameraModalDismissed(cameraJob?.id ?? null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The camera view an operator needs while the arm is moving.
 *
 * One V4L2 node serves one program at a time, and this bench has exactly one
 * camera, so "live view during a recording" is not a feature that was left
 * unbuilt -- it is arithmetic. What the modal can do is be honest about which
 * of the two situations it is in:
 *
 * During teleoperation the dashboard owns the camera (the teleop command no
 * longer claims it, because it recorded nothing with it anyway), so the feed is
 * genuinely live. This is also when live framing matters most: it is the moment
 * before the take, when the object still gets moved into shot.
 *
 * During a recording LeRobot owns it. Rather than showing an empty box, the
 * modal freezes the last frame it captured -- the framing as the recording
 * started -- and puts the recording's own telemetry beside it, so the operator
 * can still see that frames are being written and at what rate.
 */
function CameraLiveModal({
  camera,
  holder,
  telemetry,
  onClose,
}: {
  camera: CameraProfile;
  holder: Job | null;
  telemetry: TelemetrySummary | undefined;
  onClose: () => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [failed, setFailed] = useState(false);
  const held = holder !== null;

  /**
   * Keep a recent still so there is something to show the instant the camera is
   * taken away. An MJPEG <img> can be drawn to a canvas like any image, and once
   * a second is cheap enough to be invisible next to a 30 fps stream.
   */
  useEffect(() => {
    if (held) return;
    const capture = () => {
      const image = imageRef.current;
      const canvas = canvasRef.current;
      if (!image || !canvas || !image.naturalWidth) return;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      setFrozen(true);
    };
    const timer = window.setInterval(capture, 1000);
    return () => window.clearInterval(timer);
  }, [held]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase: the global Escape handler stops the robot, and closing a
    // window must never be one keypress away from an emergency stop.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const episode = telemetry?.episode?.episode;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal camera-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${camera.name} görüntüsü`}
      >
        <div className="modal-head">
          <div>
            <strong>{camera.name}</strong>
            <span>
              {camera.width}×{camera.height} · {camera.fps} FPS · {camera.semantic_name}
            </span>
          </div>
          {held ? <Tag tone="blue">dondurulmuş</Tag> : <Tag tone="green">canlı</Tag>}
          <button className="icon-button" onClick={onClose} aria-label="Kapat">
            <X size={17} />
          </button>
        </div>

        <div className="camera-modal-stage">
          <canvas ref={canvasRef} className="camera-modal-frame" hidden={!held || !frozen} />
          {!held && (
            <img
              ref={imageRef}
              className="camera-modal-frame"
              src={`/api/cameras/${camera.id}/preview.mjpg`}
              alt={`${camera.name} canlı görüntü`}
              onError={() => setFailed(true)}
              onLoad={() => setFailed(false)}
            />
          )}
          {held && !frozen && (
            <div className="camera-modal-blank">
              Bu kamera bu oturumda hiç önizlenmedi, o yüzden gösterilecek kare yok.
            </div>
          )}
          {!held && failed && (
            <div className="camera-modal-blank">
              Görüntü akışı açılamadı. Kamera hâlâ takılı mı?
            </div>
          )}
        </div>

        {held && (
          <div className="camera-modal-note">
            <p>
              <strong>{JOB_LABEL[holder.kind] ?? holder.kind}</strong> işi bu kamerayı
              kullanıyor. Bir kamerayı aynı anda tek bir program okuyabilir, bu yüzden yukarıdaki
              kare kaydın başladığı andaki görüntüdür — iş bitince akış geri gelir.
            </p>
            <div className="camera-modal-facts">
              <span>{holder.message}</span>
              {episode != null && <span>bölüm {episode + 1}</span>}
              {telemetry?.p50_loop_ms != null && (
                <span>döngü p50 {telemetry.p50_loop_ms.toFixed(2)} ms</span>
              )}
            </div>
          </div>
        )}
      </div>
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

const STEP_TONE: Record<SetupStepState, string> = {
  done: "done",
  ready: "ready",
  blocked: "blocked",
  not_applicable: "skip",
};

const STEP_WORD: Record<SetupStepState, string> = {
  done: "Tamamlandı",
  ready: "Sıradaki",
  blocked: "Şimdi yapılamaz",
  not_applicable: "Gerekmiyor",
};

/**
 * Commissioning is a procedure over exactly two arms, not a form that creates
 * profiles, so the surface is two slots and three steps. The server owns every
 * judgement here; this component only shows what it decided and why.
 */
function SetupWizard({
  status,
  devices,
  jobs,
  telemetry,
  onDiscover,
  onIdentify,
  onAssignSlot,
  onReleaseSlot,
  onCreateJob,
  onConfirm,
  onInput,
  onCancel,
}: {
  status: SetupStatus | null;
  devices: Device[];
  jobs: Job[];
  telemetry: Record<string, TelemetrySummary>;
  onDiscover: () => Promise<unknown>;
  onIdentify: (deviceId: string) => Promise<DeviceIdentification | null>;
  onAssignSlot: (
    role: string,
    deviceId: string,
    limit?: number,
  ) => Promise<SetupStatus | null>;
  onReleaseSlot: (role: string) => Promise<SetupStatus | null>;
  onCreateJob: CreateJob;
  onConfirm: (jobId: string, approvalId: string) => Promise<unknown>;
  onInput: (jobId: string, key: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
}) {
  const [identified, setIdentified] = useState<Record<string, DeviceIdentification>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(5);
  const [workspace, setWorkspace] = useState<Record<string, boolean>>({});

  const serial = useMemo(
    () => devices.filter((item) => item.kind === "serial" && !item.is_simulated),
    [devices],
  );
  // Only this page's own work belongs here; an approval that lives elsewhere
  // showing up in Setup is what made every command look like a setup step.
  const pendingApproval = pendingApprovalFor(jobs, SETUP_JOB_KINDS);
  const activeJob = activeJobFor(jobs, SETUP_JOB_KINDS);
  const lastCalibration = jobs.find(
    (job) => job.kind === "calibration" && job.state === "completed",
  );

  const identify = async (deviceId: string) => {
    const result = await onIdentify(deviceId);
    if (result) setIdentified((current) => ({ ...current, [deviceId]: result }));
  };

  if (!status) {
    return (
      <Panel>
        <EmptyState icon={Wrench} title="Kurulum durumu yükleniyor" />
      </Panel>
    );
  }

  const steps = status.steps;
  const stepById = (id: string) => steps.find((step) => step.id === id);
  const identifyStep = stepById("identify");
  const calibrateStep = stepById("calibrate");
  const verifyStep = stepById("verify");

  /** A device is offered to a slot unless the other slot already holds it. */
  const candidatesFor = (role: string) => {
    const taken = status.slots
      .filter((slot) => slot.role !== role)
      .map((slot) => slot.device_fingerprint)
      .filter(Boolean);
    return serial.filter((device) => !taken.includes(device.stable_fingerprint));
  };

  const slotOf = (role: string) => status.slots.find((slot) => slot.role === role);

  return (
    <section className="setup-layout">
      <div className="setup-main">
        <div className="wizard-steps">
          {steps.map((step, index) => (
            <div className={`wizard-step ${STEP_TONE[step.state]}`} key={step.id}>
              <span>
                {step.state === "done" ? <Check size={11} /> : String(index + 1).padStart(2, "0")}
              </span>
              <strong>{step.label}</strong>
              <em className={`step-state ${STEP_TONE[step.state]}`}>{STEP_WORD[step.state]}</em>
            </div>
          ))}
        </div>

        {status.commissioned && (
          <div className="commissioned-banner">
            <CircleCheck size={17} />
            <div>
              <strong>Kurulum tamamlandı.</strong>
              <small>{verifyStep?.detail}</small>
            </div>
          </div>
        )}

        <Panel>
          <PanelHeader
            title="1 · Kolları tanı"
            subtitle="Her yuvaya tek kol; rol koldan okunur"
            action={<button onClick={() => void onDiscover()}>Kolları tara</button>}
          />
          <StepGuidance step={identifyStep} />

          {serial.length === 0 ? (
            <EmptyState
              icon={Usb}
              title="Seri cihaz görünmüyor"
              detail="USB'yi tak, kullanıcının dialout grubunda olduğundan emin ol, sonra yeniden tara."
            />
          ) : (
            <div className="slot-grid">
              {status.slots.map((slot) => {
                const candidates = candidatesFor(slot.role);
                const chosen = picked[slot.role] ?? "";
                const probe = chosen ? identified[chosen] : undefined;
                const suggestedHere = probe?.suggested_role === slot.role;
                return (
                  <div
                    className={`slot-card ${slot.profile_id ? "filled" : "empty"}`}
                    key={slot.role}
                  >
                    <div className="slot-head">
                      <strong>{slot.label}</strong>
                      {slot.profile_id ? (
                        <Tag tone="green">dolu</Tag>
                      ) : (
                        <Tag>boş</Tag>
                      )}
                    </div>

                    {slot.profile_id ? (
                      <>
                        <div className="slot-facts">
                          <div>
                            <small>Seri</small>
                            <strong>{slot.device_serial ?? "—"}</strong>
                          </div>
                          <div>
                            <small>Bağlı</small>
                            <strong>{slot.connected ? "evet" : "hayır"}</strong>
                          </div>
                          <div>
                            <small>LeRobot adı</small>
                            <strong>{slot.lerobot_id}</strong>
                          </div>
                        </div>
                        <span className="slot-port">{slot.port}</span>
                        <div className="button-cluster">
                          <button
                            className="table-action"
                            onClick={() => void onReleaseSlot(slot.role)}
                          >
                            <X size={14} />
                            Yuvayı boşalt
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="card-list">
                          {candidates.map((device) => (
                            <button
                              key={device.id}
                              className={`select-row ${device.id === chosen ? "selected" : ""}`}
                              onClick={() =>
                                setPicked((current) => ({ ...current, [slot.role]: device.id }))
                              }
                            >
                              <Usb size={18} />
                              <div>
                                <strong>{device.serial_number ?? device.name}</strong>
                                <span>{device.stable_path ?? device.transient_path}</span>
                              </div>
                              {identified[device.id] && (
                                <Tag
                                  tone={
                                    identified[device.id].suggested_role === slot.role
                                      ? "green"
                                      : undefined
                                  }
                                >
                                  {identified[device.id].bus_volts ?? "?"} V
                                </Tag>
                              )}
                            </button>
                          ))}
                          {candidates.length === 0 && (
                            <span className="inline-note">
                              Bütün kollar diğer yuvada. Önce oradan boşalt.
                            </span>
                          )}
                        </div>

                        {chosen && (
                          <div className="identify-box">
                            <div className="button-cluster">
                              <button
                                className="secondary-button"
                                onClick={() => void identify(chosen)}
                              >
                                <Radio size={15} />
                                Bu kolu tanı
                              </button>
                              <span className="inline-note">
                                Motorlara soru sorar; hiçbir eklem oynamaz, tork değişmez.
                              </span>
                            </div>
                            {probe && (
                              <>
                                <div className="slot-facts">
                                  <div>
                                    <small>Motor</small>
                                    <strong>
                                      {probe.motors_found}/{probe.motors_expected}
                                    </strong>
                                  </div>
                                  <div>
                                    <small>Bara gerilimi</small>
                                    <strong>{probe.bus_volts ?? "—"} V</strong>
                                  </div>
                                  <div>
                                    <small>Önerilen rol</small>
                                    <strong>{probe.suggested_role}</strong>
                                  </div>
                                </div>
                                <span
                                  className={`inline-note ${suggestedHere ? "" : "warn"}`}
                                >
                                  {suggestedHere ? <Check size={14} /> : <CircleAlert size={14} />}
                                  {probe.reason}
                                </span>
                              </>
                            )}
                          </div>
                        )}

                        {slot.role === "follower" && (
                          <div className="form-grid">
                            <label>
                              Adım başına limit
                              <input
                                type="number"
                                min={1}
                                max={30}
                                value={limit}
                                onChange={(event) => setLimit(Number(event.target.value))}
                              />
                            </label>
                          </div>
                        )}

                        <div className="button-cluster">
                          <button
                            className="primary-button"
                            disabled={!chosen}
                            onClick={() =>
                              void onAssignSlot(
                                slot.role,
                                chosen,
                                slot.role === "follower" ? limit : undefined,
                              )
                            }
                          >
                            <Check size={16} />
                            {slot.label} yuvasına ata
                          </button>
                        </div>
                        {!probe && chosen && (
                          <span className="inline-note">
                            Tanımadan da atayabilirsin, ama rolü doğrulamak için tanıman önerilir.
                          </span>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader
            title="2 · Kalibre et"
            subtitle="Her kol kendi hareket aralığını öğrenir"
          />
          <StepGuidance step={calibrateStep} />

          {calibrateStep?.state === "blocked" ? (
            <EmptyState icon={LockKeyhole} title="Önce iki yuvayı da doldur" />
          ) : (
            <div className="slot-grid">
              {status.slots.map((slot) => {
                const ready = Boolean(slot.profile_id && slot.connected);
                const confirmed = workspace[slot.role] ?? false;
                const blockedReason = !status.physical_enabled
                  ? "Fiziksel adaptörler kapalı. Sunucuyu HASHTAG_ENABLE_PHYSICAL=true ile başlat."
                  : !ready
                    ? "Bu yuva boş ya da kol bağlı değil."
                    : !confirmed
                      ? "Çalışma alanı onayını işaretle."
                      : null;
                return (
                  <div className="slot-card" key={slot.role}>
                    <div className="slot-head">
                      <strong>{slot.label}</strong>
                      {slot.calibration_revision ? (
                        <Tag tone="green">kalibre</Tag>
                      ) : (
                        <Tag>kalibrasyon yok</Tag>
                      )}
                    </div>
                    <div className="slot-facts">
                      <div>
                        <small>Revizyon</small>
                        <strong>{slot.calibration_revision ?? "—"}</strong>
                      </div>
                      <div>
                        <small>Kaynak</small>
                        <strong>{slot.calibration_source ?? "—"}</strong>
                      </div>
                      <div>
                        <small>Motor</small>
                        <strong>{slot.motor_count || "—"}</strong>
                      </div>
                    </div>
                    {slot.calibration_warnings.map((warning) => (
                      <span className="inline-note warn" key={warning}>
                        <CircleAlert size={14} />
                        {warning}
                      </span>
                    ))}
                    <label className="workspace-check">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) =>
                          setWorkspace((current) => ({
                            ...current,
                            [slot.role]: event.target.checked,
                          }))
                        }
                      />
                      <span>
                        <strong>Kol desteklendi, çalışma alanı boş.</strong>
                        <small>Kalibrasyonda tork kapanır; kol serbest kalır.</small>
                      </span>
                    </label>
                    <div className="button-cluster">
                      <button
                        className="primary-button"
                        disabled={Boolean(blockedReason)}
                        onClick={() =>
                          void onCreateJob("calibration", "real", {
                            role: slot.role === "follower" ? "robot" : "teleoperator",
                            ...(slot.role === "follower"
                              ? { robot_profile_id: slot.profile_id }
                              : { teleoperator_profile_id: slot.profile_id }),
                            workspace_confirmed: true,
                          })
                        }
                      >
                        <Wrench size={16} />
                        {slot.label} kalibrasyonunu başlat
                      </button>
                    </div>
                    {blockedReason && (
                      <span className="inline-note warn">
                        <LockKeyhole size={14} />
                        {blockedReason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {lastCalibration && <CalibrationDiff job={lastCalibration} />}
        </Panel>

        <Panel>
          <PanelHeader
            title="3 · Doğrula ve bitir"
            subtitle="Sunucunun kendi kontrolleri"
          />
          <StepGuidance step={verifyStep} />
          {Array.isArray(verifyStep?.evidence?.checks) ? (
            <PreflightChecklist checks={verifyStep.evidence.checks as SafetyCheck[]} />
          ) : (
            <EmptyState icon={ShieldCheck} title="Önceki adımlar tamamlanınca burada belirir" />
          )}
        </Panel>
      </div>

      <div className="setup-side">
        {pendingApproval ? (
          <ApprovalPanel job={pendingApproval} onConfirm={onConfirm} onCancel={onCancel} />
        ) : activeJob ? (
          <LiveJobPanel
            job={activeJob}
            telemetry={telemetry[activeJob.id]}
            onInput={onInput}
            onCancel={onCancel}
          />
        ) : (
          <Panel>
            <PanelHeader title="Canlı adım" subtitle="Onay ve komut çıktısı burada akar" />
            <EmptyState
              icon={Radio}
              title="Aktif fiziksel iş yok"
              detail="Kalibrasyon başlattığında onay kartı ve canlı aralık tablosu burada belirir."
            />
          </Panel>
        )}
      </div>
    </section>
  );
}

/** Every step says what it is, what to do and why it cannot run yet. */
function StepGuidance({ step }: { step: SetupStep | undefined }) {
  if (!step) return null;
  return (
    <div className={`guidance ${STEP_TONE[step.state]}`}>
      <div className="guidance-head">
        <StatusIcon status={step.state === "done" ? "pass" : "warning"} />
        <strong>{step.summary}</strong>
        <em className={`step-state ${STEP_TONE[step.state]}`}>{STEP_WORD[step.state]}</em>
      </div>
      {step.detail && <p>{step.detail}</p>}
      {step.blockers.length > 0 && (
        <ul className="guidance-blockers">
          {step.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A collapsed range is only obvious next to what it used to be. */
function CalibrationDiff({ job }: { job: Job }) {
  const rows = job.result?.calibration_comparison as
    | Array<{
        motor: string;
        span: number | null;
        previous_span: number | null;
        change_percent: number | null;
        suspicious: boolean;
      }>
    | undefined;
  if (!rows?.length) return null;
  return (
    <div className="span-table">
      <div className="span-row head">
        <span>Eklem</span>
        <span>Aralık</span>
        <span>Önceki</span>
        <span>Değişim</span>
      </div>
      {rows.map((row) => (
        <div className={`span-row ${row.suspicious ? "suspicious" : ""}`} key={row.motor}>
          <span>{row.motor}</span>
          <span>{row.span ?? "—"}</span>
          <span>{row.previous_span ?? "—"}</span>
          <span>
            {row.change_percent === null ? "—" : `${row.change_percent > 0 ? "+" : ""}${row.change_percent}%`}
            {row.suspicious && " · süpürülmemiş olabilir"}
          </span>
        </div>
      ))}
    </div>
  );
}

function Lab({
  devices,
  robots,
  cameras,
  doctor,
  onDiscover,
  onDiscoverCameras,
  onSaveCamera,
  onSaveRobot,
  onCreateJob,
}: {
  devices: Device[];
  robots: Robot[];
  cameras: CameraProfile[];
  doctor: DoctorReport | null;
  onDiscover: () => Promise<unknown>;
  onDiscoverCameras: () => Promise<unknown>;
  onSaveCamera: (profile: Partial<CameraProfile>) => Promise<CameraProfile | null>;
  onSaveRobot: (profile: Partial<Robot>) => Promise<Robot | null>;
  onCreateJob: CreateJob;
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

      <CameraStudio
        cameras={cameras}
        devices={devices}
        robots={robots}
        onDiscoverCameras={onDiscoverCameras}
        onSaveCamera={onSaveCamera}
        onSaveRobot={onSaveRobot}
        onCreateJob={onCreateJob}
      />

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
    </>
  );
}

const SEMANTIC_KEYS = ["front", "wrist", "top", "side"];
const RESOLUTIONS = [
  { label: "640×480", width: 640, height: 480 },
  { label: "1280×720", width: 1280, height: 720 },
  { label: "1920×1080", width: 1920, height: 1080 },
];

function CameraStudio({
  cameras,
  devices,
  robots,
  onDiscoverCameras,
  onSaveCamera,
  onSaveRobot,
  onCreateJob,
}: {
  cameras: CameraProfile[];
  devices: Device[];
  robots: Robot[];
  onDiscoverCameras: () => Promise<unknown>;
  onSaveCamera: (profile: Partial<CameraProfile>) => Promise<CameraProfile | null>;
  onSaveRobot: (profile: Partial<Robot>) => Promise<Robot | null>;
  onCreateJob: CreateJob;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [semantic, setSemantic] = useState("front");
  const [resolution, setResolution] = useState(0);
  const [robotId, setRobotId] = useState("");

  const connected = useMemo(
    () => devices.filter((item) => item.kind === "camera" && !item.is_simulated),
    [devices],
  );
  const robot = robots.find((item) => item.id === robotId) ?? robots[0];

  useEffect(() => {
    if (!robots.some((item) => item.id === robotId)) setRobotId(robots[0]?.id ?? "");
  }, [robots, robotId]);

  const profileFor = (fingerprint: string) =>
    cameras.find((item) => item.device_fingerprint === fingerprint) ?? null;

  const mapTo = (key: string, cameraId: string) => {
    if (!robot) return;
    const mapping = { ...robot.camera_mapping };
    if (cameraId) mapping[key] = cameraId;
    else delete mapping[key];
    void onSaveRobot({ ...robot, camera_mapping: mapping });
  };

  return (
    <section className="two-column">
      <Panel>
        <PanelHeader
          title="Kameralar"
          subtitle="Kararlı /dev/v4l/by-id kimliği · index değil"
          action={<button onClick={() => void onDiscoverCameras()}>Kameraları tara</button>}
        />
        {connected.length === 0 ? (
          <EmptyState
            icon={Camera}
            title="Bağlı kamera görünmüyor"
            detail="USB kamerayı tak ve yeniden tara; /dev/v4l/by-id altındaki capture düğümü aranır."
          />
        ) : (
          <div className="card-list">
            {connected.map((device) => {
              const profile = profileFor(device.stable_fingerprint);
              return (
                <div className="camera-card" key={device.id}>
                  <div className="camera-card-head">
                    <Camera size={17} />
                    <div>
                      <strong>{profile?.name ?? device.name}</strong>
                      <span>{device.stable_path ?? device.transient_path}</span>
                    </div>
                    {profile ? (
                      <Tag tone="green">{profile.semantic_name}</Tag>
                    ) : (
                      <Tag>profilsiz</Tag>
                    )}
                  </div>

                  {profile ? (
                    <>
                      <div className="camera-facts">
                        <span>
                          {profile.width}×{profile.height} · {profile.fps} FPS
                        </span>
                        <span>
                          {profile.latency_baseline_ms != null
                            ? `p50 ${profile.latency_baseline_ms} ms`
                            : "henüz ölçülmedi"}
                        </span>
                      </div>
                      {previewId === profile.id && (
                        <img
                          className="camera-stream"
                          src={`/api/cameras/${profile.id}/preview.mjpg`}
                          alt={`${profile.name} canlı görüntü`}
                        />
                      )}
                      <div className="button-cluster">
                        <button
                          className="secondary-button"
                          onClick={() =>
                            setPreviewId(previewId === profile.id ? null : profile.id)
                          }
                        >
                          <Camera size={15} />
                          {previewId === profile.id ? "Önizlemeyi kapat" : "Canlı önizleme"}
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() =>
                            void onCreateJob("camera_preview", "sim", {
                              camera_id: profile.id,
                              samples: 30,
                            })
                          }
                        >
                          <Gauge size={15} />
                          FPS ve gecikme ölç
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="camera-form">
                      <label>
                        Semantik ad
                        <select
                          value={semantic}
                          onChange={(event) => setSemantic(event.target.value)}
                        >
                          {SEMANTIC_KEYS.map((key) => (
                            <option key={key} value={key}>
                              {key}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Çözünürlük
                        <select
                          value={resolution}
                          onChange={(event) => setResolution(Number(event.target.value))}
                        >
                          {RESOLUTIONS.map((item, index) => (
                            <option key={item.label} value={index}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="primary-button"
                        onClick={() =>
                          void onSaveCamera({
                            name: `${semantic} · ${device.name}`,
                            device_fingerprint: device.stable_fingerprint,
                            semantic_name: semantic,
                            width: RESOLUTIONS[resolution].width,
                            height: RESOLUTIONS[resolution].height,
                            fps: 30,
                          })
                        }
                      >
                        Profil oluştur
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <span className="inline-note">
          <LockKeyhole size={14} />
          Bir kamera aynı anda tek tüketiciye açılır; önizleme kaydı bloke eder.
        </span>
      </Panel>

      <Panel>
        <PanelHeader
          title="Robot kamera eşlemesi"
          subtitle="Semantik anahtar → dataset feature adı"
        />
        {robots.length === 0 ? (
          <EmptyState icon={Router} title="Önce bir robot profili oluştur" />
        ) : (
          <>
            <div className="form-grid">
              <label className="form-span">
                Robot profili
                <select value={robotId} onChange={(event) => setRobotId(event.target.value)}>
                  {robots.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mapping-list">
              {SEMANTIC_KEYS.map((key) => {
                const mapped = robot?.camera_mapping[key] ?? "";
                return (
                  <div className="mapping-row" key={key}>
                    <code>observation.images.{key}</code>
                    <select value={mapped} onChange={(event) => mapTo(key, event.target.value)}>
                      <option value="">eşlenmedi</option>
                      {cameras.map((camera) => (
                        <option key={camera.id} value={camera.id}>
                          {camera.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
            <span className="inline-note">
              <ShieldCheck size={14} />
              Eşlenen kameralar preflight'ta canlı cihaza çözülür ve komuta yazılır.
            </span>
          </>
        )}
      </Panel>
    </section>
  );
}

type CreateJob = (
  kind: string,
  mode: TargetMode,
  parameters?: Record<string, unknown>,
  resources?: Array<Record<string, string>>,
) => Promise<Job | null>;

function usePreview(request: Record<string, unknown> | null): CommandPreview | null {
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const key = request ? JSON.stringify(request) : "";
  useEffect(() => {
    if (!key) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api
        .post<CommandPreview>("/hardware/command-preview", JSON.parse(key) as unknown)
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key]);
  return preview;
}

function PreflightChecklist({ checks }: { checks: SafetyCheck[] }) {
  const weight: Record<string, number> = { blocked: 0, warning: 1, pass: 2, not_applicable: 3 };
  const ordered = [...checks].sort((a, b) => weight[a.status] - weight[b.status]);
  return (
    <div className="preflight-checks">
      {ordered.map((check) => (
        <div className={`preflight-check status-${check.status}`} key={check.code}>
          <StatusIcon status={check.status} />
          <div>
            <strong>{check.label}</strong>
            <span>{check.message}</span>
          </div>
          <code>{check.code}</code>
        </div>
      ))}
    </div>
  );
}

function CommandPreviewBlock({ preview }: { preview: CommandPreview | null }) {
  if (!preview) {
    return (
      <div className="command-preview empty">
        <TerminalSquare size={15} />
        <span>Hedefler çözülünce sunucunun kuracağı komut burada görünür.</span>
      </div>
    );
  }
  return (
    <div className="command-preview">
      <div className="command-preview-head">
        <TerminalSquare size={15} />
        <strong>Sunucunun çalıştıracağı komut</strong>
        <Tag tone={preview.execution_allowed ? "green" : "neutral"}>
          {preview.execution_allowed ? "çalıştırılabilir" : "kilitli"}
        </Tag>
      </div>
      <code className="command-line">
        <b>{preview.executable}</b>
        {preview.arguments.map((argument, index) => (
          <span key={`${argument}-${index}`}>{argument}</span>
        ))}
      </code>
      <small>
        {preview.description} · shell yok · {preview.interactive ? "etkileşimli (PTY)" : "sessiz"}
      </small>
    </div>
  );
}

function estimateSeconds(job: Job): number | null {
  const parameters = job.parameters as Record<string, unknown>;
  const read = (key: string, fallback?: number) => {
    const value = parameters[key];
    return value === undefined ? fallback : Number(value);
  };
  if (job.kind === "teleoperation") return read("teleop_time_s") ?? null;
  if (job.kind === "recording") {
    const episodes = read("episodes", 1) ?? 1;
    return episodes * ((read("episode_time_s", 30) ?? 30) + (read("reset_time_s", 15) ?? 15));
  }
  return read("duration") ?? null;
}

const RISK_SUMMARY: Record<string, string> = {
  motor_setup: "Motorlar tek tek enerjilenir. Kol elle desteklenmeli, altında engel olmamalı.",
  calibration: "Tork kapalıdır; kolu elle bütün eklem aralığında gezdireceksin.",
  teleoperation: "Follower leader'ı canlı takip eder. Ani leader hareketi ani follower hareketidir.",
  recording: "Teleop hareketi + kamera ve disk yazımı. Bölüm sonuna kadar kol enerjilidir.",
  replay: "Kayıtlı eylemler insan müdahalesi olmadan tekrar oynatılır.",
  evaluation: "Policy komutları doğrudan motorlara uygulanır.",
  policy_rollout: "Policy komutları doğrudan motorlara uygulanır.",
};

function ApprovalPanel({
  job,
  onConfirm,
  onCancel,
}: {
  job: Job;
  onConfirm: (jobId: string, approvalId: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
}) {
  const preview = usePreview({
    kind: job.kind,
    target_mode: job.target_mode,
    parameters: job.parameters,
    resources: job.resources,
    requested_by: "dashboard",
  });
  const targets = job.resolved_targets ?? null;
  const seconds = estimateSeconds(job);
  const cameras = Object.keys(targets?.camera_profile_ids ?? {});
  const policyPath = job.parameters.policy_path ?? job.parameters.policy_id;

  return (
    <Panel className="approval-panel">
      <div className="approval-head">
        <ShieldCheck size={18} />
        <div>
          <strong>Fiziksel hareket onayı bekliyor</strong>
          <span>
            Bu kart backend'in çözdüğü hedefleri gösterir; onay tek kullanımlık ve süreli bir
            token'a bağlanır.
          </span>
        </div>
        <StatusBadge value={job.kind} />
      </div>

      <dl className="approval-facts">
        <ApprovalFact
          label="Follower"
          value={targets?.robot_id ?? "çözülmedi"}
          detail={targets?.robot_port ?? undefined}
        />
        <ApprovalFact
          label={job.kind === "policy_rollout" || job.kind === "evaluation" ? "Policy" : "Leader"}
          value={
            job.kind === "policy_rollout" || job.kind === "evaluation"
              ? String(policyPath ?? "çözülmedi")
              : (targets?.teleop_id ?? "yok")
          }
          detail={targets?.teleop_port ?? undefined}
        />
        <ApprovalFact
          label="Calibration revision"
          value={targets?.robot_calibration_revision ?? "yeni oluşturulacak"}
          detail={targets?.teleop_calibration_revision ?? undefined}
        />
        <ApprovalFact
          label="Kameralar"
          value={cameras.length ? cameras.join(", ") : "kamerasız akış"}
        />
        <ApprovalFact
          label="Control frequency"
          value={job.parameters.fps ? `${String(job.parameters.fps)} Hz` : "komut varsayılanı"}
        />
        <ApprovalFact
          label="Limit profili"
          value={
            targets?.max_relative_target != null
              ? `adım başına ${targets.max_relative_target}`
              : "limitsiz komut"
          }
          detail={targets?.action_shape?.length ? `action ${targets.action_shape[0]}` : undefined}
        />
        <ApprovalFact
          label="Tahmini süre"
          value={seconds ? `~${Math.round(seconds)} sn` : "operatör bitirene kadar"}
        />
        <ApprovalFact
          label="Fiziksel risk"
          value={RISK_SUMMARY[job.kind] ?? "Fiziksel aktüasyon içerir."}
          wide
        />
        <ApprovalFact
          label="Stop yöntemi"
          value="E-STOP süreç grubunu öldürür · 'Durdur' güvenli durdurur · mandal açılana kadar yeni iş başlamaz"
          wide
        />
      </dl>

      <CommandPreviewBlock preview={preview} />

      <div className="button-cluster">
        <button
          className="primary-button"
          disabled={!job.approval_id}
          onClick={() => job.approval_id && void onConfirm(job.id, job.approval_id)}
        >
          <Check size={17} />
          Onayla ve başlat
        </button>
        <button className="secondary-button" onClick={() => void onCancel(job.id)}>
          <X size={17} />
          Vazgeç
        </button>
      </div>
    </Panel>
  );
}

function ApprovalFact({
  label,
  value,
  detail,
  wide = false,
}: {
  label: string;
  value: string;
  detail?: string;
  wide?: boolean;
}) {
  return (
    <div className={`approval-fact ${wide ? "wide" : ""}`}>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </dd>
    </div>
  );
}

function LiveJobPanel({
  job,
  telemetry,
  onInput,
  onCancel,
  onEmergencyStop,
}: {
  job: Job;
  telemetry?: TelemetrySummary;
  onInput: (jobId: string, key: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
  onEmergencyStop?: () => Promise<unknown>;
}) {
  const running = job.state === "running";
  const keys = OPERATOR_KEYS[job.kind] ?? [];
  const expects = telemetry?.prompt?.expects ?? null;
  const ranges = Object.entries(telemetry?.ranges ?? {});
  const joints = Object.entries(telemetry?.joints ?? {});

  return (
    <Panel className="live-panel">
      <div className="live-head">
        <span className={`live-dot state-${job.state}`} />
        <div>
          <strong>{job.kind.replaceAll("_", " ")}</strong>
          <span>{job.message}</span>
        </div>
        <StatusBadge value={job.state} />
      </div>
      <div className="live-progress">
        <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>

      {telemetry?.prompt?.prompt && (
        <div className="operator-prompt">
          <Radio size={15} />
          <div>
            <strong>Komut bir tuş bekliyor</strong>
            <span>{telemetry.prompt.prompt}</span>
          </div>
          {expects && <Tag tone="blue">{expects}</Tag>}
        </div>
      )}

      {ranges.length > 0 && (
        <div className="calibration-table">
          <div className="calibration-row head">
            <span>Eklem</span>
            <span>MIN</span>
            <span>POS</span>
            <span>MAX</span>
            <span>Aralık</span>
          </div>
          {ranges.map(([name, value]) => {
            const span = Math.max(1, value.max - value.min);
            const ratio = Math.min(100, Math.max(0, ((value.pos - value.min) / span) * 100));
            return (
              <div className="calibration-row" key={name}>
                <span>{name}</span>
                <span>{value.min}</span>
                <strong>{value.pos}</strong>
                <span>{value.max}</span>
                <span className="range-track">
                  <i style={{ left: `${ratio}%` }} />
                </span>
              </div>
            );
          })}
        </div>
      )}

      {joints.length > 0 && (
        <div className="joint-list">
          {joints.map(([name, value]) => (
            <div className="joint-row" key={name}>
              <span>{name}</span>
              <span className="joint-track">
                <i
                  style={{
                    left: `${Math.min(100, Math.max(0, (value + 100) / 2))}%`,
                  }}
                />
              </span>
              <strong>{value.toFixed(1)}</strong>
            </div>
          ))}
        </div>
      )}

      <div className="telemetry-metrics compact">
        <Telemetry
          label="p50 loop"
          value={telemetry?.p50_loop_ms ? `${telemetry.p50_loop_ms} ms` : "—"}
        />
        <Telemetry
          label="p95 loop"
          value={telemetry?.p95_loop_ms ? `${telemetry.p95_loop_ms} ms` : "—"}
        />
        <Telemetry label="Örnek" value={String(telemetry?.samples ?? 0)} />
        <Telemetry
          label="Bölüm"
          value={
            telemetry?.episode?.episode != null ? String(telemetry.episode.episode) : "—"
          }
          good={telemetry?.episode?.phase === "recording"}
        />
      </div>

      <div className="button-cluster">
        {keys.map((entry) => (
          <button
            key={entry.key}
            className={expects === entry.key ? "primary-button" : "secondary-button"}
            disabled={!running}
            onClick={() => void onInput(job.id, entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className="button-cluster">
        <button className="secondary-button" onClick={() => void onCancel(job.id)}>
          <Square size={15} />
          Güvenli durdur
        </button>
        {onEmergencyStop && (
          <button className="estop large" onClick={() => void onEmergencyStop()}>
            <Octagon size={18} fill="currentColor" />
            ACİL DURDUR
          </button>
        )}
      </div>
    </Panel>
  );
}

function Operate({
  robots,
  teleoperators,
  cameras,
  jobs,
  telemetry,
  safety,
  onCreateJob,
  onConfirm,
  onInput,
  onCancel,
  onEmergencyStop,
}: {
  robots: Robot[];
  teleoperators: Teleoperator[];
  cameras: CameraProfile[];
  jobs: Job[];
  telemetry: Record<string, TelemetrySummary>;
  safety: SafetyStatus | null;
  onCreateJob: CreateJob;
  onConfirm: (jobId: string, approvalId: string) => Promise<unknown>;
  onInput: (jobId: string, key: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
  onEmergencyStop: () => Promise<unknown>;
}) {
  const [mode, setMode] = useState<TargetMode>("sim");
  // Operate drives; it no longer records. Recording moved to its own page
  // because having two doors to one job is what made this hard to follow.
  const flow = "teleoperation" as const;
  const [robotId, setRobotId] = useState("");
  const [leaderId, setLeaderId] = useState("");
  const [task, setTask] = useState("Pick the object and place it in the target area");
  const [fps, setFps] = useState(30);
  const [teleopSeconds, setTeleopSeconds] = useState(20);
  const [workspaceConfirmed, setWorkspaceConfirmed] = useState(false);

  const real = mode === "real";

  /**
   * The job kind the two switches actually mean.
   *
   * They used to mean less than they said: mode='sim' with flow='recording'
   * posted a `recording` job with target_mode='sim', which never reaches a
   * command at all -- it walked five cosmetic progress strings and reported
   * success having written nothing. A button that says "start sim recording"
   * and produces no dataset is worse than no button.
   *
   * Simulation is a target here, not a different page. The same form starts
   * either; only where the follower lives changes.
   */
  const jobKind = real ? "teleoperation" : "sim_teleoperation";
  const physicalLocked = !(safety?.physical_enabled ?? false);
  const followers = useMemo(
    () => robots.filter((item) => (real ? item.target_mode !== "sim" : item.target_mode === "sim")),
    [robots, real],
  );
  const leaders = useMemo(
    () =>
      teleoperators.filter((item) =>
        real ? item.target_mode !== "sim" : item.target_mode === "sim",
      ),
    [teleoperators, real],
  );

  useEffect(() => {
    if (!followers.some((item) => item.id === robotId)) setRobotId(followers[0]?.id ?? "");
  }, [followers, robotId]);
  useEffect(() => {
    if (!leaders.some((item) => item.id === leaderId)) setLeaderId(leaders[0]?.id ?? "");
  }, [leaders, leaderId]);
  useEffect(() => setWorkspaceConfirmed(false), [mode, robotId]);

  const parameters = useMemo(() => {
    const base: Record<string, unknown> = {
      robot_profile_id: robotId,
      teleoperator_profile_id: leaderId,
      fps,
    };
    if (real) base.workspace_confirmed = workspaceConfirmed;
    return { ...base, teleop_time_s: teleopSeconds };
  }, [robotId, leaderId, fps, real, workspaceConfirmed, teleopSeconds]);

  const preview = usePreview(
    real && robotId
      ? {
          kind: jobKind,
          target_mode: mode,
          parameters,
          resources: [],
          requested_by: "dashboard",
        }
      : null,
  );

  const pendingApproval = pendingApprovalFor(jobs, OPERATE_JOB_KINDS);
  const activeJob = activeJobFor(jobs, OPERATE_JOB_KINDS);
  const blockedByPreflight = Boolean(preview && !preview.preflight.allowed);

  return (
    <section className="operate-layout">
      <Panel className="control-panel">
        <PanelHeader title="Session builder" subtitle="Hedefi seç; portu ve limiti sunucu çözer" />
        <div className="mode-switch">
          <button className={mode === "sim" ? "active" : ""} onClick={() => setMode("sim")}>
            <FlaskConical size={15} />
            Simülasyon
          </button>
          <button
            className={real ? "active danger" : ""}
            disabled={physicalLocked}
            title={physicalLocked ? "Fiziksel adaptörler kapalı (HASHTAG_ENABLE_PHYSICAL)" : ""}
            onClick={() => setMode("real")}
          >
            <Radio size={15} />
            Gerçek robot
          </button>
        </div>

        <p className="scenario-note">
          Burası kolu <strong>sürdüğün</strong> yer. Gösterim kaydetmek için{" "}
          <strong>Veri Topla</strong>'ya geç — aynı kol, aynı leader, sadece çıktısı bir
          veri seti olan hâli.
        </p>

        <div className="form-grid">
          <label>
            Follower profili
            <select value={robotId} onChange={(event) => setRobotId(event.target.value)}>
              {followers.length === 0 && <option value="">profil yok</option>}
              {followers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.calibration_id ?? "adsız"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Leader profili
            <select value={leaderId} onChange={(event) => setLeaderId(event.target.value)}>
              {leaders.length === 0 && <option value="">profil yok</option>}
              {leaders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.calibration_id ?? "adsız"}
                </option>
              ))}
            </select>
          </label>
          <label>
            Control frequency
            <input
              type="number"
              min={5}
              max={120}
              value={fps}
              onChange={(event) => setFps(Number(event.target.value))}
            />
          </label>
          <label>
            Teleop süresi (sn)
            <input
              type="number"
              min={1}
              max={600}
              value={teleopSeconds}
              onChange={(event) => setTeleopSeconds(Number(event.target.value))}
            />
          </label>
        </div>

        {real ? (
          <>
            <label className="workspace-check">
              <input
                type="checkbox"
                checked={workspaceConfirmed}
                onChange={(event) => setWorkspaceConfirmed(event.target.checked)}
              />
              <span>
                <strong>Çalışma alanı temiz ve kol serbest.</strong>
                <small>Sunucunun kabul ettiği tek operatör beyanı budur.</small>
              </span>
            </label>
            <CommandPreviewBlock preview={preview} />
            {preview && <PreflightChecklist checks={preview.preflight.checks} />}
          </>
        ) : (
          <div className="preflight-card">
            <div className="preflight-title">
              <ShieldCheck size={18} />
              <strong>Simülasyon modu</strong>
              <StatusBadge value="sim" />
            </div>
            <div className="preflight-grid">
              <Verification label="LeRobot komutu" value={false} neutral />
              <Verification label="Fiziksel tork" value={false} neutral />
              <Verification label="Kamera profili" value={cameras.length > 0} />
            </div>
          </div>
        )}

        <div className="button-cluster">
          <button
            className="primary-button"
            disabled={!robotId || (real && (!workspaceConfirmed || blockedByPreflight))}
            onClick={() => void onCreateJob(jobKind, mode, parameters)}
          >
            <Radio size={17} />
            {real ? "Gerçek kolda" : "Simülasyonda"} teleop başlat
          </button>
          {blockedByPreflight && (
            <span className="inline-note">
              <LockKeyhole size={14} />
              Yukarıdaki kırmızı kontroller geçene kadar başlatılamaz.
            </span>
          )}
        </div>
      </Panel>

      {pendingApproval ? (
        <ApprovalPanel job={pendingApproval} onConfirm={onConfirm} onCancel={onCancel} />
      ) : activeJob ? (
        <LiveJobPanel
          job={activeJob}
          telemetry={telemetry[activeJob.id]}
          onInput={onInput}
          onCancel={onCancel}
          onEmergencyStop={onEmergencyStop}
        />
      ) : (
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
              AKTİF İŞ YOK
            </div>
          </div>
          <div className="telemetry-metrics">
            <Telemetry label="Follower profili" value={String(followers.length)} />
            <Telemetry label="Leader profili" value={String(teleoperators.length)} />
            <Telemetry label="Kamera" value={String(cameras.length)} />
            <Telemetry
              label="Fiziksel kapı"
              value={physicalLocked ? "kilitli" : "açık"}
              good={!physicalLocked}
            />
          </div>
        </Panel>
      )}
    </section>
  );
}

function DataStudio({
  datasets,
  jobs,
  telemetry,
  onCreateJob,
  onSaveDataset,
  onInput,
  onCancel,
  onRefresh,
}: {
  datasets: Dataset[];
  jobs: Job[];
  telemetry: Record<string, TelemetrySummary>;
  onCreateJob: CreateJob;
  onSaveDataset: (dataset: Partial<Dataset>) => Promise<Dataset | null>;
  onInput: (jobId: string, key: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
}) {
  const [task, setTask] = useState("Move the foam cube into the bowl");
  const [repoId, setRepoId] = useState("");
  const [name, setName] = useState("SO-101 dataset");
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<DatasetComparison | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<DatasetEpisodes | null>(null);
  const [dropping, setDropping] = useState<number[]>([]);

  const openEpisodes = (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setEpisodes(null);
    setDropping([]);
    void api
      .get<DatasetEpisodes>(`/datasets/${id}/episodes`)
      .then(setEpisodes)
      .catch(() => setEpisodes({ dataset_id: id, episodes: [], readable: false, note: "" }));
  };

  const dropEpisodes = (dataset: Dataset) => {
    if (dropping.length === 0) return;
    const question =
      `${dropping.length} bölüm çıkarılacak. Bu kayıt DEĞİŞMEZ — ` +
      `kırpılmış bir kopya oluşturulur. Devam?`;
    if (!window.confirm(question)) return;
    setBusyId(dataset.id);
    void api
      .post<Job>(`/datasets/${dataset.id}/episodes/remove`, { episodes: dropping })
      .then(() => {
        setOpenId(null);
        setDropping([]);
      })
      .finally(() => {
        setBusyId(null);
        void onRefresh();
      });
  };

  const recording = jobs.find(
    (job) =>
      (job.kind === "recording" || job.kind === "sim_recording") &&
      ACTIVE_STATES.includes(job.state),
  );
  const transform = jobs.find(
    (job) => job.kind === "dataset_transform" && ACTIVE_STATES.includes(job.state),
  );
  // The last transform that finished, so a refusal is read rather than guessed at.
  const lastTransform = jobs.find(
    (job) => job.kind === "dataset_transform" && Boolean(job.result?.artifact_error),
  );
  const verified = datasets.filter((item) => item.integrity_status === "verified");
  const simulated = datasets.filter(
    (item) => (item.provenance as Record<string, unknown> | undefined)?.source === "simulation",
  );
  const unknownSource = datasets.filter(
    (item) => !(item.provenance as Record<string, unknown> | undefined)?.source,
  );

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const compare = () => {
    setComparison(null);
    void api
      .post<DatasetComparison>("/datasets/compare", { dataset_ids: selected })
      .then(setComparison)
      .catch((error: Error) =>
        setComparison({
          status: "incompatible",
          summary: error.message,
          datasets: [],
          blockers: [],
          warnings: [],
          profiles: [],
        }),
      );
  };

  const revalidate = (id: string) => {
    setBusyId(id);
    void api
      .post<Dataset>(`/datasets/${id}/revalidate`)
      .finally(() => {
        setBusyId(null);
        void onRefresh();
      });
  };

  /**
   * Co-training needs one dataset, not two.
   *
   * LeRobot 0.6 will not train on more than one -- `make_dataset` raises "The
   * MultiLeRobotDataset isn't supported for now" -- so mixing simulated and real
   * demonstrations means merging them on disk first. The server refuses with a
   * reason if they cannot be merged, which is the same check the compare button
   * runs.
   */
  /**
   * Send a recording to the Hub, which is how it reaches a machine that trains.
   *
   * Two steps on purpose. The dry run costs nothing and answers the question
   * the operator actually has -- how much is this, and where is it going --
   * before an upload measured in hundreds of megabytes starts over whatever
   * this board is connected to. The upload itself then waits for a
   * confirmation card, because it cannot be taken back and a recording carries
   * video of the room it was made in.
   */
  const publish = (dataset: Dataset) => {
    const target = window.prompt(
      "Hub deposu (kullanıcı/ad):",
      dataset.repo_id ?? "",
    );
    if (!target) return;
    setBusyId(dataset.id);
    void api
      .post<Job>(`/datasets/${dataset.id}/publish`, {
        repo_id: target,
        private: true,
        dry_run: true,
      })
      .catch((error: Error) =>
        setComparison({
          status: "incompatible",
          summary: error.message,
          datasets: [],
          blockers: [],
          warnings: [],
          profiles: [],
        }),
      )
      .finally(() => {
        setBusyId(null);
        void onRefresh();
      });
  };

  const merge = () => {
    const suggestion = `mertkirgil/birlesik_${selected.length}`;
    const name = window.prompt("Birleşik veri setinin adı:", suggestion);
    if (!name) return;
    setBusyId("merge");
    setComparison(null);
    void api
      // A job, not a result: merging eighty episodes re-encodes video and takes
      // minutes. It shows up in the panel below with progress and a stop button.
      .post<Job>("/datasets/merge", { dataset_ids: selected, new_name: name })
      .then(() => setSelected([]))
      .catch((error: Error) =>
        setComparison({
          status: "incompatible",
          summary: error.message,
          datasets: [],
          blockers: [],
          warnings: [],
          profiles: [],
        }),
      )
      .finally(() => {
        setBusyId(null);
        void onRefresh();
      });
  };

  const forget = (dataset: Dataset, deleteFiles: boolean) => {
    const question = deleteFiles
      ? `'${dataset.name}' diskten SİLİNSİN mi? Bu geri alınamaz.`
      : `'${dataset.name}' listeden çıkarılsın mı? Kayıt diskte kalır.`;
    if (!window.confirm(question)) return;
    setBusyId(dataset.id);
    void api
      .del(`/datasets/${dataset.id}${deleteFiles ? "?delete_files=true" : ""}`)
      .finally(() => {
        setBusyId(null);
        setSelected((current) => current.filter((item) => item !== dataset.id));
        void onRefresh();
      });
  };

  return (
    <>
      {recording && (
        <LiveJobPanel
          job={recording}
          telemetry={telemetry[recording.id]}
          onInput={onInput}
          onCancel={onCancel}
        />
      )}

      {transform && (
        <Panel>
          <PanelHeader
            title={
              transform.parameters.operation === "merge"
                ? "Veri setleri birleştiriliyor"
                : "Bölümler çıkarılıyor"
            }
            subtitle={transform.message}
            action={
              <button className="danger-button" onClick={() => void onCancel(transform.id)}>
                <Square size={15} />
                Durdur
              </button>
            }
          />
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${transform.progress * 100}%` }} />
          </div>
          <p className="scenario-note">
            Video yeniden kodlanıyor olabilir; bu sırada kaynaklar olduğu gibi duruyor.
          </p>
        </Panel>
      )}

      {!transform && lastTransform?.result?.artifact_error != null && (
        <Panel>
          <PanelHeader title="Son işlem yapılamadı" subtitle="" />
          <div className="check-row">
            <StatusIcon status="blocked" />
            <div>
              <strong>{String(lastTransform.result.artifact_error)}</strong>
              <span>Karşılaştırma düğmesi hangi alanların ayrıştığını gösterir.</span>
            </div>
          </div>
        </Panel>
      )}

      <section className="two-column">
        <Panel>
          <PanelHeader
            title="Diskteki kaydı listeye al"
            subtitle="Kayıt Operate ve Simulation'da alınır; burada var olanı okutursun"
          />
          <div className="form-grid">
            <label className="form-span">
              LeRobot repo id
              <input
                value={repoId}
                onChange={(event) => setRepoId(event.target.value)}
                placeholder="mertkirgil/so101_kalemi_al"
              />
            </label>
            <label>
              Görünen ad
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              Görev
              <input value={task} onChange={(event) => setTask(event.target.value)} />
            </label>
          </div>
          <button
            className="primary-button full-button"
            disabled={!repoId.trim()}
            onClick={() =>
              void onSaveDataset({ name, task, repo_id: repoId.trim() }).then(
                (dataset) => dataset && revalidate(dataset.id),
              )
            }
          >
            <Play size={17} />
            Ekle ve doğrula
          </button>
          <span className="inline-note">
            <ShieldCheck size={14} />
            Bölüm ve kare sayıları meta/info.json'dan okunur, girilmez.
          </span>
        </Panel>

        <Panel>
          <PanelHeader title="Elimizde ne var" subtitle="Diskten ölçülen" />
          <div className="large-stat">
            <strong>{verified.reduce((total, item) => total + item.episodes, 0)}</strong>
            <span>doğrulanmış bölüm</span>
          </div>
          <div className="fact-row">
            <div>
              <small>Doğrulanmış</small>
              <strong>
                {verified.length} / {datasets.length}
              </strong>
            </div>
            <div>
              <small>Toplam kare</small>
              <strong>{verified.reduce((total, item) => total + item.total_frames, 0)}</strong>
            </div>
            <div>
              <small>Simülasyondan</small>
              <strong>
                {simulated.length} / {datasets.length - unknownSource.length}
              </strong>
            </div>
          </div>
          <p className="scenario-note">
            Sim ve gerçek kayıtlar aynı şemada yazılır, ama bu onların birlikte eğitilebileceğini
            <strong> kanıtlamaz</strong>. İki veya daha fazlasını seçip karşılaştır.
          </p>
        </Panel>
      </section>

      <Panel>
        <PanelHeader
          title="Veri setleri"
          subtitle={`${datasets.length} kayıt · ${selected.length} seçili`}
          action={
            <div className="button-cluster">
              <button
                className="secondary-button"
                disabled={selected.length < 2}
                onClick={compare}
              >
                <ListChecks size={15} />
                Birlikte eğitilebilir mi?
              </button>
              <button
                className="primary-button"
                disabled={selected.length < 2 || busyId !== null}
                onClick={merge}
              >
                <Database size={15} />
                Birleştir
              </button>
            </div>
          }
        />
        {datasets.length === 0 ? (
          <EmptyState
            icon={Database}
            title="Henüz kayıt yok"
            detail="Operate'te gerçek kolla, Simulation'da leader ile kayıt al."
          />
        ) : (
          <div className="dataset-list">
            {datasets.map((dataset) => {
              const provenance = (dataset.provenance ?? {}) as Record<string, unknown>;
              // See PROVENANCE: four states, because a recording made before
              // the source was written down says nothing about where it came
              // from, and a merge of simulated and real takes is neither.
              const source = provenance.source as string | undefined;
              return (
                <div className="dataset-row" key={dataset.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(dataset.id)}
                    onChange={() => toggle(dataset.id)}
                    aria-label={`${dataset.name} seç`}
                  />
                  <div className="dataset-main">
                    <div className="dataset-title">
                      <strong>{dataset.name}</strong>
                      <Tag tone={PROVENANCE[source ?? ""]?.tone ?? "neutral"}>
                        {PROVENANCE[source ?? ""]?.label ?? "kaynağı kayıtlı değil"}
                      </Tag>
                      <StatusBadge value={dataset.integrity_status} />
                    </div>
                    <span className="mono-copy">{dataset.repo_id ?? "repo id yok"}</span>
                    <span>{dataset.task}</span>
                    <div className="dataset-facts">
                      <span>{dataset.episodes} bölüm</span>
                      <span>{dataset.total_frames} kare</span>
                      <span>{dataset.fps} FPS</span>
                      <span>{Object.keys(dataset.camera_mapping ?? {}).length} kamera</span>
                      {dataset.calibration_revision && (
                        <span>kalibrasyon {dataset.calibration_revision.slice(0, 12)}</span>
                      )}
                    </div>
                  </div>
                  <div className="dataset-actions">
                    <button
                      className="table-action"
                      disabled={busyId === dataset.id}
                      onClick={() => openEpisodes(dataset.id)}
                    >
                      {openId === dataset.id ? "Bölümleri gizle" : "Bölümler"}
                    </button>
                    <button
                      className="table-action"
                      disabled={busyId === dataset.id}
                      onClick={() => revalidate(dataset.id)}
                    >
                      Yeniden doğrula
                    </button>
                    <button
                      className="table-action"
                      disabled={busyId === dataset.id || !dataset.repo_id}
                      onClick={() => publish(dataset)}
                    >
                      Hub'a gönder
                    </button>
                    <button
                      className="table-action"
                      disabled={busyId === dataset.id}
                      onClick={() => forget(dataset, false)}
                    >
                      Listeden çıkar
                    </button>
                    <button
                      className="table-action danger"
                      disabled={busyId === dataset.id}
                      onClick={() => forget(dataset, true)}
                    >
                      Diskten sil
                    </button>
                  </div>
                  {openId === dataset.id && (
                    <div className="episode-panel">
                      {episodes === null ? (
                        <span className="scenario-note">Bölümler okunuyor…</span>
                      ) : !episodes.readable ? (
                        <span className="scenario-note">
                          {episodes.note ||
                            "Bu kayıt bölüm başına veri taşımıyor, tek tek çıkarılamaz."}
                        </span>
                      ) : (
                        <>
                          {episodes.episodes.some((item) => item.duplicate_of != null) && (
                            <div className="check-row">
                              <StatusIcon status="warning" />
                              <div>
                                <strong>
                                  {
                                    episodes.episodes.filter(
                                      (item) => item.duplicate_of != null,
                                    ).length
                                  }{" "}
                                  bölüm bu kayıtta iki kez var
                                </strong>
                                <span>
                                  İçinde zaten bulunan bir veri setiyle birleştirilmiş.
                                  Bilerek yapıldıysa sorun değil — o kareler eğitimde iki
                                  kat ağırlık taşır. İstemiyorsan işaretli olanları
                                  çıkarmak seti aslına döndürür.
                                </span>
                              </div>
                            </div>
                          )}
                          <div className="episode-list">
                            {episodes.episodes.map((episode: DatasetEpisode) => (
                              <label className="episode-row" key={episode.index}>
                                <input
                                  type="checkbox"
                                  checked={dropping.includes(episode.index)}
                                  onChange={() =>
                                    setDropping((current) =>
                                      current.includes(episode.index)
                                        ? current.filter((item) => item !== episode.index)
                                        : [...current, episode.index],
                                    )
                                  }
                                />
                                <strong>#{episode.index}</strong>
                                <span>{episode.frames} kare</span>
                                <span className="mono-copy">
                                  {episode.action_range != null
                                    ? `aksiyon ${episode.action_range.toFixed(2)}`
                                    : "aksiyon ?"}
                                </span>
                                {episode.demonstrates_nothing && (
                                  <Tag tone="blue">hiçbir şey gösterilmemiş</Tag>
                                )}
                                {episode.duplicate_of != null && (
                                  <Tag tone="amber">
                                    #{episode.duplicate_of} ile aynı kayıt
                                  </Tag>
                                )}
                                {!episode.demonstrates_nothing &&
                                  (episode.still_joints?.length ?? 0) > 0 && (
                                    <Tag tone="amber">
                                      {episode.still_joints!.map((name) =>
                                        name.replace(".pos", ""),
                                      ).join(", ")}{" "}
                                      hiç oynamadı
                                    </Tag>
                                  )}
                              </label>
                            ))}
                          </div>
                          <div className="button-cluster">
                            <button
                              className="secondary-button"
                              disabled={dropping.length === 0 || busyId === dataset.id}
                              onClick={() => dropEpisodes(dataset)}
                            >
                              <X size={15} />
                              Seçilen {dropping.length} bölümü çıkar
                            </button>
                            <span className="inline-note">
                              <ShieldCheck size={14} />
                              Bu kayıt değişmez; kırpılmış bir kopya oluşturulur.
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {comparison && (
        <Panel>
          <PanelHeader
            title="Birlikte eğitilebilirlik"
            subtitle={comparison.datasets.map((item) => item.name).join("  ·  ")}
            action={
              <button className="secondary-button" onClick={() => setComparison(null)}>
                <X size={15} />
                Kapat
              </button>
            }
          />
          <div className="compare-verdict">
            <StatusIcon
              status={
                comparison.status === "compatible"
                  ? "pass"
                  : comparison.status === "warnings"
                    ? "warning"
                    : "blocked"
              }
            />
            <div>
              <strong>{comparison.summary}</strong>
              {comparison.total_episodes != null && (
                <span>
                  birleşince {comparison.total_episodes} bölüm · {comparison.total_frames} kare
                </span>
              )}
            </div>
          </div>
          <div className="check-list">
            {comparison.blockers.map((item) => (
              <div className="check-row" key={`b-${item.key}`}>
                <StatusIcon status="blocked" />
                <div>
                  <strong>{item.reason}</strong>
                  {differenceLines(item.values).map((line) => (
                    <span className="mono-copy" key={line}>
                      {line}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {comparison.warnings.map((item) => (
              <div className="check-row" key={`w-${item.key}`}>
                <StatusIcon status="warning" />
                <div>
                  <strong>{item.reason}</strong>
                  {differenceLines(item.values).map((line) => (
                    <span className="mono-copy" key={line}>
                      {line}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {comparison.blockers.length === 0 && comparison.warnings.length === 0 && (
              <div className="check-row">
                <StatusIcon status="pass" />
                <div>
                  <strong>Bu kayıtlar bir politikanın okuduğu her şeyde hemfikir.</strong>
                  <span>Eklem adları, vektör genişlikleri, görüntü düzeni, kare hızı.</span>
                </div>
              </div>
            )}
          </div>
        </Panel>
      )}
    </>
  );
}

function TrainingStudio({
  datasets,
  policies,
  jobs,
  onCreateJob,
  onAnnotate,
}: {
  datasets: Dataset[];
  policies: Policy[];
  jobs: Job[];
  onCreateJob: CreateJob;
  onAnnotate: (
    jobId: string,
    episode: number,
    outcome: "success" | "failure",
  ) => Promise<Job | null>;
}) {
  const [policyType, setPolicyType] = useState("act");
  const [datasetId, setDatasetId] = useState("");
  const [runtime, setRuntime] = useState("plan");
  const [steps, setSteps] = useState(20000);

  useEffect(() => {
    if (!datasetId && datasets[0]) setDatasetId(datasets[0].id);
  }, [datasetId, datasets]);

  const dataset = datasets.find((item) => item.id === datasetId) ?? null;
  const outputDir = `outputs/train/${policyType}-${dataset?.repo_id?.split("/").pop() ?? "run"}`;
  const local = runtime === "lerobot-local";

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
                {datasets.map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.name} · {item.episodes} bölüm · {item.integrity_status}
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
              <select value={runtime} onChange={(event) => setRuntime(event.target.value)}>
                <option value="plan">Sadece config üret</option>
                <option value="lerobot-local">lerobot-train (yerel)</option>
              </select>
            </label>
            <label>
              Adım sayısı
              <input
                type="number"
                min={100}
                step={100}
                value={steps}
                onChange={(event) => setSteps(Number(event.target.value))}
              />
            </label>
            <label>
              Çıktı dizini
              <input value={outputDir} disabled />
            </label>
          </div>
          <button
            className="primary-button full-button"
            disabled={!dataset?.repo_id}
            onClick={() =>
              void onCreateJob("training", "sim", {
                dataset_id: datasetId,
                repo_id: dataset?.repo_id,
                policy_type: policyType,
                runtime: local ? "lerobot-local" : "plan",
                steps,
                output_dir: outputDir,
                job_name: outputDir.split("/").pop(),
                name: `${policyType.toUpperCase()} · ${dataset?.name ?? ""}`,
              })
            }
          >
            <Cpu size={17} />
            {local ? "Eğitimi başlat" : "Training config üret"}
          </button>
          {!dataset?.repo_id && (
            <span className="inline-note">
              <LockKeyhole size={14} />
              Eğitim bir repo id ister; önce gerçek bir kayıt al veya dataset içe aktar.
            </span>
          )}
        </Panel>
        <Panel>
          <PanelHeader title="Dataset gerçeği" subtitle="meta/info.json'dan okunur" />
          {!dataset ? (
            <EmptyState icon={Database} title="Bir dataset seç" />
          ) : (
            <>
              <div className="fact-row">
                <div>
                  <small>Bütünlük</small>
                  <strong>{dataset.integrity_status}</strong>
                </div>
                <div>
                  <small>Bölüm / kare</small>
                  <strong>
                    {dataset.episodes} / {dataset.total_frames}
                  </strong>
                </div>
                <div>
                  <small>Sürüm</small>
                  <strong>{dataset.codebase_version ?? "—"}</strong>
                </div>
              </div>
              <div className="schema-preview">
                <span>FEATURE CONTRACT</span>
                {dataset.features.length === 0 ? (
                  <code>henüz okunmadı</code>
                ) : (
                  dataset.features.map((feature) => <code key={feature}>{feature}</code>)
                )}
              </div>
              {(dataset.integrity_report?.problems ?? []).length > 0 && (
                <div className="preflight-checks">
                  {(dataset.integrity_report?.problems ?? []).map((problem) => (
                    <div className="preflight-check status-blocked" key={problem}>
                      <StatusIcon status="blocked" />
                      <div>
                        <strong>Bütünlük sorunu</strong>
                        <span>{problem}</span>
                      </div>
                      <code>integrity</code>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>
      </section>

      <EvaluationAnnotations jobs={jobs} onAnnotate={onAnnotate} />

      <Panel>
        <PanelHeader title="Policy registry" subtitle={`${policies.length} policy manifest`} />
        {policies.length === 0 ? (
          <EmptyState icon={Cpu} title="Kayıtlı policy yok" />
        ) : (
          <div className="policy-grid">
            {policies.map((policy) => (
              <div className="policy-card" key={policy.id}>
                <div className="policy-type">{policy.policy_type}</div>
                <h3>{policy.name}</h3>
                <span className="mono-copy">{policy.checkpoint ?? "checkpoint yok"}</span>
                <div className="policy-meta">
                  <span>
                    Action {JSON.stringify(policy.action_shape)}
                    {policy.checkpoint_step != null && ` · adım ${policy.checkpoint_step}`}
                  </span>
                  <StatusBadge value={policy.compatibility_status} />
                </div>
                <button
                  className="secondary-button full-button"
                  onClick={() =>
                    void onCreateJob("evaluation", "sim", {
                      policy_id: policy.id,
                      episodes: 5,
                    })
                  }
                >
                  <FlaskConical size={16} />
                  Sim contract koşusu
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

function EvaluationAnnotations({
  jobs,
  onAnnotate,
}: {
  jobs: Job[];
  onAnnotate: (
    jobId: string,
    episode: number,
    outcome: "success" | "failure",
  ) => Promise<Job | null>;
}) {
  const job = jobs.find(
    (item) =>
      (item.kind === "evaluation" || item.kind === "policy_rollout") &&
      ["completed", "aborted", "failed"].includes(item.state),
  );
  if (!job) return null;

  const requested = Number(job.result.episodes_requested ?? job.parameters.episodes ?? 0);
  const outcomes = (job.result.episode_outcomes ?? []) as Array<{
    episode: number;
    outcome: string;
  }>;
  const evaluation = job.result.evaluation as
    | { annotated: number; successes: number; failures: number; success_rate: number | null }
    | undefined;
  const verdict = (episode: number) =>
    outcomes.find((item) => item.episode === episode)?.outcome ?? null;

  return (
    <Panel>
      <PanelHeader
        title="Bölüm sonuçları"
        subtitle="Başarıyı sistem değil operatör belirler"
        action={<StatusBadge value={job.kind} />}
      />
      {requested === 0 ? (
        <EmptyState icon={ListChecks} title="Bu koşuda işaretlenecek bölüm yok" />
      ) : (
        <>
          <div className="episode-list">
            {Array.from({ length: requested }, (_, episode) => (
              <div className="episode-row" key={episode}>
                <span>Bölüm {episode}</span>
                <div className="button-cluster">
                  <button
                    className={verdict(episode) === "success" ? "primary-button" : "secondary-button"}
                    onClick={() => void onAnnotate(job.id, episode, "success")}
                  >
                    <Check size={15} />
                    Başarılı
                  </button>
                  <button
                    className={verdict(episode) === "failure" ? "primary-button" : "secondary-button"}
                    onClick={() => void onAnnotate(job.id, episode, "failure")}
                  >
                    <X size={15} />
                    Başarısız
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="fact-row">
            <div>
              <small>İşaretlenen</small>
              <strong>
                {evaluation?.annotated ?? 0} / {requested}
              </strong>
            </div>
            <div>
              <small>Başarı</small>
              <strong>
                {evaluation?.success_rate != null
                  ? `%${Math.round(evaluation.success_rate * 100)}`
                  : "—"}
              </strong>
            </div>
            <div>
              <small>Kaynak</small>
              <strong>operatör</strong>
            </div>
          </div>
        </>
      )}
    </Panel>
  );
}

/** What each step state means to somebody reading the plan, not to the runner. */
const STEP_STATES: Record<string, { label: string; tone?: "blue" }> = {
  planned: { label: "çalıştırılmadı" },
  completed: { label: "tamam" },
  blocked: { label: "engellendi", tone: "blue" },
  failed: { label: "başarısız", tone: "blue" },
  awaiting_human: { label: "insan onayı bekliyor", tone: "blue" },
  skipped: { label: "atlandı" },
};

/**
 * A plan, as a plan rather than as JSON.
 *
 * The page dumped the whole result into a <pre>, which was tolerable when a
 * plan was one action. An ordered chain read as a wall: the operator's two
 * questions -- what will this do, and where did it stop -- were both in there
 * and neither was findable.
 */
function PlanReadout({ result }: { result: AgentPlanResult }) {
  return (
    <div className="action-brief">
      {result.plan.rationale && <p>{result.plan.rationale}</p>}
      {result.stopped_because && (
        <div className="permission-strip">
          <ShieldCheck size={16} />
          <span>{result.stopped_because}</span>
        </div>
      )}
      <div className="check-list">
        {result.steps.map((step) => {
          const state = STEP_STATES[step.state] ?? { label: step.state };
          return (
            <div className="check-row" key={step.index}>
              <ChevronRight size={15} />
              <div>
                <strong>
                  {step.index + 1}. {step.action}
                </strong>
                <span>{step.message}</span>
                <div className="capability-line">
                  <Tag tone={state.tone}>{state.label}</Tag>
                  {step.brief?.needs_human_approval && <Tag tone="blue">insan onayı ister</Tag>}
                </div>
                {step.warnings.map((warning) => (
                  <span className="scenario-note" key={warning}>
                    {warning}
                  </span>
                ))}
                {step.command_result?.data &&
                  Object.keys(step.command_result.data).length > 0 && (
                    <pre>{JSON.stringify(step.command_result.data, null, 2).slice(0, 1200)}</pre>
                  )}
              </div>
            </div>
          );
        })}
      </div>
      {result.plan.risks.length > 0 && (
        <p className="scenario-note">
          Modelin kendi beyanı: {result.plan.risks.join(" · ")}
        </p>
      )}
    </div>
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
  const [catalogue, setCatalogue] = useState<AgentAction[]>([]);
  const [roleDescription, setRoleDescription] = useState("");
  const [parameterText, setParameterText] = useState("{}");
  const [planner, setPlanner] = useState<PlannerStatus | null>(null);
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const selected = agents.find((agent) => agent.id === selectedId);

  // The conversation so far, from the server rather than from this component's
  // memory: what makes a follow-up work is the result of the earlier steps, and
  // a browser reload should not be the thing that makes the model forget.
  useEffect(() => {
    if (!selectedId) return;
    void api
      .get<AgentTurn[]>(`/agents/sessions/${selectedId}/turns`)
      .then(setTurns)
      .catch(() => setTurns([]));
  }, [selectedId]);

  // Whether a model is configured at all. The page offered a "plan with
  // Strands" button and never asked, so on a machine with no model set the
  // button was always there and always failed -- and pressing it cannot tell an
  // operator apart a broken planner from an unconfigured one.
  useEffect(() => {
    void api
      .get<PlannerStatus>("/agents/runtime")
      .then(setPlanner)
      .catch(() => setPlanner(null));
  }, []);

  // What this session may do, from the server. The page used to hardcode each
  // action's parameters, and got them wrong: prepare_training sent policy_type
  // but never repo_id, so it blocked on a missing dataset every single time.
  useEffect(() => {
    if (!selectedId) return;
    void api
      .get<{ actions: AgentAction[]; description: string }>(
        `/agents/catalogue?session_id=${selectedId}`,
      )
      .then((payload) => {
        setCatalogue(payload.actions);
        setRoleDescription(payload.description ?? "");
      })
      .catch(() => {
        setCatalogue([]);
        setRoleDescription("");
      });
  }, [selectedId]);

  const action = catalogue.find((item) => item.action === selectedAction) ?? null;

  // Prefill the shape rather than guessing the values: an agent (or an operator
  // driving one by hand) should see exactly which keys the server reads.
  useEffect(() => {
    if (!action?.parameters) {
      setParameterText("{}");
      return;
    }
    const draft: Record<string, string> = {};
    for (const key of Object.keys(action.parameters)) draft[key] = "";
    setParameterText(JSON.stringify(draft, null, 2));
  }, [action]);

  // Validated against the catalogue, which is what the dropdown actually lists.
  // Checking `permissions` instead meant that whenever the stored list ran
  // behind the role -- and it did, by two entries -- picking one of the newer
  // actions was silently undone the instant it was chosen. The operator sees a
  // dropdown that snaps back to its first option and no explanation.
  useEffect(() => {
    const allowed =
      catalogue.length > 0
        ? catalogue.map((item) => item.action)
        : (selected?.permissions ?? []);
    if (allowed.length > 0 && !allowed.includes(selectedAction)) {
      setSelectedAction(allowed[0]);
    }
  }, [catalogue, selected, selectedAction]);

  const run = async () => {
    let parameters: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(parameterText || "{}") as Record<string, unknown>;
      // Empty strings are the prefilled shape, not an operator's answer.
      parameters = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value !== "" && value !== null),
      );
    } catch {
      setOutput({ error: "Parametreler geçerli JSON değil." });
      return;
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

  const send = async (execute: boolean) => {
    const asked = prompt.trim();
    if (!asked) return;
    // Shown immediately, because the model takes ten to fifty seconds on this
    // board and a question that vanishes from the box while nothing appears
    // reads as the page having lost it.
    setPending(asked);
    setPrompt("");
    const result = await onAction(
      () =>
        api.post<AgentPlanResult>("/agents/plan", {
          session_id: selectedId,
          prompt: asked,
          execute,
        }),
      execute ? "Okuma adımları çalıştırıldı." : "Plan üretildi; hiçbir adım çalışmadı.",
    );
    setPending(null);
    if (result) {
      setTurns((existing) => [
        ...existing,
        { id: `local-${existing.length}`, session_id: selectedId, prompt: asked, result },
      ]);
    } else {
      // The request failed; put the question back rather than making them retype it.
      setPrompt(asked);
    }
  };

  const clearConversation = async () => {
    await onAction(
      () => api.del<{ cleared: number }>(`/agents/sessions/${selectedId}/turns`),
      "Konuşma silindi.",
    );
    setTurns([]);
  };

  const ready = planner === null || planner.ready;

  return (
    <section className="agent-layout">
      <Panel className="agent-roster">
        <PanelHeader title="Kiminle konuşuyorsun" subtitle="Her rolün eriştiği yer farklı" />
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
                <small>{agent.permissions.length} eylem</small>
              </span>
            </button>
          ))}
        </div>
        {/* The most consequential choice on the page used to be a guess:
            five names, five green dots, and nothing saying what any of them
            was for. The green dots are gone too -- they implied a running
            process, and nothing runs until you ask it something. */}
        {roleDescription && <p className="scenario-note">{roleDescription}</p>}
        <div className="permission-strip">
          <ShieldCheck size={16} />
          <span>
            Ham seri port, shell ve servo döngüsü hiçbir role açık değil. Kolu kımıldatan her
            eylem insan onayı bekler.
          </span>
        </div>
        {catalogue.length > 0 && (
          <div className="check-list">
            {catalogue.map((item) => (
              <div className="check-row" key={item.action}>
                <ChevronRight size={15} />
                <div>
                  <strong>{item.action}</strong>
                  <span>{item.summary}</span>
                  {item.needs_human_approval && <Tag tone="blue">insan onayı</Tag>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="agent-console">
        <div className="console-head">
          <div>
            <span className="mono-label">{selected?.role.replaceAll("_", " ").toUpperCase()}</span>
            <h2>{selected?.name ?? "Agent"}</h2>
          </div>
          {/* The stored `model_provider` said "deterministic" whatever was
              configured, because seeding wrote it once and nothing updated it.
              What an operator needs here is which model is answering. */}
          <StatusBadge value={planner?.model_id ?? planner?.model ?? "model yok"} />
        </div>

        <div className="agent-conversation">
          {turns.length === 0 && !pending && (
            <div className="console-empty">
              <BrainCircuit size={24} />
              <span>
                Ne istediğini kendi cümlelerinle yaz. Adımları o önerir, çalıştırmaya sen karar
                verirsin.
              </span>
            </div>
          )}
          {turns.map((turn) => (
            <div key={turn.id}>
              <p className="agent-said">{turn.prompt}</p>
              <PlanReadout result={turn.result} />
            </div>
          ))}
          {pending && (
            <div>
              <p className="agent-said">{pending}</p>
              <p className="scenario-note">Düşünüyor… bu kartta 10–50 saniye sürebilir.</p>
            </div>
          )}
        </div>

        <div className="planner-block">
          <label>
            <textarea
              value={prompt}
              placeholder="Elimde hangi kayıtlar var?"
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!ready}
              rows={2}
            />
          </label>
          <div className="capability-line">
            {/* Two buttons because running a plan is not the same decision as
                making one. The left one touches nothing; the right one runs the
                read-only steps and stops at the first that needs a person. */}
            <button
              className="secondary-button"
              onClick={() => void send(false)}
              disabled={!ready || pending !== null}
            >
              <BrainCircuit size={17} />
              Sadece planla
            </button>
            <button
              className="primary-button"
              onClick={() => void send(true)}
              disabled={!ready || pending !== null}
            >
              <ChevronRight size={17} />
              Planla ve okuma adımlarını çalıştır
            </button>
            {turns.length > 0 && (
              <button className="secondary-button" onClick={() => void clearConversation()}>
                Konuşmayı sil
              </button>
            )}
          </div>
          {planner?.blocked_by && <p className="scenario-note">{planner.blocked_by}</p>}
        </div>

        {/* Folded away, because it is the fallback rather than the point: for
            when you know exactly which command you want, or when no model is
            configured and the conversation above cannot happen at all. */}
        <div className="action-brief">
          <button className="secondary-button" onClick={() => setManualOpen(!manualOpen)}>
            <TerminalSquare size={15} />
            {manualOpen ? "Tek komutu gizle" : "Tek komutu elle çalıştır"}
          </button>
          {manualOpen && (
            <>
              <p className="scenario-note">
                Modelden geçmeden tek bir eylemi doğrudan çalıştırır. Aynı kapıdan geçer: aynı
                izinler, aynı onay kuralları.
              </p>
              <div className="command-builder">
                <label>
                  Eylem
                  <select
                    value={selectedAction}
                    onChange={(event) => setSelectedAction(event.target.value)}
                  >
                    {(catalogue.length > 0
                      ? catalogue.map((item) => item.action)
                      : (selected?.permissions ?? [])
                    ).map((permission) => (
                      <option key={permission} value={permission}>
                        {permission}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="secondary-button" onClick={() => void run()}>
                  Çalıştır
                </button>
              </div>

              {action && (
                <>
                  <p>{action.summary}</p>
                  <div className="capability-line">
                    {action.creates_job && <Tag>iş yaratır</Tag>}
                    {action.needs_human_approval && <Tag tone="blue">insan onayı ister</Tag>}
                    {(action.target_modes ?? []).map((mode) => (
                      <Tag key={mode} tone={mode === "real" ? "blue" : "neutral"}>
                        {mode}
                      </Tag>
                    ))}
                  </div>
                  {action.returns && <p className="scenario-note">{action.returns}</p>}
                  {/* Split on the newlines the catalogue writes: HTML collapses
                      them, so an action with three separate warnings arrived as
                      one wall. */}
                  {(action.note ?? "")
                    .split("\n")
                    .filter(Boolean)
                    .map((line) => (
                      <p className="scenario-note" key={line}>
                        {line}
                      </p>
                    ))}
                  {action.parameters && Object.keys(action.parameters).length > 0 && (
                    <div className="check-list">
                      {Object.entries(action.parameters).map(([key, hint]) => (
                        <div className="check-row" key={key}>
                          <ChevronRight size={15} />
                          <div>
                            <strong>{key}</strong>
                            <span>{hint}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <label className="form-span">
                    Parametreler (JSON) — sunucunun okuduğu anahtarlar yukarıda
                    <textarea
                      rows={Math.min(10, Object.keys(action.parameters ?? {}).length + 2)}
                      value={parameterText}
                      onChange={(event) => setParameterText(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                </>
              )}

              {output && <pre>{JSON.stringify(output, null, 2)}</pre>}
            </>
          )}
        </div>
      </Panel>
    </section>
  );
}
/**
 * Step one of the pipeline: produce a dataset.
 *
 * This page replaced two. Recording could be started from Operate and from
 * Simulation, and the two forms disagreed on their fields and their defaults
 * while the server had already decided that simulation is a *target*, not a
 * different activity. Three doors to one job is what "scattered" looks like
 * from the sidebar.
 *
 * So: one form, one target switch, one job. Where the follower lives -- a motor
 * or a model -- is the only thing that changes, and the server picks the
 * recorder from `target_mode`.
 */
function CollectStudio({
  robots,
  teleoperators,
  scenarios,
  jobs,
  telemetry,
  safety,
  onCreateJob,
  onConfirm,
  onInput,
  onCancel,
}: {
  robots: Robot[];
  teleoperators: Teleoperator[];
  scenarios: Scenario[];
  jobs: Job[];
  telemetry: Record<string, TelemetrySummary>;
  safety: SafetyStatus | null;
  onCreateJob: CreateJob;
  onConfirm: (jobId: string, approvalId: string) => Promise<unknown>;
  onInput: (jobId: string, key: string) => Promise<unknown>;
  onCancel: (jobId: string) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<TargetMode>("sim");
  const [robotId, setRobotId] = useState("");
  const [leaderId, setLeaderId] = useState("");
  const [repoId, setRepoId] = useState("mertkirgil/so101_yeni_kayit");
  const [task, setTask] = useState("pick up the red cube and drop it in the bin");
  const [episodes, setEpisodes] = useState(5);
  const [episodeSeconds, setEpisodeSeconds] = useState(30);
  const [workspaceConfirmed, setWorkspaceConfirmed] = useState(false);
  const [scenarioId, setScenarioId] = useState("");
  const [openViewer, setOpenViewer] = useState(true);
  const [keepOnlySuccesses, setKeepOnlySuccesses] = useState(false);
  const [backends, setBackends] = useState<SimulationBackends | null>(null);
  const [liveAttempt, setLiveAttempt] = useState(0);
  /**
   * Reconnect the live picture when the recorder moves to the next episode.
   *
   * `onError` only fires when the request itself fails. A stream that ends
   * cleanly leaves the last frame on screen forever, and that is exactly what
   * happened between episodes: `save_episode()` encodes video for about
   * eighteen seconds without publishing anything, the server closed on the
   * silence, and the panel froze on episode one for the rest of the session.
   * The server no longer closes mid-session; this reconnects anyway, because a
   * frozen picture is indistinguishable from a stopped arm.
   */
  const liveEpisode =
    telemetry[activeJobFor(jobs, ["sim_recording"])?.id ?? ""]?.episode?.episode ?? null;
  useEffect(() => {
    if (liveEpisode == null) return;
    setLiveAttempt((n) => n + 1);
  }, [liveEpisode]);

  const real = mode === "real";
  const physicalLocked = !(safety?.physical_enabled ?? false);

  useEffect(() => {
    void api
      .get<SimulationBackends>("/simulation/backends")
      .then(setBackends)
      .catch(() => setBackends(null));
  }, []);

  const followers = useMemo(
    () => robots.filter((item) => item.target_mode !== "sim"),
    [robots],
  );
  const leaders = useMemo(
    () => teleoperators.filter((item) => item.target_mode !== "sim"),
    [teleoperators],
  );

  useEffect(() => {
    if (!followers.some((item) => item.id === robotId)) setRobotId(followers[0]?.id ?? "");
  }, [followers, robotId]);
  useEffect(() => {
    if (!leaders.some((item) => item.id === leaderId)) setLeaderId(leaders[0]?.id ?? "");
  }, [leaders, leaderId]);
  useEffect(() => {
    if (!scenarios.some((item) => item.id === scenarioId)) setScenarioId(scenarios[0]?.id ?? "");
  }, [scenarios, scenarioId]);

  /**
   * Which simulated cameras a take renders decides whether it can ever be
   * trained beside a real one: a merge needs identical features, and a
   * simulated recording carrying a view the arm does not have is discovered to
   * be unusable at the merge, long after the demonstrations were collected.
   * Empty means "follow the arm", which the server resolves from the follower.
   */
  const [simCameras, setSimCameras] = useState("");
  const benchCameras = useMemo(() => {
    const follower = followers.find((item) => Object.keys(item.camera_mapping ?? {}).length > 0);
    return Object.keys(follower?.camera_mapping ?? {}).sort();
  }, [followers]);

  // A confirmation is about one workspace and one arm; changing either voids it.
  useEffect(() => setWorkspaceConfirmed(false), [mode, robotId]);

  const scenario = scenarios.find((item) => item.id === scenarioId) ?? null;

  const parameters = useMemo(() => {
    const base: Record<string, unknown> = {
      teleoperator_profile_id: leaderId,
      repo_id: repoId,
      name: repoId.split("/").pop() ?? repoId,
      task,
      episodes,
      episode_time_s: episodeSeconds,
    };
    if (real) {
      // No camera mapping is sent: the server reads it off the follower profile
      // and ignores anything a client claims. Sending one said "front" on a
      // bench whose only camera is the wrist.
      return {
        ...base,
        robot_profile_id: robotId,
        workspace_confirmed: workspaceConfirmed,
      };
    }
    return {
      ...base,
      scenario_id: scenarioId,
      open_viewer: openViewer,
      keep_only_successes: keepOnlySuccesses,
      workspace_confirmed: true,
      // Empty means "whatever the arm has" -- the server fills it from the
      // follower profile so a simulated take can be merged with a real one.
      ...(simCameras ? { cameras: simCameras } : {}),
    };
  }, [
    real,
    robotId,
    leaderId,
    repoId,
    task,
    episodes,
    episodeSeconds,
    workspaceConfirmed,
    scenarioId,
    openViewer,
    keepOnlySuccesses,
    simCameras,
  ]);

  // The server rewrites `recording + sim` into the simulated recorder, so the
  // page never has to know which kind it is asking for.
  const preview = usePreview(
    leaderId
      ? {
          kind: "recording",
          target_mode: mode,
          parameters,
          resources: [],
          requested_by: "dashboard",
        }
      : null,
  );

  const active = activeJobFor(jobs, ["recording", "sim_recording"]);
  const approval = pendingApprovalFor(jobs, ["recording", "sim_recording"]);
  const blocked = Boolean(preview && !preview.preflight.allowed);
  const simReady = Boolean(scenario && backends?.mujoco_installed);
  const ready = leaderId && (real ? robotId && workspaceConfirmed && !blocked : simReady);

  return (
    <>
      <Panel>
        <PanelHeader
          title="Gösterim kaydet"
          subtitle="Hedefi seç; kayıt her iki durumda da aynı biçimde yazılır"
        />

        <div className="mode-switch">
          <button className={!real ? "active" : ""} onClick={() => setMode("sim")}>
            <FlaskConical size={15} />
            Simülasyon
          </button>
          <button
            className={real ? "active danger" : ""}
            disabled={physicalLocked}
            title={physicalLocked ? "Fiziksel adaptörler kapalı (HASHTAG_ENABLE_PHYSICAL)" : ""}
            onClick={() => setMode("real")}
          >
            <Radio size={15} />
            Gerçek kol
          </button>
        </div>

        <p className="scenario-note">
          {real
            ? "Follower gerçekten hareket eder. Onay kartı, çalışma alanı teyidi ve acil durdurma bu yüzden burada."
            : "Follower hiç açılmaz, leader yalnızca okunur — bu oturum bir eklemi oynatamaz. Bir görevi gerçek kolda kaydetmeden önce prova etmenin yeri burası."}
        </p>

        <div className="form-grid">
          {real ? (
            <>
              <label>
                Follower
                <select value={robotId} onChange={(event) => setRobotId(event.target.value)}>
                  {followers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Leader
                <select value={leaderId} onChange={(event) => setLeaderId(event.target.value)}>
                  {leaders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                Görev
                <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)}>
                  {scenarios.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Leader
                <select value={leaderId} onChange={(event) => setLeaderId(event.target.value)}>
                  {leaders.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="form-span">
            Dataset adı
            <input value={repoId} onChange={(event) => setRepoId(event.target.value)} />
          </label>
          <label className="form-span">
            Görev metni (politikanın göreceği talimat)
            <input value={task} onChange={(event) => setTask(event.target.value)} />
          </label>
          <label>
            Bölüm
            <input
              type="number"
              min={1}
              value={episodes}
              onChange={(event) => setEpisodes(Number(event.target.value))}
            />
          </label>
          <label>
            Bölüm süresi (sn)
            <input
              type="number"
              min={1}
              value={episodeSeconds}
              onChange={(event) => setEpisodeSeconds(Number(event.target.value))}
            />
          </label>
        </div>

        {!real && (
          <div className="check-list">
            <Toggle
              checked={openViewer}
              onChange={setOpenViewer}
              disabled={!backends?.viewer_available}
              label="MuJoCo penceresini aç"
              hint={
                backends?.viewer_available
                  ? "Bu makinenin ekranında açılır; sürerken izlemek için doğru yer burasıdır."
                  : "Bu makinede masaüstü oturumu yok, pencere açılamaz."
              }
            />
            <Toggle
              checked={keepOnlySuccesses}
              onChange={setKeepOnlySuccesses}
              label="Yalnız başarılı bölümleri kaydet"
              hint="Küp kutuya girmeden biten bölüm atılır."
            />
          </div>
        )}

        {!real && (
          <label className="form-span">
            Kaydedilecek kameralar
            <select value={simCameras} onChange={(event) => setSimCameras(event.target.value)}>
              <option value="">
                {benchCameras.length
                  ? `Kolla aynı (${benchCameras.join(", ")})`
                  : "Sahne varsayılanı (front, wrist)"}
              </option>
              <option value="wrist">yalnız wrist</option>
              <option value="front">yalnız front</option>
              <option value="front,wrist">front + wrist</option>
            </select>
            <span className="inline-note">
              <Info size={13} />
              Birleştirme aynı özellikleri ister: kolda olmayan bir kamerayla kaydedilen
              simülasyon bölümü, gerçek kayıtlarla asla birlikte eğitilemez.
            </span>
          </label>
        )}

        {real && (
          <label className="sim-check">
            <input
              type="checkbox"
              checked={workspaceConfirmed}
              onChange={(event) => setWorkspaceConfirmed(event.target.checked)}
            />
            Çalışma alanı temiz ve kol serbest — bunu sunucu göremez, sen onaylarsın.
          </label>
        )}

        {real && preview && <PreflightChecklist checks={preview.preflight.checks} />}
        {real && <CommandPreviewBlock preview={preview} />}

        <div className="button-cluster">
          <button
            className="primary-button"
            disabled={!ready || Boolean(active)}
            onClick={() => void onCreateJob("recording", mode, parameters)}
          >
            <Database size={16} />
            {real ? "Gerçek kolda" : "Simülasyonda"} kayda başla
          </button>
          {!real && (
            <button
              className="secondary-button"
              disabled={!simReady || Boolean(active)}
              onClick={() =>
                void onCreateJob("teleoperation", "sim", {
                  teleoperator_profile_id: leaderId,
                  scenario_id: scenarioId,
                  open_viewer: openViewer,
                  episode_time_s: episodeSeconds,
                  workspace_confirmed: true,
                })
              }
            >
              <Play size={15} />
              Önce prova et (kayıt yok)
            </button>
          )}
          {blocked && real && (
            <span className="inline-note">
              <LockKeyhole size={14} />
              Yukarıdaki kırmızı kontroller geçene kadar başlatılamaz.
            </span>
          )}
        </div>
      </Panel>

      {approval && <ApprovalPanel job={approval} onConfirm={onConfirm} onCancel={onCancel} />}

      {active && (
        <Panel>
          <PanelHeader
            title="Kayıt sürüyor"
            subtitle={String(active.parameters.repo_id ?? "")}
            action={
              <button className="danger-button" onClick={() => void onCancel(active.id)}>
                <Square size={15} />
                Durdur
              </button>
            }
          />
          <div className="sim-live">
            <div>
              <div className="fact-row">
                <Telemetry
                  label="Döngü p50"
                  value={
                    telemetry[active.id]?.p50_loop_ms != null
                      ? `${telemetry[active.id].p50_loop_ms!.toFixed(2)} ms`
                      : "—"
                  }
                  good={(telemetry[active.id]?.p50_loop_ms ?? 999) < 40}
                />
                <Telemetry label="Örnek" value={String(telemetry[active.id]?.samples ?? 0)} />
                <Telemetry
                  label="Bölüm"
                  value={
                    telemetry[active.id]?.episode?.episode != null
                      ? String(telemetry[active.id].episode!.episode! + 1)
                      : "—"
                  }
                />
              </div>
              <p className="scenario-note">{active.message}</p>
            </div>
            {active.kind === "sim_recording" && (
              <figure className="sim-thumb">
                <img
                  key={`${active.id}-${liveAttempt}`}
                  src={`/api/simulation/live.mjpg?job=${active.id}&try=${liveAttempt}`}
                  alt="Kaydedilen kamera görüntüsü"
                  onError={() => window.setTimeout(() => setLiveAttempt((n) => n + 1), 1500)}
                />
                <figcaption>kaydedilen kare</figcaption>
              </figure>
            )}
          </div>
          {/* Both recorders now take the same three requests, so both get the
              panel that sends them. The simulated one was left out and could
              only be cancelled -- which kills the process and loses the take. */}
          <LiveJobPanel
            job={active}
            telemetry={telemetry[active.id]}
            onInput={onInput}
            onCancel={onCancel}
          />
        </Panel>
      )}

      {!real && (
        <Panel>
          <PanelHeader title="Simülasyon ortamı" subtitle="Bu makinede ne var, ne yok" />
          <div className="capability-line">
            <Tag tone={backends?.mujoco_installed ? "green" : "neutral"}>
              MuJoCo {backends?.mujoco_installed ? "kurulu" : "yok"}
            </Tag>
            <Tag tone={backends?.so101_model_available ? "green" : "neutral"}>
              {backends?.so101_model_available ? "mesh'li SO-101" : "sözleşme modeli"}
            </Tag>
          </div>
          <p className="scenario-note">
            Simülasyonda alınan kayıt gerçek kolun yazdığıyla <strong>aynı sözleşmede</strong>{" "}
            doğar. Yine de birleştirmeden önce Veri Setleri'nde karşılaştır: aynı şema, aynı
            birleşebilirlik demek değil.
          </p>
        </Panel>
      )}
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
  // A job ledger is append-only and the audit trail is fetched 100 deep, so
  // both columns grew without limit and pushed the running job -- the only row
  // an operator can still act on -- below the fold. Paging keeps the newest
  // page in view; the page count is what tells you how much history is behind
  // it.
  const jobPage = usePagedList(jobs, 8);
  const auditPage = usePagedList(audit, 10);

  return (
    <section className="activity-layout">
      <Panel>
        <PanelHeader title="Job ledger" subtitle={`${jobs.length} persisted workflow`} />
        <JobTable jobs={jobPage.visible} onCancel={onCancel} />
        <Pagination unit="job" {...jobPage} />
      </Panel>
      <Panel>
        <PanelHeader title="Audit trail" subtitle="Command → state → result" />
        <div className="audit-list">
          {auditPage.visible.map((event) => (
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
        <Pagination unit="olay" {...auditPage} />
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

type PagedList<T> = {
  visible: T[];
  page: number;
  pageCount: number;
  total: number;
  /** 1-based index of the first visible row; 0 when the list is empty. */
  from: number;
  to: number;
  setPage: (page: number) => void;
};

/**
 * Client-side paging for a list that already arrived whole. Both callers hold
 * their rows in memory -- jobs stream in over the event socket, audit comes
 * back in one fetch -- so slicing here costs nothing and avoids an offset
 * parameter the API does not have.
 *
 * The page is clamped during render *and* corrected in an effect. Render-time
 * clamping alone would leave a stale page number in state: an operator viewing
 * the last page of a list that shrinks would see a valid page, then get thrown
 * forward again the moment a new job made the old number reachable.
 */
function usePagedList<T>(items: T[], pageSize: number): PagedList<T> {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * pageSize;

  useEffect(() => {
    setPage((previous) => Math.min(previous, pageCount));
  }, [pageCount]);

  const visible = useMemo(() => items.slice(start, start + pageSize), [items, start, pageSize]);

  return {
    visible,
    page: current,
    pageCount,
    total: items.length,
    from: items.length === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, items.length),
    setPage,
  };
}

/**
 * Which page numbers to draw: every one of them while they fit, otherwise the
 * ends plus a window around the current page (1 … 4 5 6 … 12). The audit panel
 * is the narrow column of the layout, so the slot count is capped rather than
 * left to grow with history.
 */
function pageWindow(page: number, pageCount: number): Array<number | "gap"> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const wanted = new Set([1, pageCount, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((candidate) => wanted.add(candidate));
  if (page >= pageCount - 2) [pageCount - 3, pageCount - 2, pageCount - 1].forEach((c) => wanted.add(c));

  const sorted = [...wanted].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
  const slots: Array<number | "gap"> = [];
  let previous = 0;
  for (const number of sorted) {
    if (previous && number - previous > 1) slots.push("gap");
    slots.push(number);
    previous = number;
  }
  return slots;
}

function Pagination({
  page,
  pageCount,
  total,
  from,
  to,
  unit,
  setPage,
}: Omit<PagedList<unknown>, "visible"> & { unit: string }) {
  // One page is the whole list: a control bar there would say nothing except
  // that there is nothing to page through.
  if (pageCount <= 1) return null;

  return (
    <nav className="pagination" aria-label={`${unit} sayfalama`}>
      <span className="pagination-range">
        {from}–{to} / {total} {unit}
      </span>
      <div className="pagination-controls">
        <button
          type="button"
          onClick={() => setPage(page - 1)}
          disabled={page <= 1}
          aria-label="Önceki sayfa"
        >
          <ChevronLeft size={13} />
        </button>
        {pageWindow(page, pageCount).map((slot, index) =>
          slot === "gap" ? (
            <span className="pagination-gap" key={`gap-${index}`} aria-hidden="true">
              …
            </span>
          ) : (
            <button
              type="button"
              key={slot}
              onClick={() => setPage(slot)}
              aria-current={slot === page ? "page" : undefined}
              aria-label={`Sayfa ${slot}`}
            >
              {slot}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => setPage(page + 1)}
          disabled={page >= pageCount}
          aria-label="Sonraki sayfa"
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </nav>
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

/* Marka markasi favicon ile ayni dosyadir, boylece sekme ikonu ile kenar
   cubugundaki isaret hic ayrisamaz. Logo temayla renk degistirmez: kurumsal
   kimlik her zeminde ayni gorunur. */
function BrandMark() {
  return <img className="brand-mark" src="/assets/favicon.svg" alt="" width={32} height={32} />;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("hr-theme", theme);
    } catch {
      // localStorage kapaliysa secim yalnizca bu oturum boyunca yasar
    }
  }, [theme]);

  const next = theme === "dark" ? "light" : "dark";
  const label = next === "light" ? "Açık temaya geç" : "Koyu temaya geç";

  return (
    <button
      className="icon-button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={label}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
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
  if (status === "not_applicable") {
    return <Square size={16} className="quiet-icon" />;
  }
  return <CircleAlert size={18} className="warning-icon" />;
}

/**
 * A switch that reads like the rest of the panel: same row height, same soft
 * divider, label and reason side by side. A bare checkbox next to a sentence
 * was the only control on the page that looked like it came from somewhere
 * else -- and a disabled one has to say why, or it just looks broken.
 */
function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row${disabled ? " disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-text">
        <strong>{label}</strong>
        {hint && <span>{hint}</span>}
      </span>
    </label>
  );
}

function Tag({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "green" | "blue" | "amber";
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
  detail,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={24} />
      <span>{title}</span>
      {detail && <small>{detail}</small>}
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
