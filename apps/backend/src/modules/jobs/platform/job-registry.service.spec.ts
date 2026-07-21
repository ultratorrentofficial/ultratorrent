import { JobRegistry, DuplicateJobRegistrationError, UnknownJobTypeError } from './job-registry.service';
import type { JobDefinition, JobHandler } from './job.types';

function def(type: string, moduleKey = 'media_manager'): JobDefinition {
  return {
    type,
    moduleKey,
    labelKey: `jobs.type.${type}`,
    capabilities: { cancellable: true, retryable: false, pausable: false, resumable: false },
    validateInput: (i) => i,
  };
}
const handler: JobHandler = { execute: async () => ({}) };

describe('JobRegistry', () => {
  it('registers and looks up a job type', () => {
    const r = new JobRegistry();
    r.register(def('media.library_scan'), handler);
    expect(r.has('media.library_scan')).toBe(true);
    expect(r.get('media.library_scan').definition.moduleKey).toBe('media_manager');
    expect(r.size).toBe(1);
  });

  it('rejects a duplicate registration', () => {
    const r = new JobRegistry();
    r.register(def('media.scan'), handler);
    expect(() => r.register(def('media.scan'), handler)).toThrow(DuplicateJobRegistrationError);
  });

  it('rejects a definition missing required fields', () => {
    const r = new JobRegistry();
    expect(() => r.register({ ...def('x'), type: '' } as JobDefinition, handler)).toThrow();
    expect(() => r.register({ ...def('y'), labelKey: '' } as JobDefinition, handler)).toThrow();
    expect(() => r.register({ ...def('z'), moduleKey: '' } as JobDefinition, handler)).toThrow();
  });

  it('throws UnknownJobTypeError for an unregistered type', () => {
    const r = new JobRegistry();
    expect(() => r.get('nope')).toThrow(UnknownJobTypeError);
    expect(() => r.getDefinition('nope')).toThrow(UnknownJobTypeError);
  });

  it('lists the catalog and filters by module', () => {
    const r = new JobRegistry();
    r.register(def('media.scan', 'media_manager'), handler);
    r.register(def('sub.scan', 'subtitle_intelligence'), handler);
    expect(r.list().map((d) => d.type).sort()).toEqual(['media.scan', 'sub.scan']);
    expect(r.listByModule('subtitle_intelligence').map((d) => d.type)).toEqual(['sub.scan']);
  });
});
