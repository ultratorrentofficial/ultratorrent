import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { MODULE_IDS, OPERATIONS_DOMAINS, PERMISSIONS, ROLE_PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { ALL_MANIFESTS } from '../module-registry/manifests';
import { PERMISSIONS_KEY } from '../../common/decorators/permissions.decorator';
import { OperationsController } from './operations.controller';

/**
 * The console is an observability client, never a management client.
 *
 * That claim is made in the architecture doc and in the module's own comments,
 * and a comment is not a control. These tests are the control: the module may
 * not grow a mutating route, and its one permission may not become a skeleton
 * key. Both are the kind of thing a well-meaning change adds without noticing.
 */

const MODULE_DIR = __dirname;

function sourceFiles(): string[] {
  return readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => join(MODULE_DIR, f));
}

describe('operations module — read-only by construction', () => {
  it('declares no mutating HTTP verb anywhere in the module', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const verb of ['@Post', '@Put', '@Patch', '@Delete']) {
        if (source.includes(`${verb}(`)) offenders.push(`${file}: ${verb}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every route on the controller is a GET', () => {
    const proto = OperationsController.prototype as unknown as Record<string, object>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    const routes = handlers.filter((name) =>
      Reflect.hasMetadata(PATH_METADATA, proto[name] as object),
    );

    expect(routes.length).toBeGreaterThan(0);
    for (const name of routes) {
      expect(Reflect.getMetadata(METHOD_METADATA, proto[name] as object)).toBe(RequestMethod.GET);
    }
  });

  it('writes to no database table of its own', () => {
    // The module composes services; a `prisma.<model>.create/update/delete`
    // here would mean it had started owning state, which is the line it must
    // not cross. Reads (`findMany`, `count`) are the whole point and stay
    // allowed. Anchored on the prisma call itself rather than searched for
    // file-wide: `Map.delete` is not a database write, and a check that cannot
    // tell them apart is one someone eventually disables.
    const write = /prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw/;
    const offenders = sourceFiles().filter((file) => write.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('operations controller — the console permission is a door, not a key', () => {
  it('requires console.view on the controller', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, OperationsController)).toEqual([
      PERMISSIONS.CONSOLE_VIEW,
    ]);
  });

  it('reports only the domains the caller may read, not every domain', () => {
    const permitted = ['system', 'alerts'];
    const controller = new OperationsController(
      { permittedDomains: () => permitted } as never,
      {
        version: () => ({
          product: 'UltraTorrent',
          version: '0.85.7',
          apiVersion: 'v1',
          gitSha: 'abc',
          gitTag: 'v0.85.7',
          buildTime: null,
          edition: 'community',
          node: 'v20',
        }),
      } as never,
    );

    const caps = controller.capabilities({
      id: 'u1',
      username: 'operator',
      roles: [SystemRole.READ_ONLY],
      permissions: [PERMISSIONS.CONSOLE_VIEW, PERMISSIONS.SYSTEM_VIEW],
    });

    expect(caps.availableDomains).toEqual([...OPERATIONS_DOMAINS]);
    expect(caps.permittedDomains).toEqual(permitted);
    expect(caps.eventChannel).toBe('operations.event');
    expect(caps.limits.maxItemsPerDomain).toBeGreaterThan(0);
  });
});

describe('operations controller — query parsing', () => {
  const controller = () =>
    new OperationsController({ snapshot: async (_u: unknown, o: unknown) => o } as never, {} as never);

  const user = {
    id: 'u1',
    username: 'operator',
    roles: [],
    permissions: [PERMISSIONS.CONSOLE_VIEW],
  };

  it('rejects an unknown domain rather than silently returning nothing', () => {
    // Thrown synchronously, before the service is reached: a bad request must
    // not cost a snapshot.
    expect(() => controller().snapshot(user, 'system,torrentz')).toThrow(BadRequestException);
  });

  it('accepts a known domain list, trimming whitespace', async () => {
    const opts = (await controller().snapshot(user, ' system , alerts ')) as unknown as {
      domains: string[];
    };
    expect(opts.domains).toEqual(['system', 'alerts']);
  });

  it('treats an empty domains parameter as "all", not as "none"', async () => {
    const opts = (await controller().snapshot(user, '')) as unknown as { domains?: string[] };
    expect(opts.domains).toBeUndefined();
  });

  it('rejects a limit that is not a number instead of silently defaulting', () => {
    expect(() => controller().snapshot(user, undefined, 'all')).toThrow(BadRequestException);
  });
});


describe('operations module — console.view reaches a deployed database', () => {
  /*
   * The container runs `prisma migrate deploy` and never the seed, so
   * `ModulePermissionSyncService` is the only thing that creates a NEW
   * permission on an upgraded install — and it reads module MANIFESTS, not the
   * shared PERMISSIONS constant. A permission that exists in code and in no
   * manifest exists nowhere in that database: every non-SUPER_ADMIN gets a 403
   * on these routes forever, and it is invisible to whoever deployed it because
   * SUPER_ADMIN bypasses the guard entirely.
   */
  it('is declared by the operations manifest, which is what creates it on deploy', () => {
    const manifest = ALL_MANIFESTS.find((m) => m.id === MODULE_IDS.OPERATIONS);
    expect(manifest).toBeDefined();
    expect(manifest!.permissions).toContain(PERMISSIONS.CONSOLE_VIEW);
  });

  it('is granted to the roles that are supposed to hold it', () => {
    // The sync grants a fresh permission to whichever system roles
    // ROLE_PERMISSIONS names, so an empty list here would catalogue the key and
    // give it to nobody.
    for (const role of [SystemRole.READ_ONLY, SystemRole.USER, SystemRole.POWER_USER]) {
      expect(ROLE_PERMISSIONS[role]).toContain(PERMISSIONS.CONSOLE_VIEW);
    }
  });
});
