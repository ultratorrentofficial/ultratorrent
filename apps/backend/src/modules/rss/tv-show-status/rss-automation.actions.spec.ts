import { BadRequestException } from '@nestjs/common';
import { RssAutomationActions, RSS_ACTION_TYPES } from './rss-automation.actions';

function build() {
  const prisma = {
    rssRule: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
  };
  const showStatus = { resolveByProviderId: jest.fn().mockResolvedValue({ normalizedStatus: 'ended' }) };
  const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const svc = new RssAutomationActions(prisma as any, showStatus as any, notifications as any);
  return { svc, prisma, showStatus, notifications };
}

const ctx = { provider: 'tmdb', providerShowId: '42', title: 'Show' };

describe('RSS_ACTION_TYPES', () => {
  it('covers the three delegated RSS actions', () => {
    expect([...RSS_ACTION_TYPES].sort()).toEqual(
      ['convert_rule_to_backfill', 'disable_rss_rule', 'refresh_rss_show_status'],
    );
  });
});

describe('RssAutomationActions.execute', () => {
  it('refresh_rss_show_status force-resolves from context identity', async () => {
    const { svc, showStatus } = build();
    await svc.execute('refresh_rss_show_status', {}, ctx);
    expect(showStatus.resolveByProviderId).toHaveBeenCalledWith('tmdb', '42', true);
  });

  it('refresh_rss_show_status needs a show identity', async () => {
    const { svc } = build();
    await expect(svc.execute('refresh_rss_show_status', {}, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('disable_rss_rule disables every rule for the show on context', async () => {
    const { svc, prisma } = build();
    const res = await svc.execute('disable_rss_rule', {}, ctx);
    expect(prisma.rssRule.updateMany).toHaveBeenCalledWith({
      where: { showStatusProvider: 'tmdb', showStatusProviderId: '42' },
      data: { isEnabled: false },
    });
    expect(res).toEqual({ disabled: 3 });
  });

  it('disable_rss_rule prefers an explicit ruleId', async () => {
    const { svc, prisma } = build();
    await svc.execute('disable_rss_rule', { ruleId: 'rule-9' }, ctx);
    expect(prisma.rssRule.updateMany).toHaveBeenCalledWith({
      where: { id: 'rule-9' },
      data: { isEnabled: false },
    });
  });

  it('convert_rule_to_backfill turns off autoDownload', async () => {
    const { svc, prisma } = build();
    const res = await svc.execute('convert_rule_to_backfill', {}, ctx);
    expect(prisma.rssRule.updateMany).toHaveBeenCalledWith({
      where: { showStatusProvider: 'tmdb', showStatusProviderId: '42' },
      data: { autoDownload: false },
    });
    expect(res).toEqual({ converted: 3 });
  });

  it('rule actions with no target throw', async () => {
    const { svc } = build();
    await expect(svc.execute('disable_rss_rule', {}, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unknown action', async () => {
    const { svc } = build();
    await expect(svc.execute('bogus', {}, ctx)).rejects.toBeInstanceOf(BadRequestException);
  });
});
