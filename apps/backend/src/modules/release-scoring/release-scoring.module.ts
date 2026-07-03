import { Module } from '@nestjs/common';
import { ReleaseScoringService } from './release-scoring.service';
import { ReleaseScoringController } from './release-scoring.controller';

/**
 * Release Scoring module. RBAC-gated. Pure scoring engine — no DB.
 */
@Module({
  providers: [ReleaseScoringService],
  controllers: [ReleaseScoringController],
  exports: [ReleaseScoringService],
})
export class ReleaseScoringModule {}
