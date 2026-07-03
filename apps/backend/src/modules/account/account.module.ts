import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { AuthService } from '../auth/auth.service';
import { TwoFactorService } from '../two-factor/two-factor.service';
import { AuthModule } from '../auth/auth.module';
import { AuditService } from '../audit/audit.service';

class UpdateProfileDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(120) displayName?: string;
}
class ChangePasswordDto {
  @IsString() currentPassword!: string;
  @IsString() @MinLength(10) @MaxLength(256) newPassword!: string;
}
class EnableTwoFactorDto {
  @IsString() code!: string;
}
class DisableTwoFactorDto {
  @IsString() password!: string;
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async profile(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      roles: user.roles.map((r) => r.role.name),
      twoFactorEnabled: user.totpEnabled,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { email: dto.email, displayName: dto.displayName },
    });
    return this.profile(userId);
  }
}

function reqCtx(req: Request) {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('account')
@ApiBearerAuth()
@Controller('account')
@UseGuards(JwtAuthGuard)
export class AccountController {
  constructor(
    private readonly account: AccountService,
    private readonly auth: AuthService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
  ) {}

  @Get('profile')
  profile(@CurrentUser() user: AuthenticatedUser) {
    return this.account.profile(user.id);
  }

  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.account.updateProfile(user.id, dto);
  }

  @Post('password')
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
    await this.audit.record({
      userId: user.id,
      action: 'account.password_changed',
      result: 'success',
      ...reqCtx(req),
    });
    return { success: true };
  }

  @Get('2fa')
  twoFactorStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.twoFactor.status(user.id);
  }

  @Post('2fa/setup')
  setup2fa(@CurrentUser() user: AuthenticatedUser) {
    return this.twoFactor.setup(user.id);
  }

  @Post('2fa/enable')
  async enable2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EnableTwoFactorDto,
    @Req() req: Request,
  ) {
    const result = await this.twoFactor.enable(user.id, dto.code);
    await this.audit.record({
      userId: user.id,
      action: 'account.2fa_enabled',
      result: 'success',
      ...reqCtx(req),
    });
    return result;
  }

  @Post('2fa/disable')
  async disable2fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DisableTwoFactorDto,
    @Req() req: Request,
  ) {
    await this.twoFactor.disable(user.id, dto.password);
    await this.audit.record({
      userId: user.id,
      action: 'account.2fa_disabled',
      result: 'success',
      ...reqCtx(req),
    });
    return { success: true };
  }

  @Post('2fa/recovery')
  regenerateRecovery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EnableTwoFactorDto,
  ) {
    return this.twoFactor.regenerateRecoveryCodes(user.id, dto.code);
  }
}

@Module({
  imports: [AuthModule],
  providers: [AccountService],
  controllers: [AccountController],
})
export class AccountModule {}
