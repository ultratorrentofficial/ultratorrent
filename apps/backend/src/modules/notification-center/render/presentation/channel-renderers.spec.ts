import { NOTIFICATION_EVENTS, type NotificationPresentation } from '@ultratorrent/shared';

import {
  presentationToDiscord,
  presentationToEmailHtml,
  presentationToTelegram,
  presentationToText,
} from './channel-renderers';

function card(over: Partial<NotificationPresentation> = {}): NotificationPresentation {
  return {
    version: 1,
    eventKey: NOTIFICATION_EVENTS.MEDIA_SERVER_USER_FINISHED_WATCHING,
    accent: 'negative',
    icon: 'stop',
    eyebrow: 'ULTRATORRENT',
    headline: { lead: 'User Stopped', trail: 'Watching' },
    summary: { text: 'Dennis stopped watching The Last of Us - S01E03', emphasis: 'The Last of Us - S01E03' },
    avatar: { initials: 'D', hue: 200, label: 'Dennis' },
    artwork: { kind: 'notification', id: 'n1', aspect: 'poster', alt: 'Poster' },
    facts: [
      { icon: 'user', label: 'User', value: 'Dennis' },
      { icon: 'tv', label: 'Episode', value: 'The Last of Us - S01E03' },
      { icon: 'clock', label: 'Time', value: 'Today, 8:45 PM' },
      { icon: 'percent', label: 'Progress', value: '42% watched' },
    ],
    progress: { percent: 42, label: '42% watched' },
    status: '42% watched',
    action: { label: 'View activity', href: '/media-server/history', icon: 'activity' },
    timestamp: '2026-07-25T20:45:00Z',
    ...over,
  } as NotificationPresentation;
}

describe('presentationToText', () => {
  it('leads with the summary, then meta, then every fact', () => {
    const out = presentationToText(card());
    expect(out.split('\n')[0]).toBe('Dennis stopped watching The Last of Us - S01E03');
    expect(out).toContain('Today, 8:45 PM · 42% watched');
    expect(out).toContain('Progress: 42% watched');
  });
});

describe('presentationToTelegram', () => {
  it('bolds only the emphasized span and uses HTML mode', () => {
    const out = presentationToTelegram(card());
    expect(out.parseMode).toBe('HTML');
    expect(out.text).toContain('<b>The Last of Us - S01E03</b>');
    expect(out.text).toContain('⏹️');
  });

  it('escapes a title that would otherwise be markup', () => {
    const out = presentationToTelegram(card({
      summary: { text: 'Dennis watched <script>alert(1)</script>', emphasis: '<script>alert(1)</script>' },
    }));
    expect(out.text).not.toContain('<script>');
    expect(out.text).toContain('&lt;script&gt;');
  });

  it('stays inside Telegram’s 4096-character limit', () => {
    const out = presentationToTelegram(card({
      summary: { text: 'x'.repeat(9000), emphasis: null },
    }));
    expect(Array.from(out.text).length).toBeLessThanOrEqual(4096);
  });
});

describe('presentationToDiscord', () => {
  it('carries the accent as the embed colour', () => {
    expect((presentationToDiscord(card()) as any).embeds[0].color).toBe(0xef4444);
    expect((presentationToDiscord(card({ accent: 'positive' })) as any).embeds[0].color).toBe(0x22c55e);
  });

  it('maps every fact to an embed field', () => {
    const embed = (presentationToDiscord(card()) as any).embeds[0];
    expect(embed.fields).toHaveLength(4);
    expect(embed.fields[1]).toMatchObject({ name: 'Episode', inline: true });
  });

  it('omits artwork entirely rather than publishing a URL for it', () => {
    // The confirmed decision: private artwork is not made anonymously fetchable.
    const embed = (presentationToDiscord(card()) as any).embeds[0];
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.image).toBeUndefined();
    expect(JSON.stringify(embed)).not.toContain('http');
  });

  it('escapes markdown so a title cannot inject formatting or a masked link', () => {
    const embed = (presentationToDiscord(card({
      summary: { text: 'Dennis watched [click](http://evil.example)', emphasis: null },
    })) as any).embeds[0];
    expect(embed.description).toContain('\\[click\\]');
  });

  it('clamps a field value to Discord’s 1024-character limit', () => {
    const embed = (presentationToDiscord(card({
      facts: [{ icon: 'user', label: 'User', value: 'y'.repeat(3000) }],
    })) as any).embeds[0];
    expect(Array.from(embed.fields[0].value).length).toBeLessThanOrEqual(1024);
  });
});

describe('presentationToEmailHtml', () => {
  it('renders the accent stripe, the facts and the progress bar', () => {
    const html = presentationToEmailHtml(card());
    expect(html).toContain('#ef4444');
    expect(html).toContain('User Stopped');
    expect(html).toContain('42% watched');
    expect(html).toContain('width:42%');
  });

  it('escapes HTML in every interpolated value', () => {
    const html = presentationToEmailHtml(card({
      facts: [{ icon: 'user', label: 'User', value: '<img src=x onerror=alert(1)>' }],
      summary: { text: '<b>nope</b>', emphasis: null },
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>nope</b>');
    expect(html).toContain('&lt;img');
  });

  it('inlines its styles, since email clients strip style blocks', () => {
    const html = presentationToEmailHtml(card());
    expect(html).not.toContain('<style');
    expect(html).toContain('style="');
  });
});
