import { cpus, freemem, totalmem } from "node:os";

export type SystemStats = {
  cpuPercent: number | null;
  memoryPercent: number;
  usedMemoryGb: number;
  totalMemoryGb: number;
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
