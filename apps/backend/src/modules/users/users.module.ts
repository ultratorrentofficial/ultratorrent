import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import * as argon2 from 'argon2';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

class CreateUserDto {
  @IsString() username!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() displayName?: string;
  @IsString() @MinLength(10) password!: string;
  @IsArray() @IsString({ each: true }) roleNames!: string[];
}

class UpdateUserDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) roleNames?: string[];
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(user: any) {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      isActive: user.isActive,
      isSystem: user.isSystem,
      lastLoginAt: user.lastLoginAt,
      roles: user.roles?.map((r: any) => r.role.name) ?? [],
    };
  }

  async list() {
    const users = await this.prisma.user.findMany({
      include: { roles: { include: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => this.serialize(u));
  }

  private async resolveRoleIds(roleNames: string[]): Promise<string[]> {
    const roles = await this.prisma.role.findMany({
      where: { name: { in: roleNames } },
    });
    if (roles.length !== roleNames.length) {
      throw new BadRequestException('One or more roles do not exist');
    }
    return roles.map((r) => r.id);
  }

  /**
   * Guard against privilege escalation via `roleNames`: only a SUPER_ADMIN may
   * grant the SUPER_ADMIN role, and nobody may edit their own roles (which would
   * let a users.manage holder self-promote). Enforced server-side.
   */
  private assertMayAssignRoles(
    roleNames: string[] | undefined,
    actor: AuthenticatedUser,
    targetUserId?: string,
  ): void {
    if (!roleNames) return;
    const actorIsSuper = actor.roles?.includes(SystemRole.SUPER_ADMIN);
    if (!actorIsSuper && roleNames.includes(SystemRole.SUPER_ADMIN)) {
      throw new ForbiddenException('Only a super admin can grant the SUPER_ADMIN role');
    }
    if (targetUserId && targetUserId === actor.id) {
      throw new ForbiddenException('You cannot change your own roles');
    }
  }

  async create(dto: CreateUserDto, actor: AuthenticatedUser) {
    this.assertMayAssignRoles(dto.roleNames, actor);
    const roleIds = await this.resolveRoleIds(dto.roleNames);
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        displayName: dto.displayName,
        passwordHash,
        roles: { create: roleIds.map((roleId) => ({ roleId })) },
      },
      include: { roles: { include: { role: true } } },
    });
    return this.serialize(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthenticatedUser) {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('User not found');

    this.assertMayAssignRoles(dto.roleNames, actor, id);

    if (dto.roleNames) {
      const roleIds = await this.resolveRoleIds(dto.roleNames);
      await this.prisma.userRole.deleteMany({ where: { userId: id } });
      await this.prisma.userRole.createMany({
        data: roleIds.map((roleId) => ({ userId: id, roleId })),
      });
    }
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        email: dto.email,
        displayName: dto.displayName,
        isActive: dto.isActive,
      },
      include: { roles: { include: { role: true } } },
    });
    // Deactivating an account must end its live sessions — otherwise its
    // refresh token keeps minting access tokens until it expires (up to 30d).
    if (dto.isActive === false) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return this.serialize(user);
  }

  async remove(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    if (user.isSystem) {
      throw new BadRequestException('System users cannot be deleted');
    }
    await this.prisma.user.delete({ where: { id } });
    return { id };
  }

  async listRoles() {
    return this.prisma.role.findMany({
      include: { permissions: { include: { permission: true } } },
      orderBy: { name: 'asc' },
    });
  }
}

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  list() {
    return this.users.list();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.USERS_VIEW)
  roles() {
    return this.users.listRoles();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.users.create(dto, actor);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.users.update(id, dto, actor);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.USERS_MANAGE)
  remove(@Param('id') id: string) {
    return this.users.remove(id);
  }
}

@Module({
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
