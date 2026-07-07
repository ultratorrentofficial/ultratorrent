import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { IndexerService } from './indexer.service';
import { CreateIndexerDto, UpdateIndexerDto } from './dto/indexer.dto';

const P = PERMISSIONS;

/** Torznab/Newznab indexer management. RBAC-gated; API keys never returned. */
@ApiTags('indexers')
@ApiBearerAuth()
@Controller('indexers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class IndexersController {
  constructor(private readonly indexers: IndexerService) {}

  @Get()
  @RequirePermissions(P.INDEXERS_VIEW)
  list() {
    return this.indexers.list();
  }

  @Get(':id')
  @RequirePermissions(P.INDEXERS_VIEW)
  get(@Param('id') id: string) {
    return this.indexers.get(id);
  }

  @Post()
  @RequirePermissions(P.INDEXERS_MANAGE)
  create(@Body() dto: CreateIndexerDto, @CurrentUser() u: AuthenticatedUser) {
    return this.indexers.create(dto, { userId: u?.id });
  }

  @Patch(':id')
  @RequirePermissions(P.INDEXERS_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateIndexerDto, @CurrentUser() u: AuthenticatedUser) {
    return this.indexers.update(id, dto, { userId: u?.id });
  }

  @Delete(':id')
  @RequirePermissions(P.INDEXERS_MANAGE)
  remove(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.indexers.remove(id, { userId: u?.id });
  }

  @Post(':id/test')
  @RequirePermissions(P.INDEXERS_TEST)
  test(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.indexers.testConnection(id, { userId: u?.id });
  }

  @Get(':id/search')
  @RequirePermissions(P.INDEXERS_TEST)
  search(
    @Param('id') id: string,
    @Query('q') q: string,
    @Query('season') season?: string,
    @Query('ep') ep?: string,
  ) {
    return this.indexers.searchOne(id, {
      q: q ?? '',
      season: season != null && season !== '' ? Number(season) : undefined,
      ep: ep != null && ep !== '' ? Number(ep) : undefined,
    });
  }
}
