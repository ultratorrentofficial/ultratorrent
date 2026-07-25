import {
  isWithinQuietHours, localParts, nextDailyDigestAt, nextWeeklyDigestAt,
  parseHhMm, quietHoursEndAt,
} from './quiet-hours';

const PR = 'America/Puerto_Rico'; // UTC-4, no DST
const MADRID = 'Europe/Madrid';   // UTC+1/+2 with DST

/** An instant expressed as UTC, for readability in the assertions below. */
const utc = (iso: string) => new Date(iso);

describe('localParts', () => {
  it('reads wall-clock time in the recipient timezone, not the server one', () => {
    // 03:00Z is 23:00 the previous day in Puerto Rico.
    const p = localParts(utc('2026-07-25T03:00:00Z'), PR);
    expect(p.hour).toBe(23);
    expect(p.weekday).toBe(5); // Friday, not Saturday
  });

  it('handles a DST zone correctly', () => {
    // Madrid is UTC+2 in July.
    expect(localParts(utc('2026-07-25T10:00:00Z'), MADRID).hour).toBe(12);
    // …and UTC+1 in January.
    expect(localParts(utc('2026-01-25T10:00:00Z'), MADRID).hour).toBe(11);
  });

  it('renders local midnight as hour 0, never 24', () => {
    expect(localParts(utc('2026-07-25T04:00:00Z'), PR).hour).toBe(0);
  });

  it('falls back to the server zone for an invalid timezone rather than throwing', () => {
    expect(() => localParts(utc('2026-07-25T10:00:00Z'), 'Not/AZone')).not.toThrow();
  });
});

describe('parseHhMm', () => {
  it('parses valid times', () => {
    expect(parseHhMm('22:00')).toBe(1320);
    expect(parseHhMm('7:05')).toBe(425);
    expect(parseHhMm('00:00')).toBe(0);
  });
  it('rejects nonsense', () => {
    for (const bad of ['', null, undefined, '25:00', '10:99', 'ten', '1000']) {
      expect(parseHhMm(bad as never)).toBeNull();
    }
  });
});

describe('isWithinQuietHours', () => {
  const overnight = {
    quietHoursEnabled: true, timezone: PR,
    quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursDays: [] as number[],
  };

  it('is off when disabled', () => {
    expect(isWithinQuietHours({ ...overnight, quietHoursEnabled: false }, utc('2026-07-25T04:00:00Z'))).toBe(false);
  });

  describe('an OVERNIGHT window wraps midnight', () => {
    // The case a naive start<=t<end comparison gets wrong: it would make
    // 22:00–07:00 an empty window and silently disable quiet hours for anyone
    // who set a normal night.
    it('is quiet in the evening portion', () => {
      // 23:30 local = 03:30Z
      expect(isWithinQuietHours(overnight, utc('2026-07-26T03:30:00Z'))).toBe(true);
    });
    it('is quiet across midnight', () => {
      // 00:30 local = 04:30Z
      expect(isWithinQuietHours(overnight, utc('2026-07-26T04:30:00Z'))).toBe(true);
    });
    it('is quiet in the morning portion', () => {
      // 06:30 local = 10:30Z
      expect(isWithinQuietHours(overnight, utc('2026-07-26T10:30:00Z'))).toBe(true);
    });
    it('is NOT quiet after it ends', () => {
      // 07:30 local = 11:30Z
      expect(isWithinQuietHours(overnight, utc('2026-07-26T11:30:00Z'))).toBe(false);
    });
    it('is NOT quiet in the afternoon', () => {
      // 14:00 local = 18:00Z
      expect(isWithinQuietHours(overnight, utc('2026-07-26T18:00:00Z'))).toBe(false);
    });
  });

  describe('a SAME-DAY window', () => {
    const daytime = { ...overnight, quietHoursStart: '13:00', quietHoursEnd: '15:00' };
    it('is quiet inside it', () => {
      expect(isWithinQuietHours(daytime, utc('2026-07-26T18:00:00Z'))).toBe(true); // 14:00 local
    });
    it('is not quiet outside it', () => {
      expect(isWithinQuietHours(daytime, utc('2026-07-26T20:00:00Z'))).toBe(false); // 16:00 local
    });
    it('excludes the end minute, so the window is half-open', () => {
      expect(isWithinQuietHours(daytime, utc('2026-07-26T19:00:00Z'))).toBe(false); // 15:00 local
    });
  });

  it('treats start === end as an empty window, not a 24-hour one', () => {
    const same = { ...overnight, quietHoursStart: '09:00', quietHoursEnd: '09:00' };
    expect(isWithinQuietHours(same, utc('2026-07-26T18:00:00Z'))).toBe(false);
  });

  describe('day-of-week selection', () => {
    it('applies only on the chosen days', () => {
      // Friday only. 2026-07-24 is a Friday.
      const fridays = { ...overnight, quietHoursDays: [5] };
      expect(isWithinQuietHours(fridays, utc('2026-07-25T03:00:00Z'))).toBe(true);  // Fri 23:00
      expect(isWithinQuietHours(fridays, utc('2026-07-26T03:00:00Z'))).toBe(false); // Sat 23:00
    });

    it('attributes the morning half to the day the window STARTED on', () => {
      // "Friday 22:00–07:00" must stay quiet through Saturday morning; testing the
      // current day would end it abruptly at midnight.
      const fridays = { ...overnight, quietHoursDays: [5] };
      // Sat 02:00 local = 06:00Z Saturday — belongs to Friday's window.
      expect(isWithinQuietHours(fridays, utc('2026-07-25T06:00:00Z'))).toBe(true);
    });
  });

  it('respects the recipient timezone, so two users differ at the same instant', () => {
    const at = utc('2026-07-26T03:00:00Z'); // PR 23:00 (quiet), Madrid 05:00 (also quiet)
    const inPR = isWithinQuietHours(overnight, at);
    const inMadrid = isWithinQuietHours({ ...overnight, timezone: MADRID }, at);
    expect(inPR).toBe(true);
    expect(inMadrid).toBe(true);
    // …but at 10:00Z: PR 06:00 (quiet), Madrid 12:00 (not).
    const later = utc('2026-07-26T10:00:00Z');
    expect(isWithinQuietHours(overnight, later)).toBe(true);
    expect(isWithinQuietHours({ ...overnight, timezone: MADRID }, later)).toBe(false);
  });
});

