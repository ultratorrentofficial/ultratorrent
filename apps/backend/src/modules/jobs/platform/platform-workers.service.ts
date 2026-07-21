import { Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

export interface WorkerInfo {
  id: string;
  host: string;
  status: 'online' | 'draining' | 'lost';
  startedAt: string;
  version: string | null;
  runningJobs: number;
  /** null = no fixed cap (the current in-process model runs work inline). */
  capacity: number | null;
  supportedQueues: string[];
  inProcess: boolean;
}

/**
 * Worker inventory. UltraTorrent currently runs a **single in-process worker** (job
 * bodies execute inline in the API process — no external broker). This service
 * represents that honestly: one worker keyed by host + pid, its uptime, and the live
 * count of jobs it is running. It does NOT invent a worker pool or fabricated
 * capacity/utilization; the `WorkerInfo` shape is ready for a future multi-worker
 * deployment without pretending one exists today.
 */
@Injectable()
export class PlatformWorkersService {
  private readonly startedAt = new Date();

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<WorkerInfo[]> {
    const runningJobs = await this.prisma.platformJob.count({ where: { status: 'running' } });
    return [
      {
        id: `${hostname()}:${process.pid}`,
        host: hostname(),
        status: 'online',
        startedAt: this.startedAt.toISOString(),
        version: process.env.ULTRATORRENT_VERSION ?? process.env.npm_package_version ?? null,
        runningJobs,
        capacity: null,
        supportedQueues: ['default'],
        inProcess: true,
      },
    ];
  }
}
