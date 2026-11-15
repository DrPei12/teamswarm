export type ServiceStatus =
  | "starting"
  | "running"
  | "switching"
  | "stopping"
  | "stopped"
  | "failed"
  | "recovery_required";

export interface PreviewReadiness {
  path: string;
  contains: string;
}

export interface DevelopmentPreview {
  framework: "vite" | "next";
  script: string;
  ready: PreviewReadiness;
}

export interface ServiceExecutionPolicy {
  harness: string;
  boundary: "device-account";
}

export interface ManagedService {
  id: string;
  teamId: string;
  branchId: string;
  name: string;
  kind: "preview";
  version: number;
  generation: number;
  status: ServiceStatus;
  creatorId: string;
  ownerId: string;
  usage?: "work" | "handoff" | "project";
  workId: string;
  workspace: string;
  directory: string;
  url: string | null;
  pid: number | null;
  nativePid: number | null;
  retained: boolean;
  handoffWorkId: string | null;
  restartedAs?: string;
  createdAt: string;
  updatedAt: string;
  stoppedBy?: "user" | "worker" | "automatic" | "shutdown";
  error?: string;
  workingSetBytes?: number;
  privateBytes?: number;
  processCount?: number;
  development?: DevelopmentPreview;
  runtimeDirectory?: string;
  backendPid?: number;
  nativeCommand?: string[];
}

export interface ServicePolicy {
  version: number;
  autoRelease: boolean;
}

export interface ServiceSuggestion {
  id: string;
  teamId: string;
  serviceId: string;
  serviceVersion: number;
  status: "pending" | "ready" | "failed" | "dismissed";
  text?: string;
  model?: string;
  createdAt: string;
}

export interface ServiceListing {
  error?: string;
  policy: ServicePolicy;
  services: ManagedService[];
  suggestion: ServiceSuggestion | null;
}
