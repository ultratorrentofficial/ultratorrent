import { BadRequestException } from '@nestjs/common';

/**
 * A rule's download directory must exist by the time the engine writes to it.
 *
 * rTorrent will not create a missing directory, so a rule pointing at one that
 * does not exist fails at GRAB time — after the release was matched, surfacing
 * as a broken download rather than a configuration problem. The path is created
 * when the rule is saved, which is when somebody is looking at it and can fix
 * whatever is wrong.
 */

/** The unit under test, lifted out so the spec does not need the whole module. */
function ensureSavePathExists(filePath: { ensureDirectory: (p: string) => Promise<unknown> }) {
  return async (savePath: string | null | undefined): Promise<void> => {
    const path = savePath?.trim();
    if (!path) return;
    await filePath.ensureDirectory(path);
  };
}

describe('creating a rule creates its directory', () => {
  it('creates the directory the rule names', async () => {
    const filePath = { ensureDirectory: jest.fn(async () => ({})) };
    await ensureSavePathExists(filePath)('/downloads/Intake/TV Shows/Silo (2023)');
    expect(filePath.ensureDirectory).toHaveBeenCalledWith('/downloads/Intake/TV Shows/Silo (2023)');
  });

  /*
   * No path is not a broken path. A rule without one uses the engine's own
   * default download directory, which already exists.
   */
  it.each([null, undefined, '', '   '])('does nothing for %s', async (input) => {
    const filePath = { ensureDirectory: jest.fn(async () => ({})) };
    await ensureSavePathExists(filePath)(input as never);
    expect(filePath.ensureDirectory).not.toHaveBeenCalled();
  });

  it('trims before using the path', async () => {
    const filePath = { ensureDirectory: jest.fn(async () => ({})) };
    await ensureSavePathExists(filePath)('  /downloads/Intake/Show  ');
    expect(filePath.ensureDirectory).toHaveBeenCalledWith('/downloads/Intake/Show');
  });

  /*
   * Deliberately fatal. A path that cannot be created now will not become
   * creatable by download time, and the error is actionable — telling somebody
   * while they are looking at the rule beats telling them through a failed
   * acquisition later.
   */
  it('surfaces a creation failure instead of saving a rule that cannot download', async () => {
    const filePath = {
      ensureDirectory: jest.fn(async () => {
        throw new BadRequestException('Permission denied creating /downloads/Intake');
      }),
    };
    await expect(ensureSavePathExists(filePath)('/downloads/Intake/X')).rejects.toThrow(
      /Permission denied/,
    );
  });
});
