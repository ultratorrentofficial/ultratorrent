import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

class CategoryDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() savePath?: string;
}

class TagDto {
  @IsString() @MaxLength(80) name!: string;
  @IsOptional() @IsString() color?: string;
}

@Injectable()
export class TaxonomyService {
  constructor(private readonly prisma: PrismaService) {}

  listCategories() {
    return this.prisma.torrentCategory.findMany({ orderBy: { name: 'asc' } });
  }
  createCategory(dto: CategoryDto) {
    return this.prisma.torrentCategory.create({ data: dto });
  }
  deleteCategory(id: string) {
    return this.prisma.torrentCategory.delete({ where: { id } });
  }

  listTags() {
    return this.prisma.torrentTag.findMany({ orderBy: { name: 'asc' } });
  }
  createTag(dto: TagDto) {
    return this.prisma.torrentTag.create({ data: dto });
  }
  deleteTag(id: string) {
    return this.prisma.torrentTag.delete({ where: { id } });
  }
}

@ApiTags('taxonomy')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TaxonomyController {
  constructor(private readonly svc: TaxonomyService) {}

  @Get('categories')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  categories() {
    return this.svc.listCategories();
  }
  @Post('categories')
  @RequirePermissions(PERMISSIONS.CATEGORIES_MANAGE)
  createCategory(@Body() dto: CategoryDto) {
    return this.svc.createCategory(dto);
  }
  @Delete('categories/:id')
  @RequirePermissions(PERMISSIONS.CATEGORIES_MANAGE)
  deleteCategory(@Param('id') id: string) {
    return this.svc.deleteCategory(id);
  }

  @Get('tags')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  tags() {
    return this.svc.listTags();
  }
  @Post('tags')
  @RequirePermissions(PERMISSIONS.TAGS_MANAGE)
  createTag(@Body() dto: TagDto) {
    return this.svc.createTag(dto);
  }
  @Delete('tags/:id')
  @RequirePermissions(PERMISSIONS.TAGS_MANAGE)
  deleteTag(@Param('id') id: string) {
    return this.svc.deleteTag(id);
  }
}

@Module({
  providers: [TaxonomyService],
  controllers: [TaxonomyController],
})
export class TaxonomyModule {}
