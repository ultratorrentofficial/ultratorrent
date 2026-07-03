import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

const ENGINE_KINDS = ['rtorrent', 'qbittorrent', 'transmission', 'deluge'];
const MODES = ['scgi-tcp', 'scgi-unix', 'http'];

export class EngineConnectionDto {
  @IsIn(MODES)
  mode!: 'scgi-tcp' | 'scgi-unix' | 'http';

  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsInt()
  port?: number;

  @IsOptional()
  @IsString()
  socketPath?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsInt()
  timeoutMs?: number;
}

export class CreateEngineDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsIn(ENGINE_KINDS)
  kind!: string;

  @IsObject()
  config!: EngineConnectionDto;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}

export class TestEngineDto {
  @IsIn(ENGINE_KINDS)
  kind!: string;

  @IsObject()
  config!: EngineConnectionDto;
}

export class UpdateEngineDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsObject()
  config?: EngineConnectionDto;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;
}
