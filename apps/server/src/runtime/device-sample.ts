import { cpus, freemem, totalmem, availableParallelism } from "node:os";
import {
  sampleWindowsProcesses,
  type ProcessSample,
} from "./harness/owned-process.js";
import { sampleDarwinProcesses } from "./harness/darwin-supervisor.js";

/** One sampler per product service; no per-member monitoring process. */
export function deviceSampler(): () => Promise<ProcessSample> {
  let previous: { idle: number; total: number } | undefined;
  return async () => {
    const processors = cpus();
    const times = processors.reduce(
      (value, cpu) => ({
        idle: value.idle + cpu.times.idle,
        total:
          value.total + Object.values(cpu.times).reduce((n, t) => n + t, 0),
      }),
      { idle: 0, total: 0 },
    );
    const elapsed = previous ? times.total - previous.total : 0;
    const cpuBusyPercent =
      elapsed > 0
        ? Math.max(
            0,
            Math.min(100, 100 * (1 - (times.idle - previous!.idle) / elapsed)),
          )
        : undefined;
    previous = times;
    let sample: ProcessSample;
    if (process.platform === "win32") sample = { ...await sampleWindowsProcesses(process.pid), supervision: "native" };
    else if (process.platform === "darwin") sample = await sampleDarwinProcesses(process.pid);
    else sample = { totalPhysical: totalmem(), availablePhysical: freemem(), processes: [] };
    return {
      ...sample,
      processCoverage: sample.processCoverage ?? (process.platform === "win32" ? "descendants" : "unavailable"),
      cpuCores: Math.min(processors.length || 1, availableParallelism()),
      cpuModel: processors[0]?.model,
      cpuBusyPercent,
    };
  };
}
