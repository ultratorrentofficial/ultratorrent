import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { WorkflowService } from './workflow.service';
import {
  CreateWorkflowDto, UpdateWorkflowDto, SaveDraftGraphDto, ValidateGraphDto,
  PublishWorkflowDto, WorkflowListQueryDto, SimulateWorkflowDto,
} from './dto/workflow.dto';

@ApiTags('workflows')
@ApiBearerAuth()
@Controller('workflows')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WorkflowsController {
  constructor(private readonly svc: WorkflowService) {}

  /** Node palette + engine limits. Static route declared before `:id`. */
  @Get('catalog')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_VIEW)
  catalog() {
    return this.svc.catalog();
  }

  /** Stateless graph validation (editor-side pre-save check). */
  @Post('validate')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_VIEW)
  validate(@Body() dto: ValidateGraphDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.validateGraph(dto.graph, user);
  }

  @Get()
  @RequirePermissions(PERMISSIONS.WORKFLOWS_VIEW)
  list(@Query() query: WorkflowListQueryDto) {
    return this.svc.list(query);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.WORKFLOWS_CREATE)
  create(@Body() dto: CreateWorkflowDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.create(dto, user);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_VIEW)
  get(@Param('id') id: string) {
    return this.svc.get(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_EDIT)
  update(@Param('id') id: string, @Body() dto: UpdateWorkflowDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.updateMeta(id, dto, user);
  }

  @Put(':id/graph')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_EDIT)
  saveDraft(@Param('id') id: string, @Body() dto: SaveDraftGraphDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.saveDraft(id, dto.graph, dto.changeNotes, user);
  }

  @Post(':id/publish')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_PUBLISH)
  publish(@Param('id') id: string, @Body() dto: PublishWorkflowDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.publish(id, dto.changeNotes, user);
  }

  /** No-side-effect dry run of the workflow (or a supplied graph override). */
  @Post(':id/simulate')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_RUN)
  simulate(@Param('id') id: string, @Body() dto: SimulateWorkflowDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.simulate(id, { graph: dto.graph, trigger: dto.trigger, vars: dto.vars }, user);
  }

  @Post(':id/enable')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_PUBLISH)
  enable(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.setEnabled(id, true, user);
  }

  @Post(':id/disable')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_PUBLISH)
  disable(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.setEnabled(id, false, user);
  }

  @Post(':id/archive')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_DELETE)
  archive(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.archive(id, user);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.WORKFLOWS_DELETE)
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.remove(id, user);
  }
}
