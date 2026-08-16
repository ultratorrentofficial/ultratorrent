import { describe, expect, it } from 'vitest';
import { scheduleFields } from './NewslettersPage';

/**
 * The schedule half of the newsletter form.
 *
 * These exist because the controls were added to the edit form and its STATE,
 * but not to what that form submits — so choosing "Friday, 12:00" appeared to
 * work, saved four unrelated fields, and reverted on reload. The values a form
 * shows and the values it sends have to come from one place.
 */
describe('scheduleFields', () => {
  it('converts the picker values into the API shape', () => {
    expect(scheduleFields({ sendWeekday: '5', sendTime: '12:00', timezone: 'America/Puerto_Rico' }))
      .toEqual({ sendWeekday: 5, sendHour: 12, sendMinute: 0, timezone: 'America/Puerto_Rico' });
  });

  it('keeps midnight and minutes intact', () => {
    expect(scheduleFields({ sendWeekday: '0', sendTime: '00:30', timezone: 'UTC' }))
      .toEqual({ sendWeekday: 0, sendHour: 0, sendMinute: 30, timezone: 'UTC' });
  });

  it('sends null for "no fixed day", not 0 — which would mean Sunday', () => {
    expect(scheduleFields({ sendWeekday: '', sendTime: '09:00', timezone: 'UTC' }).sendWeekday).toBeNull();
  });

  it('falls back to a usable time rather than NaN', () => {
    expect(scheduleFields({ sendWeekday: '3', sendTime: '', timezone: '' }))
      .toEqual({ sendWeekday: 3, sendHour: 9, sendMinute: 0, timezone: 'UTC' });
  });
});
