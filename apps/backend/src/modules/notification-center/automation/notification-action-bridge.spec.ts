import { BadRequestException } from '@nestjs/common';
import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { NotificationActionBridge } from './notification-action-bridge.service';
import { classifyLegacyAction, planActionMigration } from './action-migration';

const DL = NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED;
const NO_PERM_EVENT = NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN; // subject_user, no permission

function build(eligible: string[] = ['u1']) {
  const dispatcher = {
    dispatch: jest.fn(async (e: any) => ({
      eventKey: e.eventKey, candidates: 1,
      recipients: (e.explicitRecipientUserIds ?? ['u1']).length,
      inAppCreated: 1, deliveriesQueued: 0, suppressed: [],
    })),
  };
  const eligibility = {
    filterEligible: jest.fn(async (ids: string[]) => ids.filter((i) => eligible.includes(i))),
  };
  return { svc: new NotificationActionBridge(dispatcher as any, eligibility as any), dispatcher, eligibility };
}

describe('NotificationActionBridge', () => {
  describe('emitEvent', () => {
    it('emits a registered event and lets the engine resolve the audience', async () => {
      const { svc, dispatcher } = build();
      const r = await svc.emitEvent(DL, { title: 'Dune' }, { actorUserId: 'u1' });
      expect(r).toMatchObject({ emitted: true, eventKey: DL });
      expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventKey: DL }));
    });

    it('refuses an unregistered event instead of silently reaching nobody', async () => {
      // A rule that looks configured and does nothing is worse than one that errors.
      const { svc, dispatcher } = build();
      const r = await svc.emitEvent('made.up.event', {});
      expect(r).toMatchObject({ emitted: false, reason: 'unregistered_event' });
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('passes the execution id through for idempotency', async () => {
      const { svc, dispatcher } = build();
      await svc.emitEvent(DL, {}, { executionId: 'exec-7' });
      expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'exec-7' }));
    });
  });

  describe('explicit recipients are validated, never trusted', () => {
    it('drops an ineligible id and reports it', async () => {
      // A rule author — or a compromised rule — can put anything in that list.
      const { svc, dispatcher } = build(['u1']);
      const r = await svc.notifyExplicitUsers(DL, ['u1', 'plex-user-88213'], {});
      expect(r.recipients).toBe(1);
      expect(r.rejected).toEqual([{ userId: 'plex-user-88213', reason: 'ineligible_user' }]);
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ explicitRecipientUserIds: ['u1'] }),
      );
    });

    it('emits nothing when every named recipient is ineligible', async () => {
      const { svc, dispatcher } = build([]);
      const r = await svc.notifyExplicitUsers(DL, ['plex-1', 'jellyfin-2'], {});
      expect(r).toMatchObject({ emitted: false, reason: 'no_eligible_recipients' });
      expect(r.rejected).toHaveLength(2);
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('deduplicates a repeated id so nobody is notified twice', async () => {
      const { svc, dispatcher } = build(['u1']);
      await svc.notifyExplicitUsers(DL, ['u1', 'u1', ' u1 '], {});
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ explicitRecipientUserIds: ['u1'] }),
      );
    });

    it('rejects an empty recipient list', async () => {
      const { svc } = build();
      expect(await svc.notifyExplicitUsers(DL, [], {})).toMatchObject({ reason: 'no_recipients' });
    });
  });

  describe('notifyCurrentUser', () => {
    it('notifies the actor', async () => {
      const { svc, dispatcher } = build(['u1']);
      await svc.notifyCurrentUser(DL, {}, { actorUserId: 'u1' });
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ explicitRecipientUserIds: ['u1'] }),
      );
    });

    it('does nothing when there is no actor', async () => {
      const { svc } = build();
      expect(await svc.notifyCurrentUser(DL, {}, {})).toMatchObject({ emitted: false, reason: 'no_actor' });
    });

    it('does not notify an actor who is no longer eligible', async () => {
      const { svc } = build([]); // actor deactivated since the rule was written
      expect(await svc.notifyCurrentUser(DL, {}, { actorUserId: 'gone' })).toMatchObject({ emitted: false });
    });
  });

  describe('notifyPermissionHolders', () => {
    it('uses the permission the EVENT declares', async () => {
      const { svc, dispatcher } = build();
      const r = await svc.notifyPermissionHolders(DL, {});
      expect(r.emitted).toBe(true);
      expect(dispatcher.dispatch).toHaveBeenCalled();
    });

    it('refuses an event that declares no permission', async () => {
      // Otherwise the action would silently widen its own audience.
      const { svc } = build();
      expect(await svc.notifyPermissionHolders(NO_PERM_EVENT, {})).toMatchObject({
        emitted: false, reason: 'event_declares_no_permission',
      });
    });
  });

  describe('notifyResourceOwner', () => {
    it('notifies the owner', async () => {
      const { svc, dispatcher } = build(['owner']);
      await svc.notifyResourceOwner(DL, {}, { resourceOwnerUserId: 'owner' });
      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ explicitRecipientUserIds: ['owner'] }),
      );
    });

    it('does nothing when the resource has no owner', async () => {
      const { svc } = build();
      expect(await svc.notifyResourceOwner(DL, {}, {})).toMatchObject({ reason: 'no_resource_owner' });
    });
  });

  describe('an action may never name a destination', () => {
    // A rule naming a Telegram chat would be a global routing decision wearing an
    // automation costume, bypassing every personal preference beneath it.
    for (const field of ['channelId', 'webhookUrl', 'chatId', 'email', 'phone', 'destination']) {
      it(`refuses ${field}`, () => {
        const { svc } = build();
        expect(() => svc.assertNoDirectChannel({ [field]: 'something' })).toThrow(BadRequestException);
      });
    }

    it('allows an action that names only an event', () => {
      const { svc } = build();
      expect(() => svc.assertNoDirectChannel({ eventKey: DL, payload: {} })).not.toThrow();
    });

    it('ignores empty values rather than tripping on them', () => {
      const { svc } = build();
      expect(() => svc.assertNoDirectChannel({ channelId: '', webhookUrl: null })).not.toThrow();
    });
  });
});

