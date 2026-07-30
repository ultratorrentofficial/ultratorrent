/**
 * Validating the dataset without naming a path.
 *
 * Reported as "two different Validate datasets buttons, one which doesn't
 * work". Both post to the same endpoint; the Dataset panel has a text field and
 * sent its contents, while the Optimized Import panel has no field and sent
 * `{}`. That reached `assertWithinHardRoots('')` and came back
 * `400 A path is required.` — reproduced live before changing anything.
 *
 * An empty path means "the configured/managed directory", the same one import
 * and the scheduler use, so all three now agree on what they are validating.
 */
import { ImdbService } from './imdb.service';

function build(configured: string | null) {
  const importer = { validate: jest.fn(async (dir: string) => ({ valid: true, dir })) };
  const settingsSvc = {
    read: jest.fn(async () => ({ datasetPath: configured })),
    update: jest.fn(async () => undefined),
  };
  const filePath = {
    hardRoots: ['/srv/media'],
    assertWithinHardRoots: jest.fn((p: string) => {
      if (!p || !p.trim()) throw new Error('A path is required.');
      return p;
    }),
  };
  // (prisma, settingsSvc, importer, filePath, audit, realtime, settings, moduleRef)
  const svc = new ImdbService(
    {} as never, settingsSvc as never, importer as never, filePath as never,
    {} as never, {} as never, {} as never, {} as never,
  );
  return { svc, importer, settingsSvc, filePath };
}

describe('validateDataset path resolution', () => {
  it('uses the configured directory when no path is given', async () => {
    const { svc, importer } = build('/srv/media/.ultratorrent/imdb-datasets');
    await svc.validateDataset('');
    expect(importer.validate).toHaveBeenCalledWith('/srv/media/.ultratorrent/imdb-datasets', {});
  });

  it('treats whitespace as no path rather than as a path', async () => {
    // The Dataset panel trims its input; a field left with a space must not
    // become a validation of " ".
    const { svc, importer } = build('/srv/media/.ultratorrent/imdb-datasets');
    await svc.validateDataset('   ');
    expect(importer.validate).toHaveBeenCalledWith('/srv/media/.ultratorrent/imdb-datasets', {});
  });

  it('still honours an explicit path', async () => {
    // The panel that already worked must keep working.
    const { svc, importer } = build('/srv/media/.ultratorrent/imdb-datasets');
    await svc.validateDataset('/srv/media/elsewhere');
    expect(importer.validate).toHaveBeenCalledWith('/srv/media/elsewhere', {});
  });

  it('falls back to a managed directory when nothing is configured', async () => {
    const { svc, importer, settingsSvc } = build(null);
    await svc.validateDataset('');
    expect(importer.validate).toHaveBeenCalledWith('/srv/media/.ultratorrent/imdb-datasets', {});
    // Persisted, so validate/import/history all point at the same place.
    expect(settingsSvc.update).toHaveBeenCalledWith({ datasetPath: '/srv/media/.ultratorrent/imdb-datasets' });
  });

  it('never passes an empty string to the importer', async () => {
    // The exact shape of the 400 the broken button produced.
    const { svc, importer } = build('/srv/media/x');
    await svc.validateDataset('');
    expect(importer.validate).not.toHaveBeenCalledWith('', expect.anything());
  });
});
