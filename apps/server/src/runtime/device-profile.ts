import type { ProcessSample } from "./harness/owned-process.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export const deviceProfileOptions = ["auto", "compact", "standard", "workstation"] as const;
export type DeviceProfileOption = (typeof deviceProfileOptions)[number];
type DeviceProfileName = Exclude<DeviceProfileOption, "auto">;

export const deviceProfileLimits = {
  compact: { warmIdleMs: 30_000, maxWarmProcesses: 2, daemonIdleBytes: 600 * MiB, modelRequestLimit: 20 },
  standard: { warmIdleMs: 120_000, maxWarmProcesses: 6, daemonIdleBytes: 1200 * MiB, modelRequestLimit: 32 },
  workstation: { warmIdleMs: 300_000, maxWarmProcesses: 12, daemonIdleBytes: 2500 * MiB, modelRequestLimit: 64 },
} as const;

export function detectedDeviceProfile(physicalBytes: number): DeviceProfileName {
  if (physicalBytes >= 48 * GiB) return "workstation";
  if (physicalBytes >= 24 * GiB) return "standard";
  return "compact";
}

export function effectiveDeviceProfile(configured: DeviceProfileOption, physicalBytes: number, pressure: boolean) {
  const detected = detectedDeviceProfile(physicalBytes);
  const effective = pressure ? "compact" : configured === "auto" ? detected : configured;
  return { configured, detected, effective, pressure, ...deviceProfileLimits[effective] };
}

type PressureSample = ProcessSample & { memoryPressure?: "normal" | "warning" | "critical" };
function availableFraction(available: number | undefined, total: number | undefined) {
  return available !== undefined && total !== undefined && Number.isFinite(available) && available >= 0 && Number.isFinite(total) && total > 0
    ? available / total : undefined;
}

export function updateDevicePressure(previous: boolean, sample: PressureSample, availablePhysical: number) {
  const physical = availableFraction(availablePhysical, sample.totalPhysical);
  const commit = availableFraction(sample.availableCommit, sample.totalCommit);
  if (sample.memoryPressure === "warning" || sample.memoryPressure === "critical" ||
      (physical !== undefined && physical < 0.1) || (commit !== undefined && commit < 0.1)) return true;
  if (!previous) return false;
  // An unavailable physical sample cannot affirm that a pressured device recovered.
  return physical === undefined || physical <= 0.18 || (commit !== undefined && commit <= 0.18);
}
