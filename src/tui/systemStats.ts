import { cpus, freemem, totalmem } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const gpuStatsRetryDelayMs = 60_000;
let gpuProbeDisabledUntil = 0;

export type SystemStats = {
  cpuPercent: number | null;
  memoryPercent: number;
  usedMemoryGb: number;
  totalMemoryGb: number;
};

export type GpuStats = {
  name: string;
  utilizationPercent: number;
  usedMemoryGb: number;
  totalMemoryGb: number;
  temperatureCelsius: number | null;
  powerDrawWatts: number | null;
  powerLimitWatts: number | null;
};

type CpuSnapshot = {
  idle: number;
  total: number;
};

export function readSystemStats(previousSnapshot?: CpuSnapshot): {
  stats: SystemStats;
  snapshot: CpuSnapshot;
} {
  const snapshot = readCpuSnapshot();
  const totalMemory = totalmem();
  const freeMemory = freemem();
  const usedMemory = totalMemory - freeMemory;

  return {
    snapshot,
    stats: {
      cpuPercent: previousSnapshot ? calculateCpuPercent(previousSnapshot, snapshot) : null,
      memoryPercent: Math.round((usedMemory / totalMemory) * 100),
      usedMemoryGb: bytesToGb(usedMemory),
      totalMemoryGb: bytesToGb(totalMemory)
    }
  };
}

function readCpuSnapshot(): CpuSnapshot {
  return cpus().reduce<CpuSnapshot>(
    (snapshot, cpu) => {
      const idle = cpu.times.idle;
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);

      return {
        idle: snapshot.idle + idle,
        total: snapshot.total + total
      };
    },
    {
      idle: 0,
      total: 0
    }
  );
}

function calculateCpuPercent(previousSnapshot: CpuSnapshot, currentSnapshot: CpuSnapshot): number {
  const idleDelta = currentSnapshot.idle - previousSnapshot.idle;
  const totalDelta = currentSnapshot.total - previousSnapshot.total;

  if (totalDelta <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

function bytesToGb(value: number): number {
  return Math.round((value / 1024 ** 3) * 10) / 10;
}

export async function readGpuStats(): Promise<GpuStats | null> {
  if (Date.now() < gpuProbeDisabledUntil) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
      "--format=csv,noheader,nounits"
    ]);
    const firstGpuLine = stdout.trim().split(/\r?\n/)[0];
    if (!firstGpuLine) {
      return null;
    }

    const [name, utilization, memoryUsed, memoryTotal, temperature, powerDraw, powerLimit] = firstGpuLine
      .split(",")
      .map((value) => value.trim());

    return {
      name,
      utilizationPercent: readNumber(utilization),
      usedMemoryGb: mibToGb(readNumber(memoryUsed)),
      totalMemoryGb: mibToGb(readNumber(memoryTotal)),
      temperatureCelsius: readNullableNumber(temperature),
      powerDrawWatts: readNullableNumber(powerDraw),
      powerLimitWatts: readNullableNumber(powerLimit)
    };
  } catch {
    gpuProbeDisabledUntil = Date.now() + gpuStatsRetryDelayMs;
    return null;
  }
}

function mibToGb(value: number): number {
  return Math.round((value / 1024) * 10) / 10;
}

function readNumber(value: string | undefined): number {
  const parsedValue = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

function readNullableNumber(value: string | undefined): number | null {
  const parsedValue = Number.parseFloat(value ?? "");
  return Number.isFinite(parsedValue) ? parsedValue : null;
}
