export type CheckStatus = "pass" | "warning" | "blocked" | "not_applicable";
export type TargetMode = "read_only" | "sim" | "real";

export interface Job {
  id: string;
  kind: string;
  state: string;
  target_mode: TargetMode;
  parameters: Record<string, unknown>;
  requested_by: string;
  progress: number;
  message: string;
  result: Record<string, unknown>;
  error_code?: string | null;
  error_message?: string | null;
  approval_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Summary {
  system_status: CheckStatus;
  physical_enabled: boolean;
  devices: number;
  robots: number;
  datasets: number;
  policies: number;
  active_jobs: number;
  blocked_jobs: number;
  recent_jobs: Job[];
}

export interface DoctorCheck {
  code: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string | null;
}

export interface CapabilityManifest {
  platform_version: string;
  python_version: string;
  os: string;
  architecture: string;
  packages: Record<string, string | null>;
  accelerator: string;
  camera_backends: string[];
  robot_adapters: string[];
  policy_adapters: string[];
  simulation_backends: string[];
  physical_enabled: boolean;
}

export interface DoctorReport {
  overall: CheckStatus;
  checks: DoctorCheck[];
  capabilities: CapabilityManifest;
}

export interface Device {
  id: string;
  kind: string;
  name: string;
  stable_fingerprint: string;
  transient_path?: string | null;
  vendor?: string | null;
  product?: string | null;
  serial_number?: string | null;
  capabilities: string[];
  health: string;
  is_simulated: boolean;
}

export interface Robot {
  id: string;
  name: string;
  product_sku: string;
  robot_type: string;
  serial_number?: string | null;
  calibration_revision?: string | null;
  camera_mapping: Record<string, string>;
  calibration_verified: boolean;
  joint_limits_verified: boolean;
  emergency_stop_ready: boolean;
  target_mode: TargetMode;
}

export interface Camera {
  id: string;
  name: string;
  backend: string;
  semantic_name: string;
  width: number;
  height: number;
  fps: number;
  latency_baseline_ms?: number | null;
}

export interface Dataset {
  id: string;
  name: string;
  task: string;
  features: string[];
  camera_mapping: Record<string, string>;
  fps: number;
  episodes: number;
  integrity_status: string;
  created_at: string;
}

export interface Policy {
  id: string;
  name: string;
  policy_type: string;
  checkpoint?: string | null;
  source_dataset_id?: string | null;
  expected_features: string[];
  action_shape: number[];
  compatibility_status: string;
  created_at: string;
}

export interface AgentSession {
  id: string;
  role: string;
  name: string;
  model_provider: string;
  permissions: string[];
  status: string;
}

export interface Scenario {
  id: string;
  name: string;
  robot_type: string;
  backend: string;
  scene: string;
  task: string;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  outcome: string;
}

export interface HilChecklist {
  physical_enabled: boolean;
  software_gate: string;
  checks: Array<{ id: string; label: string; status: string }>;
}

const API_ROOT = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail ?? `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
};
