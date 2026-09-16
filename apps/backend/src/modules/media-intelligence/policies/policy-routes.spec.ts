import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PERMISSIONS, ROLE_PERMISSIONS, SystemRole } from '@ultratorrent/shared';

import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { MediaIntelligenceController } from '../media-intelligence.controller';

/**
 * Lifecycle policies: who may author intent, and what the module may do with it.
 *
 * Phase 5 explains what UltraTorrent should maintain and maintains nothing.
 * That claim lives in comments and in a doc, and neither is a control. These
 * are the control: authoring stays behind its own permission, reading stays
 * open to anyone who can already see the library, and the policy surface may
 * not quietly grow a route that acts on media.
 */

const MODULE_DIR = join(__dirname, '..');

type Handler = { name: string; path: string; method: number; permissions: string[] };

/** Every route declared on the controller, with its verb and permissions. */
function routes(): Handler[] {
  const proto = MediaIntelligenceController.prototype as unknown as Record<string, object>;
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== 'constructor')
    .filter((n) => Reflect.hasMetadata(PATH_METADATA, proto[n]))
    .map((name) => ({
      name,
      path: Reflect.getMetadata(PATH_METADATA, proto[name]) as string,
      method: Reflect.getMetadata(METHOD_METADATA, proto[name]) as number,
      permissions: (Reflect.getMetadata(PERMISSIONS_KEY, proto[name]) as string[]) ?? [],
    }));
}

const policyRoutes = () => routes().filter((r) => r.path.startsWith('policies'));

describe('lifecycle policy routes — authoring is its own privilege', () => {
  it('guards every policy mutation with the authoring permission', () => {
    const mutations = policyRoutes().filter((r) => r.method !== RequestMethod.GET);
    // Create, update, delete. Preview is a POST but not a mutation; it is
    // asserted separately below.
    const authoring = mutations.filter((r) => r.path !== 'policies/preview');

    expect(authoring.length).toBeGreaterThan(0);
    for (const route of authoring) {
      expect(route.permissions).toEqual([PERMISSIONS.MEDIA_LIFECYCLE_POLICY_MANAGE]);
    }
  });

  it('leaves reads on the permission that already sees the library', () => {
    for (const route of policyRoutes().filter((r) => r.method === RequestMethod.GET)) {
      expect(route.permissions).toEqual([PERMISSIONS.MEDIA_MANAGER_VIEW]);
    }
  });

  it('gates preview on view, not on authoring', () => {
    const preview = policyRoutes().find((r) => r.path === 'policies/preview');
    // Requiring the authoring permission would stop an operator checking a
    // policy before asking someone for one; preview reveals nothing the
    // detail page does not already show.
    expect(preview?.permissions).toEqual([PERMISSIONS.MEDIA_MANAGER_VIEW]);
  });

  it('keeps desired-state and drift readable by anyone who can see the library', () => {
    const reads = routes().filter((r) => r.path.endsWith('desired-state') || r.path.endsWith('drift'));
    expect(reads).toHaveLength(2);
    for (const route of reads) {
      expect(route.method).toBe(RequestMethod.GET);
      expect(route.permissions).toEqual([PERMISSIONS.MEDIA_MANAGER_VIEW]);
    }
  });

  it('declares the literal policy routes before the entity wildcard', () => {
    /*
     * `:entityType/:entityId` swallowed four routes in Phase 3. The repo-wide
     * shadowing gate covers same-verb collisions; this pins the ordering
     * intent locally, where someone adding a sixth policy route will see it.
     */
    const names = routes().map((r) => r.path);
    const lastPolicy = Math.max(...names.map((p, i) => (p.startsWith('policies') ? i : -1)));
    const wildcard = names.indexOf(':entityType/:entityId');
    expect(wildcard).toBeGreaterThan(lastPolicy);
  });
});

describe('lifecycle policies — Power Users cannot author intent', () => {
  it('withholds the authoring permission from every non-admin role', () => {
    for (const role of [SystemRole.POWER_USER, SystemRole.USER, SystemRole.READ_ONLY]) {
      const granted = ROLE_PERMISSIONS[role] ?? [];
      expect(granted).not.toContain(PERMISSIONS.MEDIA_LIFECYCLE_POLICY_MANAGE);
    }
  });

  it('still lets those roles read what the policies concluded', () => {
    // Explainability is not a privilege; acting on it is.
    expect(ROLE_PERMISSIONS[SystemRole.POWER_USER] ?? []).toContain(PERMISSIONS.MEDIA_MANAGER_VIEW);
  });
});

describe('lifecycle policies — the module explains, it does not maintain', () => {
  function policySources(): string[] {
    const dir = join(MODULE_DIR, 'policies');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => join(dir, f));
  }

  it('contains no acquisition, download, delete or move call in the policy layer', () => {
    /*
     * The Phase 5 boundary, enforced rather than asserted. Nothing here may
     * search an indexer, grab a release, or touch a file — that is Phase 6,
     * behind human approval. A well-meaning change adds one of these without
     * noticing it crossed a line.
     */
    const forbidden =
      /\b(grab|addTorrent|download|searchAll|unlink|rmSync|rename|moveFile|deleteFile)\s*\(/;
    const offenders = policySources().filter((f) => forbidden.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('declares no scheduled interval in the policy layer', () => {
    // The 6-hourly reconcile stays the only clock. A second `@Interval` here
    // would be a competing sweep with no name in the manifest.
    const offenders = policySources().filter((f) => /@Interval\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
