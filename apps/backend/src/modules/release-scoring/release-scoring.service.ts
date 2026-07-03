import { Injectable } from '@nestjs/common';
import { ReleaseScoreInput, ReleaseScoreResult, scoreRelease } from './release-scoring.engine';

export interface TestRuleInput {
  title: string;
  rule: Omit<ReleaseScoreInput, 'title'> & { minScore?: number };
}

/** Thin wrapper over the pure scoring engine (kept injectable for testing/audit). */
@Injectable()
export class ReleaseScoringService {
  score(input: ReleaseScoreInput): ReleaseScoreResult {
    return scoreRelease(input);
  }

  /** Score a title against a rule's preferences and report pass/fail vs minScore. */
  testRule(input: TestRuleInput) {
    const minScore = input.rule.minScore ?? 60;
    const result = scoreRelease({ title: input.title, ...input.rule });
    const passed = result.decision !== 'reject' && result.score >= minScore;
    return { ...result, minScore, passed };
  }
}
