import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { AuditService } from '../audit/audit.service';
import { getNotificationProvider, providerCatalog, secretFieldsFor } from './provider-registry';
import type { NotificationKind, NotificationProviderConfig } from './notification-provider';

const MASK = '••••••••';

/** Manages notification channels: encrypted provider config, health, testing. */
@Injectable()
export class NotificationChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: SecretCipher,
    private readonly audit: AuditService,
  ) {}

  providers() {
    return providerCatalog();
  }

  /** Encrypt secret fields, preserving any not re-sent (blank/masked = keep). */
  private encryptConfig(kind: NotificationKind, incoming: Record<string, unknown>, prev?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(prev ?? {}), ...incoming };
    const secrets = secretFieldsFor(kind);
    for (const f of secrets) {
      const v = incoming[f];
      if (v == null || v === '' || v === MASK) {
        // keep previously-stored ciphertext
        out[f] = prev?.[f];
      } else {
        out[f] = this.cipher.encrypt(String(v));
      }
    }
    out.__encrypted = secrets;
    return out;
  }

  /** Decrypt secret fields for use by a provider. */
  decryptConfig(channel: Pick<NotificationChannel, 'config'>): NotificationProviderConfig {
    const cfg = { ...(channel.config as Record<string, unknown>) };
    const secrets = (cfg.__encrypted as string[]) ?? [];
    for (const f of secrets) {
      if (typeof cfg[f] === 'string' && cfg[f]) {
        try { cfg[f] = this.cipher.decrypt(cfg[f] as string); } catch { cfg[f] = ''; }
      }
    }
    delete cfg.__encrypted;
    return cfg;
  }

  /** Strip secret values for API responses. */
  private redact(channel: NotificationChannel) {
    const cfg = { ...(channel.config as Record<string, unknown>) };
    const secrets = (cfg.__encrypted as string[]) ?? [];
    for (const f of secrets) {
      if (cfg[f]) cfg[f] = MASK;
    }
    delete cfg.__encrypted;
    return { ...channel, config: cfg };
  }

  async list() {
    const rows = await this.prisma.notificationChannel.findMany({ orderBy: [{ priority: 'desc' }, { name: 'asc' }] });
    return rows.map((c) => this.redact(c));
  }

  async get(id: string) {
    const row = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Channel not found');
    return this.redact(row);
  }

  async create(input: Record<string, unknown>, userId?: string) {
    const provider = String(input.provider ?? '') as NotificationKind;
    if (!provider) throw new BadRequestException('provider is required');
    const p = getNotificationProvider(provider); // throws on unknown kind
    const config = this.encryptConfig(provider, (input.config as Record<string, unknown>) ?? {});
    const valid = p.validateConfiguration(this.decryptConfig({ config } as NotificationChannel));
    const row = await this.prisma.notificationChannel.create({
      data: {
        name: String(input.name ?? p.kind),
        description: (input.description as string) ?? null,
        provider,
        enabled: input.enabled !== false,
        isDefault: Boolean(input.isDefault),
        priority: Number(input.priority ?? 0),
        config: config as object,
        capabilities: p.capabilities() as object,
        rateLimitPerMin: (input.rateLimitPerMin as number) ?? null,
        retryPolicy: ((input.retryPolicy as object) ?? {}) as object,
        quietHours: ((input.quietHours as object) ?? {}) as object,
        allowedEvents: ((input.allowedEvents as object) ?? []) as object,
        allowedGroupIds: ((input.allowedGroupIds as object) ?? []) as object,
        healthStatus: valid.ok ? 'unknown' : 'degraded',
      },
    });
    await this.audit.record({ userId, action: 'notification.channel.created', objectType: 'notification_channel', objectId: row.id });
    return this.redact(row);
  }

  async update(id: string, input: Record<string, unknown>, userId?: string) {
    const existing = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Channel not found');
    const provider = (input.provider as NotificationKind) ?? (existing.provider as NotificationKind);
    const data: Record<string, unknown> = {};
    if (input.name != null) data.name = String(input.name);
    if (input.description !== undefined) data.description = input.description;
    if (input.enabled != null) data.enabled = Boolean(input.enabled);
    if (input.isDefault != null) data.isDefault = Boolean(input.isDefault);
    if (input.priority != null) data.priority = Number(input.priority);
    if (input.rateLimitPerMin !== undefined) data.rateLimitPerMin = input.rateLimitPerMin;
    if (input.retryPolicy !== undefined) data.retryPolicy = input.retryPolicy;
    if (input.quietHours !== undefined) data.quietHours = input.quietHours;
    if (input.allowedEvents !== undefined) data.allowedEvents = input.allowedEvents;
    if (input.allowedGroupIds !== undefined) data.allowedGroupIds = input.allowedGroupIds;
    if (input.config !== undefined) {
      data.config = this.encryptConfig(provider, (input.config as Record<string, unknown>) ?? {}, existing.config as Record<string, unknown>) as object;
    }
    const row = await this.prisma.notificationChannel.update({ where: { id }, data });
    await this.audit.record({ userId, action: 'notification.channel.updated', objectType: 'notification_channel', objectId: id });
    return this.redact(row);
  }

  async remove(id: string, userId?: string) {
    await this.prisma.notificationChannel.delete({ where: { id } });
    await this.audit.record({ userId, action: 'notification.channel.deleted', objectType: 'notification_channel', objectId: id });
    return { ok: true };
  }

  async testConnection(id: string) {
    const row = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Channel not found');
    const provider = getNotificationProvider(row.provider as NotificationKind);
    const result = await provider.testConnection(this.decryptConfig(row));
    await this.prisma.notificationChannel.update({
      where: { id },
      data: { healthStatus: result.status, lastHealthCheckAt: new Date(), lastError: result.error ?? null },
    });
    return result;
  }
}
