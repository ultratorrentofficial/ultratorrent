import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { EngineService } from './engine.service';
import {
  CreateEngineDto,
  TestEngineDto,
  UpdateEngineDto,
} from './dto/engine.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('engines')
@ApiBearerAuth()
@Controller('engines')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class EngineController {
  constructor(private readonly engines: EngineService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SYSTEM_VIEW)
  list() {
    return this.engines.list();
  }

  @Get('health')
  @RequirePermissions(PERMISSIONS.SYSTEM_VIEW)
  health(@Query('engineId') engineId?: string) {
    return this.engines.health(engineId);
  }

  @Post('test')
  @RequirePermissions(PERMISSIONS.ENGINES_MANAGE)
  test(@Body() dto: TestEngineDto) {
    return this.engines.test(dto);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ENGINES_MANAGE)
  create(@Body() dto: CreateEngineDto) {
    return this.engines.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ENGINES_MANAGE)
  update(@Param('id') id: string, @Body() dto: UpdateEngineDto) {
    return this.engines.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ENGINES_MANAGE)
  remove(@Param('id') id: string) {
    return this.engines.remove(id);
  }
}
