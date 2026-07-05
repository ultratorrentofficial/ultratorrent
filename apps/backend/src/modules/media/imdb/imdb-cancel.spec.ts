import { ForbiddenException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { IMDB_DATASET_FILES } from './imdb-tsv';
import { ImdbDatasetImporterService } from './imdb-dataset-importer.service';
import { ImdbOptimizedImportService } from './imdb-optimized-import.service';

// Isolated from imdb.spec.ts so these cancellation tests own their fixtures and
// track the current service constructor signatures independently.

function filePathStub(root: string) {
  return {
    assertWithinHardRoots: (requested: string) => {
      const abs = path.resolve(requested);
      if (abs === root || abs.startsWith(root + path.sep)) return abs;
      throw new ForbiddenException('Path is outside the allowed storage roots.');
    },
  } as any;
}

const noopAudit = { record: jest.fn().mockResolvedValue(undefined) } as any;
const noopRealtime = { broadcast: jest.fn() } as any;

const tsv = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.join('\t')).join('\n') + '\n', 'utf8');
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'imdb-cancel-'));

describe('IMDb import cooperative cancellation', () => {
  it('legacy importFile throws and stops at the first batch when cancel is requested', async () => {
    const dir = await tmpDir();
    const abs = path.join(dir, 'title.basics.tsv.gz');
    const header = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!.header;
    // >1 batch (legacy BATCH_SIZE=1000) so a mid-file checkpoint is reached.
    const rows = Array.from({ length: 1500 }, (_, i) => [
      `tt${i}`, 'movie', `T${i}`, `T${i}`, '0', '2000', '\\N', '90', 'Drama',
    ]);
    await fs.writeFile(abs, gzipSync(tsv([header, ...rows])));

    const prisma = {
      iMDbTitle: { createMany: jest.fn().mockResolvedValue({ count: 1000 }) },
    } as any;
    // settingsSvc + optimized are unused by importFile → minimal stubs.
    const importer = new ImdbDatasetImporterService(
      prisma,
      filePathStub(dir),
      noopAudit,
      noopRealtime,
      {} as any,
      {} as any,
    );
    const spec = IMDB_DATASET_FILES.find((f) => f.key === 'title.basics')!;

    await expect(importer.importFile(spec, abs, () => true)).rejects.toThrow(/stopped by user/i);
    expect(prisma.iMDbTitle.createMany).toHaveBeenCalledTimes(1); // only the first batch committed
    expect(prisma.iMDbTitle.createMany.mock.calls[0][0].data).toHaveLength(1000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stopImport throws when no import is running', async () => {
    const prisma = {
      iMDbDatasetImport: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const importer = new ImdbDatasetImporterService(
      prisma,
      filePathStub('/media/allowed'),
      noopAudit,
      noopRealtime,
      {} as any,
      {} as any,
    );
    await expect(importer.stopImport()).rejects.toThrow(/no imdb dataset import/i);
  });

  it('stopImport flags the active run so the worker can observe it', async () => {
    const prisma = {
      iMDbDatasetImport: {
        findFirst: jest.fn().mockResolvedValue({ id: 'imp1', status: 'running', recordsImported: 7 }),
      },
    } as any;
    const realtime = { broadcast: jest.fn() } as any;
    const importer = new ImdbDatasetImporterService(
      prisma,
      filePathStub('/media/allowed'),
      noopAudit,
      realtime,
      {} as any,
      {} as any,
    );
    const flagged = await importer.stopImport();
    expect(flagged.id).toBe('imp1');
    // Emits a 'stopping' progress nudge so the UI reflects intent immediately.
    expect(realtime.broadcast).toHaveBeenCalledWith(
      'imdb.dataset.import.progress',
      expect.objectContaining({ id: 'imp1', status: 'stopping' }),
    );
  });

  it('optimized import honours the stop flag and marks the row cancelled (not completed)', async () => {
    const updates: any[] = [];
    const prisma = {
      iMDbDatasetImport: { update: jest.fn(async ({ data }: any) => updates.push(data)) },
    } as any;
    const realtime = { broadcast: jest.fn() } as any;
    const config = { get: () => 2 } as any; // tiny batch size
    const settings = {
      importStrategy: 'optimized_movies',
      minImportYear: 1900,
      importAkas: false,
      importCrew: false,
      importPeople: false,
    } as any;
    const svc = new ImdbOptimizedImportService(
      prisma,
      filePathStub('/media/allowed'),
      noopAudit,
      realtime,
      config,
    );

    // Cancel requested from the outset → caught at the first step boundary.
    await svc.execute('imp1', '/media/allowed/imdb', settings, {}, () => true);

    expect(updates.some((u) => u.status === 'cancelled')).toBe(true);
    expect(updates.some((u) => u.status === 'completed')).toBe(false);
    expect(realtime.broadcast).toHaveBeenCalledWith(
      'imdb.dataset.import.cancelled',
      expect.objectContaining({ id: 'imp1', status: 'cancelled' }),
    );
  });
});
