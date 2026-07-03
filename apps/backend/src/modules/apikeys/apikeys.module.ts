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
import { IsArray, IsOptional, IsString } from 'class-validator';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PERMISSIONS } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

class CreateApiKeyDto {
  @IsString() name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
}

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateApiKeyDto) {
    const prefix = `ut_${randomBytes(6).toString('hex')}`;
    const secret = randomBytes(24).toString('base64url');
    const keyHash = await argon2.hash(secret, { type: argon2.argon2id });
    await this.prisma.apiKey.create({
      data: {
        userId,
        name: dto.name,
        prefix,
        keyHash,
        scopes: dto.scopes ?? [],
      },
    });
    // The full key is shown exactly once.
    return { prefix, key: `${prefix}.${secret}`, name: dto.name };
  }

  async list(userId: string) {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
    }));
  }

  async revoke(userId: string, id: string) {
    await this.prisma.apiKey.updateMany({
      where: { id, userId },
      data: { revokedAt: new Date() },
    });
    return { id };
  }
}

@ApiTags('api-keys')
@ApiBearerAuth()
@Controller('api-keys')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.APIKEYS_MANAGE)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.keys.list(user.id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.APIKEYS_MANAGE)
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApiKeyDto) {
    return this.keys.create(user.id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.APIKEYS_MANAGE)
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.keys.revoke(user.id, id);
  }
}

@Module({
  providers: [ApiKeysService],
  controllers: [ApiKeysController],
})
export class ApiKeysModule {}
