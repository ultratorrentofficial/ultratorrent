import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ReleaseScoringService } from './release-scoring.service';
import { ScoreDto, TestRuleDto } from './dto/release-scoring.dto';

const P = PERMISSIONS;

/**
 * Release Scoring API — explainable 0–100 scoring of RSS releases. Module-gated
 * (`@RequiresModule('release_scoring')` + `ModuleGuard`, i.e. UPLM) + RBAC.
 */
@ApiTags('release-scoring')
@ApiBearerAuth()
@Controller('release-scoring')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ReleaseScoringController {
  constructor(private readonly scoring: ReleaseScoringService) {}

  @Post('score')
  @RequirePermissions(P.RELEASE_SCORING_VIEW)
  score(@Body() dto: ScoreDto) {
    return this.scoring.score(dto as never);
  }

  @Post('test-rule')
  @RequirePermissions(P.RELEASE_SCORING_VIEW)
  testRule(@Body() dto: TestRuleDto) {
    return this.scoring.testRule({ title: dto.title, rule: dto.rule as never });
  }
}
