import { Injectable } from '@nestjs/common';
import type { NotificationRule } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface RuleCondition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in' | 'exists' | 'regex';
  value?: unknown;
}

function getField(payload: Record<string, unknown>, field: string): unknown {
  if (field in payload) return payload[field];
  // dot path support
  return field.split('.').reduce<unknown>((acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), payload);
}

/**
 * Evaluate a rule's conditions (AND) against an event payload. Pure + testable.
 * An empty condition list always matches.
 */
export function evaluateConditions(conditions: RuleCondition[], payload: Record<string, unknown>): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((c) => {
    const actual = getField(payload, c.field);
    switch (c.op) {
      case 'eq': return actual === c.value;
      case 'neq': return actual !== c.value;
      case 'gt': return Number(actual) > Number(c.value);
      case 'gte': return Number(actual) >= Number(c.value);
      case 'lt': return Number(actual) < Number(c.value);
      case 'lte': return Number(actual) <= Number(c.value);
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
      case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
      case 'exists': return actual != null && actual !== '';
      case 'regex': try { return new RegExp(String(c.value), 'i').test(String(actual ?? '')); } catch { return false; }
      default: return false;
    }
  });
}

@Injectable()
export class NotificationRuleEngineService {
  constructor(private readonly prisma: PrismaService) {}

  /** Enabled rules whose trigger event + conditions match, highest priority first. */
  async match(event: string, payload: Record<string, unknown>): Promise<NotificationRule[]> {
    const rules = await this.prisma.notificationRule.findMany({
      where: { enabled: true, event },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    return rules.filter((r) => evaluateConditions((r.conditions as unknown as RuleCondition[]) ?? [], payload));
  }
}
