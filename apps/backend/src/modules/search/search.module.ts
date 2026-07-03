import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  /** Global search across persisted torrent snapshots (name, hash, label). */
  async search(q: string, limit = 50) {
    if (!q || q.trim().length === 0) return { items: [] };
    const term = q.trim();
    const items = await this.prisma.torrentSnapshot.findMany({
      where: {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { hash: { contains: term.toLowerCase() } },
          { label: { contains: term, mode: 'insensitive' } },
          { savePath: { contains: term, mode: 'insensitive' } },
        ],
      },
      take: limit,
      orderBy: { capturedAt: 'desc' },
    });
    // BigInt fields must be serialised for JSON transport.
    return {
      items: items.map((i) => ({
        ...i,
        size: i.size.toString(),
        downloaded: i.downloaded.toString(),
        uploaded: i.uploaded.toString(),
      })),
    };
  }
}

@ApiTags('search')
@ApiBearerAuth()
@Controller('search')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  query(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.search.search(q, limit ? parseInt(limit, 10) : undefined);
  }
}

@Module({
  providers: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}
