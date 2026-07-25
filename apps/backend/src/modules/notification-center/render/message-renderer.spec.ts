import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { getEventDefinition } from '../catalog/notification-catalog';
import { humanizeEventKey, renderNotificationMessage } from './message-renderer';

const def = (key: string) => getEventDefinition(key)!;

describe('humanizeEventKey', () => {
  it('turns an event key into readable text', () => {
    expect(humanizeEventKey('download.torrent_completed')).toBe('Torrent completed');
    expect(humanizeEventKey('media.library_scan_completed')).toBe('Library scan completed');
  });

  it('keeps the meaningful part of a three-segment key', () => {
    expect(humanizeEventKey('workflow.execution.failed')).toBe('Execution failed');
    expect(humanizeEventKey('library_cleanup.plan.pending_approval')).toBe('Plan pending approval');
  });

  it('never returns something empty, and sentence-cases a bare key', () => {
    expect(humanizeEventKey('single')).toBe('Single');
    expect(humanizeEventKey('')).toBe('');
  });
});

describe('renderNotificationMessage', () => {
  const DL = def(NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED);

  it('NEVER emits a raw i18n key', () => {
    // The bug this replaces: a delivered Telegram message read
    // `events.download.torrent_completed.title`.
    const m = renderNotificationMessage(DL, {});
    expect(m.subject).not.toContain('events.');
    expect(m.subject).not.toContain('.title');
    expect(m.text).not.toContain('events.');
    expect(m.subject).toBe('Torrent completed');
  });

  it('renders an event with no override by humanizing its key', () => {
    // So an event added tomorrow with no translation is still readable.
    expect(renderNotificationMessage(def(NOTIFICATION_EVENTS.MEDIA_RENAMED), {}).subject)
      .toBe('Renamed');
  });

  it('uses the override where the humanizer reads poorly', () => {
    expect(renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_DISK_SPACE_LOW), {}).subject)
      .toContain('Low disk space');
  });

  it('translates for a Spanish recipient', () => {
    const m = renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN), {}, 'es-PR');
    expect(m.subject).toContain('Nuevo inicio de sesión');
  });

  it('falls back to English for an unknown locale', () => {
    const m = renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN), {}, 'fr-FR');
    expect(m.subject).toContain('New sign-in');
  });

  it('leads with severity only when it changes what the reader should do', () => {
    expect(renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_DISK_SPACE_LOW), {}).subject)
      .toMatch(/^\[Critical\]/);
    expect(renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT), { message: 'x' }).subject)
      .toMatch(/^\[Security\]/);
    // An ordinary success carries no prefix.
    expect(renderNotificationMessage(DL, {}).subject).not.toContain('[');
  });

  it('localizes the severity prefix', () => {
    expect(renderNotificationMessage(def(NOTIFICATION_EVENTS.SYSTEM_DISK_SPACE_LOW), {}, 'es-PR').subject)
      .toMatch(/^\[Crítico\]/);
  });

  describe('body', () => {
    it('includes the payload details a reader wants', () => {
      const m = renderNotificationMessage(DL, { mediaTitle: 'Dune', libraryName: 'Movies' });
      expect(m.text).toContain('Dune');
      expect(m.text).toContain('Movies');
    });

    it('is just the subject when the payload carries nothing useful', () => {
      const m = renderNotificationMessage(DL, { internalId: 42, ratio: 1.5 });
      expect(m.text).toBe(m.subject);
    });

    it('does not repeat the same value twice', () => {
      const m = renderNotificationMessage(DL, { title: 'Dune', mediaTitle: 'Dune' });
      expect(m.text.match(/Dune/g)).toHaveLength(1);
    });

    it('stays short — a notification is a nudge, not a report', () => {
      const m = renderNotificationMessage(DL, {
        mediaTitle: 'a', title: 'b', name: 'c', episodeTitle: 'd',
        seriesTitle: 'e', userDisplayName: 'f', libraryName: 'g',
      });
      expect(m.text.split('\n').filter(Boolean).length).toBeLessThanOrEqual(5);
    });

    describe('the field list is an ALLOW-list', () => {
      // A payload gaining a secret field must not leak it into a message.
      it('omits fields it does not know about', () => {
        const m = renderNotificationMessage(DL, { somethingNew: 'leak-me' });
        expect(m.text).not.toContain('leak-me');
      });

      for (const field of ['token', 'secret', 'password', 'apiKey', 'webhookUrl', 'chatId']) {
        it(`omits ${field}`, () => {
          const m = renderNotificationMessage(DL, { [field]: 'super-secret-value' });
          expect(m.text).not.toContain('super-secret-value');
        });
      }
    });

    it('ignores blank and non-scalar values', () => {
      const m = renderNotificationMessage(DL, { mediaTitle: '   ', libraryName: { nested: true } });
      expect(m.text).toBe(m.subject);
    });
  });
});
