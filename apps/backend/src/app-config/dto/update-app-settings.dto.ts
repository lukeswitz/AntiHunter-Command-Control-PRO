import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

const HEX_COLOR_REGEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

export class UpdateAppSettingsDto {
  @IsOptional()
  @IsString()
  appName?: string;

  @IsOptional()
  @IsString()
  protocol?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  env?: string;

  @IsOptional()
  @IsString()
  detectChannels?: string;

  @IsOptional()
  @IsInt()
  detectMode?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  detectScanSecs?: number;

  @IsOptional()
  @IsBoolean()
  allowForever?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  baselineSecs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  deviceScanSecs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  droneSecs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  randomizeSecs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  deauthSecs?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2000)
  defaultRadiusM?: number;

  @IsOptional()
  @IsString()
  mapTileUrl?: string;

  @IsOptional()
  @IsString()
  mapAttribution?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  minZoom?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxZoom?: number;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  alertColorIdle?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  alertColorInfo?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  alertColorNotice?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  alertColorAlert?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  alertColorCritical?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeLightBackground?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeLightSurface?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeLightText?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeDarkBackground?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeDarkSurface?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeDarkText?: string;

  @IsOptional()
  @IsString()
  @Matches(HEX_COLOR_REGEX)
  themeAccentPrimary?: string;

  @IsOptional()
  @IsBoolean()
  mailEnabled?: boolean;

  @IsOptional()
  @IsString()
  mailHost?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  mailPort?: number;

  @IsOptional()
  @IsBoolean()
  mailSecure?: boolean;

  @IsOptional()
  @IsString()
  mailUser?: string;

  @IsOptional()
  @IsString()
  mailPassword?: string;

  @IsOptional()
  @IsString()
  mailFrom?: string;

  @IsOptional()
  @IsBoolean()
  mailPreview?: boolean;

  @IsOptional()
  @IsString()
  securityAppUrl?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  invitationExpiryHours?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  passwordResetExpiryHours?: number;

  @IsOptional()
  @IsBoolean()
  statusBroadcastEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  statusBroadcastIntervalSec?: number;

  @IsOptional()
  @IsBoolean()
  statusBroadcastGps?: boolean;

  @IsOptional()
  @IsBoolean()
  statusReplyEnabled?: boolean;
}
