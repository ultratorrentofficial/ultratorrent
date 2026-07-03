import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

export class LoginDto {
  @IsString()
  @MaxLength(120)
  username!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  password!: string;

  // TOTP code or recovery code, supplied on the second step when 2FA is on.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  totp?: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(256)
  newPassword!: string;
}
