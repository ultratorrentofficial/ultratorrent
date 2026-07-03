import { Injectable } from '@nestjs/common';
import { ModuleRegistryService } from './module-registry.service';

export interface ModuleHealth {
  id: string;
  status: 'healthy' | 'disabled' | 'locked' | 'degraded';
  enabled: boolean;
  licensed: boolean;
  unmetDependencies: string[];
  checkedAt: string;
}

@Injectable()
export class ModuleHealthService {
  constructor(private readonly registry: ModuleRegistryService) {}

  get(id: string): ModuleHealth {
    const s = this.registry.getStatus(id);
    const checkedAt = new Date().toISOString();
    if (!s) {
      return { id, status: 'degraded', enabled: false, licensed: false, unmetDependencies: [], checkedAt };
    }
    let status: ModuleHealth['status'];
    if (!s.licensed) status = 'locked';
    else if (s.enabled) status = 'healthy';
    else if (s.unmetDependencies.length) status = 'degraded';
    else status = 'disabled';
    return {
      id,
      status,
      enabled: s.enabled,
      licensed: s.licensed,
      unmetDependencies: s.unmetDependencies,
      checkedAt,
    };
  }

  all(): ModuleHealth[] {
    return this.registry.getStatuses().map((s) => this.get(s.id));
  }
}
