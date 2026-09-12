import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

/**
 * A best-effort distributed lock, with an in-process fallback.
 *
 * The first Redis usage in the codebase, and deliberately optional: Redis is a
 * declared dependency but many self-hosted deployments run a single backend
 * replica with no Redis at all. So `withLock` uses a Redis `SET NX PX` lease when
 * Redis is reachable — which makes an action single-flight across replicas — and
 * otherwise falls back to a per-process guard, which is correct for a single
 * replica (the only place two workers could contend is a multi-replica install,
 * and that is exactly when Redis is present). A Redis error at runtime disables
 * Redis for the rest of the process and drops to the in-process guard rather than
 * stalling the caller.
 */
@Injectable()
export class DistributedLockService implements OnModuleDestroy {
  private readonly logger = new Logger(DistributedLockService.name);
  private client: Redis | null = null;
  private redisDisabled = false;
  private readonly localLocks = new Set<string>();

  constructor(private readonly config: ConfigService) {}

  /** Whether the last lock attempt used Redis (for status/tests). */
  usesRedis(): boolean {
    return this.client !== null && !this.redisDisabled;
  }

  private ensureClient(): Redis | null {
    if (this.redisDisabled) return null;
    if (this.client) return this.client;
    try {
      const host = this.config.get<string>('redis.host') ?? '127.0.0.1';
      const port = this.config.get<number>('redis.port') ?? 6379;
      const client = new Redis({
        host,
        port,
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        maxRetriesPerRequest: 1,
        // No reconnection storm: if Redis is absent, give up quietly and let the
        // in-process fallback take over.
        retryStrategy: () => null,
      });
      // A connection error must never crash the process; disable and fall back.
      client.on('error', () => this.disableRedis());
      this.client = client;
      return client;
    } catch {
      this.disableRedis();
      return null;
    }
  }

  private disableRedis(): void {
    if (this.redisDisabled) return;
    this.redisDisabled = true;
    this.logger.warn('Redis unavailable — stream-enforcement locking falls back to an in-process guard (correct for a single replica).');
    try {
      this.client?.disconnect();
    } catch {
      // already gone
    }
    this.client = null;
  }

  /**
   * Run `fn` while holding an exclusive lock on `key`. Returns `{ ran: false }`
   * without calling `fn` when the lock is already held elsewhere. `ttlMs` bounds
   * how long a crashed holder can block others (Redis auto-expires the lease).
   */
  async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
    const client = this.ensureClient();
    if (client) {
      const token = randomUUID();
      try {
        const acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
        if (acquired !== 'OK') return { ran: false };
        try {
          return { ran: true, result: await fn() };
        } finally {
          await this.releaseRedis(client, key, token);
        }
      } catch {
        // Redis went away mid-flight — disable it and drop to the local guard so
        // enforcement still runs on this replica.
        this.disableRedis();
      }
    }
    // In-process fallback.
    if (this.localLocks.has(key)) return { ran: false };
    this.localLocks.add(key);
    try {
      return { ran: true, result: await fn() };
    } finally {
      this.localLocks.delete(key);
    }
  }

  /** Delete the lease only if we still own it (a crashed holder's expired lease
   * may have been re-acquired by someone else in the meantime). */
  private async releaseRedis(client: Redis, key: string, token: string): Promise<void> {
    const lua = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    try {
      await client.eval(lua, 1, key, token);
    } catch {
      // A failed release just means the lease expires on its own.
    }
  }

  onModuleDestroy(): void {
    try {
      this.client?.disconnect();
    } catch {
      // nothing to clean up
    }
  }
}