describe('quietHoursEndAt', () => {
  const overnight = {
    quietHoursEnabled: true, timezone: PR,
    quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursDays: [] as number[],
  };

  it('returns the instant unchanged when not in quiet hours', () => {
    const at = utc('2026-07-26T18:00:00Z');
    expect(quietHoursEndAt(overnight, at).getTime()).toBe(at.getTime());
  });

  it('releases just after the window ends', () => {
    const at = utc('2026-07-26T04:30:00Z'); // 00:30 local
    const release = quietHoursEndAt(overnight, at);
    expect(isWithinQuietHours(overnight, release)).toBe(false);
    expect(localParts(release, PR).hour).toBe(7);
  });

  it('never holds a notification indefinitely', () => {
    const always = { ...overnight, quietHoursStart: '00:00', quietHoursEnd: '23:59' };
    const at = utc('2026-07-26T12:00:00Z');
    const release = quietHoursEndAt(always, at, 120);
    expect(release.getTime()).toBeLessThanOrEqual(at.getTime() + 120 * 60_000);
  });
});

describe('digest scheduling', () => {
  const base = { timezone: PR, digestDaily: true, digestDailyAt: '08:00', digestWeekly: false };

  it('returns null when the digest is off', () => {
    expect(nextDailyDigestAt({ ...base, digestDaily: false }, utc('2026-07-26T12:00:00Z'))).toBeNull();
    expect(nextWeeklyDigestAt({ ...base, digestWeekly: false }, utc('2026-07-26T12:00:00Z'))).toBeNull();
  });

  it('schedules the daily digest at the local time, not the server one', () => {
    const next = nextDailyDigestAt(base, utc('2026-07-26T12:00:00Z'))!;
    expect(localParts(next, PR).hour).toBe(8);
    expect(localParts(next, PR).minute).toBe(0);
    expect(next.getTime()).toBeGreaterThan(utc('2026-07-26T12:00:00Z').getTime());
  });

  it('rolls to tomorrow when today’s time has passed', () => {
    // 13:00Z = 09:00 local, past the 08:00 digest.
    const from = utc('2026-07-26T13:00:00Z');
    const next = nextDailyDigestAt(base, from)!;
    expect(next.getTime() - from.getTime()).toBeGreaterThan(20 * 60 * 60_000);
  });

  it('schedules the weekly digest on the chosen local weekday', () => {
    const cfg = { timezone: PR, digestDaily: false, digestWeekly: true, digestWeeklyDay: 1, digestWeeklyAt: '09:00' };
    const next = nextWeeklyDigestAt(cfg, utc('2026-07-26T12:00:00Z'))!;
    const p = localParts(next, PR);
    expect(p.weekday).toBe(1); // Monday
    expect(p.hour).toBe(9);
  });

  it('uses sensible defaults when the time is unset', () => {
    const next = nextDailyDigestAt({ ...base, digestDailyAt: null }, utc('2026-07-26T12:00:00Z'))!;
    expect(localParts(next, PR).hour).toBe(8);
  });
});
