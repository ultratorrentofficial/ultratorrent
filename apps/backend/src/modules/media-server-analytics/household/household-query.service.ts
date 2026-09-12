import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { HouseholdService } from './household.service';

/** Read-side of Household & Sharing — projections for the four admin views. Never
 * exposes anything Watch History does not already show to the same permission. */
@Injectable()
export class HouseholdQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly household: HouseholdService,
  ) {}

  async overview() {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const [usersMonitored, homesEstablished, needingReview, likelySharing, highRisk, mobileNetworks, newResidential, unknownNetworks] = await Promise.all([
      this.prisma.mediaHouseholdProfile.count(),
      this.prisma.mediaHouseholdProfile.count({ where: { homeNetworkId: { not: null } } }),
      this.prisma.mediaSharingReview.count({ where: { status: 'open' } }),
      this.prisma.mediaHouseholdProfile.count({ where: { riskLevel: { in: ['high', 'critical'] } } }),
      this.prisma.mediaHouseholdProfile.count({ where: { riskLevel: 'critical' } }),
      this.prisma.mediaHouseholdNetwork.count({ where: { networkType: 'mobile' } }),
      this.prisma.mediaHouseholdNetwork.count({ where: { networkType: 'residential', firstSeenAt: { gte: weekAgo } } }),
      this.prisma.mediaHouseholdNetwork.count({ where: { networkType: 'unknown' } }),
    ]);
    return { usersMonitored, homesEstablished, needingReview, likelySharing, highRisk, mobileNetworks, newResidential, unknownNetworks };
  }

  async users(page = 1, pageSize = 50) {
    const take = Math.min(200, Math.max(1, pageSize));
    const [rows, total] = await Promise.all([
      this.prisma.mediaHouseholdProfile.findMany({
        orderBy: [{ riskScore: 'desc' }, { displayName: 'asc' }],
        skip: (Math.max(1, page) - 1) * take, take,
        include: { networks: { select: { id: true, city: true, country: true, isp: true, networkType: true } }, reviews: { where: { status: 'open' }, select: { id: true } } },
      }),
      this.prisma.mediaHouseholdProfile.count(),
    ]);
    const items = rows.map((p) => {
      const home = p.networks.find((n) => n.id === p.homeNetworkId) ?? null;
      return {
        profileId: p.id, subjectKey: p.subjectKey, displayName: p.displayName,
        homeLocation: home ? [home.city, home.country].filter(Boolean).join(', ') : null,
        homeIsp: home?.isp ?? null, homeConfidence: p.homeConfidence,
        additionalNetworks: Math.max(0, p.networks.length - (home ? 1 : 0)),
        riskScore: p.riskScore, riskLevel: p.riskLevel, hasOpenReview: p.reviews.length > 0,
        lastEvaluatedAt: p.lastEvaluatedAt,
      };
    });
    return { items, total, page, pageSize: take };
  }

  async user(idOrKey: string) {
    const profile = await this.prisma.mediaHouseholdProfile.findFirst({
      where: { OR: [{ id: idOrKey }, { subjectKey: idOrKey }] },
      include: { networks: { orderBy: [{ watchSeconds: 'desc' }] }, signals: true, reviews: { orderBy: { createdAt: 'desc' } } },
    });
    if (!profile) return null;
    const subjects = await this.prisma.mediaAnalyticsUser.findMany({
      where: { OR: [{ groupId: profile.subjectKey }, { id: profile.subjectKey }] },
      select: { id: true, kind: true, providerUserId: true, displayName: true, groupId: true },
    });
    const linked = subjects.filter((s) => s.groupId === profile.subjectKey || (s.id === profile.subjectKey && s.groupId == null));
    return { ...profile, linkedAccounts: linked.map((s) => ({ kind: s.kind, providerUserId: s.providerUserId, displayName: s.displayName })) };
  }

  async reviews(filters: { status?: string; riskLevel?: string } = {}) {
    const where: Record<string, unknown> = {};
    where.status = filters.status ?? 'open';
    if (filters.riskLevel) where.riskLevel = filters.riskLevel;
    const rows = await this.prisma.mediaSharingReview.findMany({
      where, orderBy: [{ riskScore: 'desc' }, { createdAt: 'desc' }], take: 200,
      include: { profile: { select: { subjectKey: true, displayName: true } } },
    });
    return rows.map((r) => ({
      id: r.id, profileId: r.profileId, subjectKey: r.profile.subjectKey, displayName: r.profile.displayName,
      status: r.status, riskScore: r.riskScore, riskLevel: r.riskLevel, reasons: r.reasons, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt, createdAt: r.createdAt,
    }));
  }

  /** Cross-user network aggregate. Multiple users on one ISP is NOT wrongdoing —
   * this view is for spotting mobile egress / VPN infra / shared gateways. */
  async networks() {
    const grouped = await this.prisma.mediaHouseholdNetwork.groupBy({
      by: ['fingerprint'],
      _count: { _all: true }, _sum: { playCount: true, watchSeconds: true }, _min: { firstSeenAt: true }, _max: { lastSeenAt: true },
      orderBy: { _count: { fingerprint: 'desc' } }, take: 200,
    });
    const reps = await this.prisma.mediaHouseholdNetwork.findMany({
      where: { fingerprint: { in: grouped.map((g) => g.fingerprint) } },
      distinct: ['fingerprint'],
      select: { fingerprint: true, asn: true, isp: true, city: true, region: true, country: true, networkType: true, trusted: true, ignored: true },
    });
    const repByFp = new Map(reps.map((r) => [r.fingerprint, r]));
    return grouped.map((g) => {
      const r = repByFp.get(g.fingerprint);
      return {
        fingerprint: g.fingerprint, asn: r?.asn ?? null, isp: r?.isp ?? null,
        location: [r?.city, r?.country].filter(Boolean).join(', ') || null,
        networkType: r?.networkType ?? 'unknown', users: g._count._all,
        plays: g._sum.playCount ?? 0, watchSeconds: g._sum.watchSeconds ?? 0,
        firstSeen: g._min.firstSeenAt, lastSeen: g._max.lastSeenAt, trusted: r?.trusted ?? false, ignored: r?.ignored ?? false,
      };
    });
  }

  /** Return the networks for one fingerprint's drill-down (which users appear on it). */
  async networkUsers(fingerprint: string) {
    const rows = await this.prisma.mediaHouseholdNetwork.findMany({
      where: { fingerprint }, take: 200,
      include: { profile: { select: { id: true, subjectKey: true, displayName: true, riskLevel: true } } },
    });
    return rows.map((n) => ({ profileId: n.profile.id, displayName: n.profile.displayName, riskLevel: n.profile.riskLevel, plays: n.playCount, watchSeconds: n.watchSeconds, trusted: n.trusted, ignored: n.ignored }));
  }

  /** Trigger a fresh evaluation for one subject (used after the operator asks). */
  evaluateNow(subjectKey: string) {
    return this.household.runFor(subjectKey);
  }
}