describe('legacy action migration', () => {
  it('classifies endpoint-addressed actions as INTEGRATION messages, not notifications', () => {
    // They address an endpoint, not a person: no recipient, no inbox, no preference.
    for (const id of ['webhook', 'slack']) {
      const v = classifyLegacyAction(id);
      expect(v.classification).toBe('integration_message');
      expect(v.automatic).toBe(true);
    }
  });

  it('flags free-text notification actions for MANUAL review', () => {
    // They carry a title and message rather than a registered event, so guessing
    // the event would silently re-point the rule at a different audience.
    for (const id of ['notify', 'send_notification', 'media_notify']) {
      const v = classifyLegacyAction(id);
      expect(v.classification).toBe('personal_notification');
      expect(v.automatic).toBe(false);
    }
  });

  it('converts notify_admin automatically, since it already named an audience', () => {
    const v = classifyLegacyAction('notify_admin');
    expect(v).toMatchObject({ automatic: true, replacement: 'emit_notification_event' });
  });

  it('treats an unknown action as incompatible rather than converting it', () => {
    expect(classifyLegacyAction('something_custom')).toMatchObject({
      classification: 'incompatible', automatic: false,
    });
  });

  it('plans a migration without performing one', () => {
    const report = planActionMigration(['notify', 'notify_admin', 'webhook', 'mystery']);
    expect(report.total).toBe(4);
    expect(report.automatic.map((v) => v.actionId)).toEqual(['notify_admin']);
    expect(report.integrations.map((v) => v.actionId)).toEqual(['webhook']);
    expect(report.manual.map((v) => v.actionId).sort()).toEqual(['mystery', 'notify']);
  });
});
