import { Module } from '@nestjs/common';
import { ReleaseScoringService } from './release-scoring.service';
import { ReleaseScoringController } from './release-scoring.controller';

/**
 * Premium Release Scoring overlay. Gated by `@RequiresModule('release_scoring')`
 * + `ModuleGuard` (UPLM) + RBAC. Pure scoring engine — no DB.
 */
@Module({
  providers: [ReleaseScoringService],
  controllers: [ReleaseScoringController],
  exports: [ReleaseScoringService],
})
export class ReleaseScoringModule {}
