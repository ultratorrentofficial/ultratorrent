import { MediaServerSyncService } from './media-server-sync.service';

/** Minimal in-memory table with the handful of Prisma methods the sync uses. */
class Table {
  rows: any[] = [];
  private seq = 0;
  async create({ data }: any) {
    const row = { id: `id-${++this.seq}`, ...data };
    this.rows.push(row);
    return row;
  }
  async update({ where, data }: any) {
    const row = this.rows.find((r) => r.id === where.id);
    Object.assign(row, data);
    return row;
  }
  async delete({ where }: any) {
    this.rows = this.rows.filter((r) => r.id !== where.id);
  }
  async findMany({ where }: any = {}) {
    if (where?.connectionId) return this.rows.filter((r) => r.connectionId === where.connectionId);
    if (where?.isEnabled !== undefined) return this.rows.filter((r) => r.isEnabled === where.isEnabled);
    return this.rows;
  }
  async findUnique({ where }: any) {
    const key = where.connectionId_providerLibraryId;
    if (key) return this.rows.find((r) => r.connectionId === key.connectionId && r.providerLibraryId === key.providerLibraryId) ?? null;
    return this.rows.find((r) => r.id === where.id) ?? null;
  }
  async findFirst({ where }: any) {
    return this.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
  }
}

/** Watch-history table with a groupBy that mirrors the users derivation. */
class HistoryTable {
  constructor(public rows: any[]) {}
  async groupBy({ by }: any) {
    const key = (r: any) => by.map((k: string) => r[k]).join('|');
    const groups = new Map<string, any[]>();
    for (const r of this.rows) {
      if (!r.userName) continue;
      const k = key(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    return [...groups.values()].map((gr) => ({
      connectionId: gr[0].connectionId ?? null,
      userName: gr[0].userName,
      _count: { _all: gr.length },
      _max: {
        startedAt: gr.reduce((m, r) => (!m || r.startedAt > m ? r.startedAt : m), null),
        providerUserId: gr[0].providerUserId ?? null,
      },
    }));
  }
}

function makeService(opts: {
  connections?: any[];
  libraries?: { supported: boolean; libraries: any[]; message?: string };
  history?: any[];
  existingLibraries?: any[];
}) {
  const integrationTable = new Table();
  integrationTable.rows = opts.connections ?? [{ id: 'srv-a', isEnabled: true }];
  const libraryTable = new Table();
  libraryTable.rows = opts.existingLibraries ?? [];
  const userTable = new Table();
  const runTable = new Table();

  const prisma = {
    mediaServerIntegration: integrationTable,
    mediaServerLibrary: libraryTable,
    mediaServerUser: userTable,
    mediaProviderSyncRun: runTable,
    mediaServerWatchHistory: new HistoryTable(opts.history ?? []),
  };
  const integrations = {
    libraries: async () => opts.libraries ?? { supported: true, libraries: [] },
  };
  const realtime = { broadcast: () => undefined };
  const registry = { getStatus: () => ({ enabled: true }) };
  const svc = new MediaServerSyncService(prisma as any, integrations as any, realtime as any, registry as any);
  return { svc, libraryTable, userTable, runTable };
}

describe('MediaServerSyncService', () => {
  it('upserts synced libraries and prunes ones that vanished', async () => {
    const { svc, libraryTable, runTable } = makeService({
      existingLibraries: [
        { id: 'lib-old', connectionId: 'srv-a', providerLibraryId: '99', name: 'Removed', type: 'movie' },
        { id: 'lib-keep', connectionId: 'srv-a', providerLibraryId: '1', name: 'Old Name', type: 'movie' },
      ],
      libraries: { supported: true, libraries: [
        { id: '1', name: 'Movies', type: 'movie', itemCount: 500 },
        { id: '2', name: 'TV', type: 'show' },
      ] },
    });
    const count = await svc.syncConnectionLibraries('srv-a');
    expect(count).toBe(2);
    const names = libraryTable.rows.map((r) => r.name).sort();
    expect(names).toEqual(['Movies', 'TV']); // 'Removed' pruned, '1' renamed to Movies
    expect(libraryTable.rows.find((r) => r.providerLibraryId === '1')).toMatchObject({ name: 'Movies', itemCount: 500 });
    expect(runTable.rows[0]).toMatchObject({ type: 'libraries', status: 'success', librariesSynced: 2 });
  });

  it('records a partial run when the provider cannot list libraries', async () => {
    const { svc, runTable } = makeService({ libraries: { supported: false, libraries: [], message: 'Kodi unsupported' } });
    const count = await svc.syncConnectionLibraries('srv-a');
    expect(count).toBe(0);
    expect(runTable.rows[0]).toMatchObject({ status: 'partial', message: 'Kodi unsupported' });
  });

  it('derives users from watch history with play counts + last seen', async () => {
    const { svc, userTable } = makeService({
      history: [
        { connectionId: 'srv-a', userName: 'alice', startedAt: new Date('2026-07-01') },
        { connectionId: 'srv-a', userName: 'alice', startedAt: new Date('2026-07-05') },
        { connectionId: 'srv-a', userName: 'bob', startedAt: new Date('2026-07-02') },
        { connectionId: null, userName: null, startedAt: new Date('2026-07-02') }, // ignored
      ],
    });
    const count = await svc.syncUsers();
    expect(count).toBe(2);
    const alice = userTable.rows.find((r) => r.userName === 'alice');
    expect(alice).toMatchObject({ plays: 2, connectionId: 'srv-a' });
    expect(alice.lastSeenAt).toEqual(new Date('2026-07-05'));
  });

  it('syncAll aggregates libraries + users across connections', async () => {
    const { svc } = makeService({
      connections: [{ id: 'srv-a', isEnabled: true }],
      libraries: { supported: true, libraries: [{ id: '1', name: 'Movies', type: 'movie' }] },
      history: [{ connectionId: 'srv-a', userName: 'alice', startedAt: new Date() }],
    });
    const res = await svc.syncAll();
    expect(res).toMatchObject({ connections: 1, librariesSynced: 1, usersSynced: 1 });
  });
});
