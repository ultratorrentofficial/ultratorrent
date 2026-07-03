import { scoreRelease } from '../release-scoring.engine';
import { ReleaseScoringService } from '../release-scoring.service';

describe('scoreRelease (explainable)', () => {
  it('rewards a preferred 1080p x265 BluRay release with reasons', () => {
    const r = scoreRelease({
      title: 'The Show S01E01 1080p BluRay x265-GROUP',
      preferredResolution: '1080p',
      preferredCodec: 'x265',
      preferredSources: ['bluray', 'web'],
      seeders: 80,
      trackerHealth: 'healthy',
    });
    expect(r.score).toBeGreaterThan(70);
    expect(r.decision).toBe('download');
    expect(r.reasons.join(' ')).toMatch(/resolution matches 1080p/);
    expect(r.reasons.join(' ')).toMatch(/healthy swarm/);
    expect(r.parsed.resolution).toBe('1080p');
  });

  it('hard-rejects on an excluded term regardless of quality', () => {
    const r = scoreRelease({
      title: 'The Show S01E01 1080p BluRay x265 CAM',
      excludedTerms: ['CAM'],
      seeders: 500,
    });
    expect(r.score).toBe(0);
    expect(r.decision).toBe('reject');
    expect(r.warnings.join(' ')).toMatch(/excluded term "CAM"/);
  });

  it('penalises zero seeders and warns', () => {
    const r = scoreRelease({ title: 'The Show S01E01 1080p WEB x264-GRP', seeders: 0 });
    expect(r.warnings.join(' ')).toMatch(/zero seeders/);
    expect(r.reasons.join(' ')).toMatch(/no seeders/);
  });

  it('penalises a resolution mismatch and avoided group', () => {
    const r = scoreRelease({
      title: 'The Show S01E01 720p WEB x264-BADGRP',
      preferredResolution: '1080p',
      avoidedGroups: ['BADGRP'],
    });
    expect(r.reasons.join(' ')).toMatch(/≠ preferred 1080p/);
    expect(r.reasons.join(' ')).toMatch(/avoided release group BADGRP/);
    expect(r.score).toBeLessThan(50);
  });

  it('flags duplicate risk', () => {
    const r = scoreRelease({ title: 'The Show S01E01 1080p BluRay x265-GRP', duplicateRisk: true });
    expect(r.warnings.join(' ')).toMatch(/equal-or-better copy/);
  });

  it('service.testRule reports pass/fail vs minScore', () => {
    const svc = new ReleaseScoringService();
    const pass = svc.testRule({ title: 'Show S01E01 1080p BluRay x265-GRP', rule: { preferredResolution: '1080p', seeders: 100, minScore: 60 } });
    expect(pass.passed).toBe(true);
    const fail = svc.testRule({ title: 'Show S01E01 480p CAM', rule: { excludedTerms: ['CAM'], minScore: 60 } });
    expect(fail.passed).toBe(false);
  });
});
