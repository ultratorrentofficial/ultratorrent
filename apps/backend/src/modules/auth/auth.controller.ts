import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService, TwoFactorRequiredException } from './auth.service';
import { LoginDto, RefreshDto, ChangePasswordDto } from './dto/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AuditService } from '../audit/audit.service';

function ctx(req: Request) {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @ApiOperation({ summary: 'Authenticate and obtain access + refresh tokens' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    try {
      const result = await this.auth.login(
        dto.username,
        dto.password,
        ctx(req),
        dto.totp,
      );
      await this.audit.record({
        userId: result.user.id,
        action: 'auth.login',
        result: 'success',
        ...ctx(req),
      });
      return result;
    } catch (err) {
      // A pending 2FA challenge is not a failed login — don't audit it as one.
      if (!(err instanceof TwoFactorRequiredException)) {
        await this.audit.record({
          action: 'auth.login',
          result: 'failure',
          metadata: { username: dto.username },
          ...ctx(req),
        });
      }
      throw err;
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate refresh token and obtain a fresh access token' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, ctx(req));
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.me(user.id);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
    await this.audit.record({
      userId: user.id,
      action: 'auth.change_password',
      result: 'success',
      ...ctx(req),
    });
    return { success: true };
  }
}
