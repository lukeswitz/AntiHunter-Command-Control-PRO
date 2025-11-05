import { FirewallGeoMode, FirewallPolicy } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const FIREWALL_POLICIES = Object.values(FirewallPolicy);
const FIREWALL_GEO_MODES = Object.values(FirewallGeoMode);

export class UpdateFirewallConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(FIREWALL_POLICIES)
  defaultPolicy?: FirewallPolicy;

  @IsOptional()
  @IsIn(FIREWALL_GEO_MODES)
  geoMode?: FirewallGeoMode;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  allowedCountries?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  blockedCountries?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  failThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(86400)
  failWindowSeconds?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604800)
  banDurationSeconds?: number;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ipAllowList?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ipBlockList?: string[];
}
