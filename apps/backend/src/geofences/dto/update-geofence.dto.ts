import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsHexColor,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { GeofenceVertexDto } from './geofence-vertex.dto';

const ALARM_LEVELS = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'] as const;

export class PartialGeofenceAlarmConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(ALARM_LEVELS)
  level?: (typeof ALARM_LEVELS)[number];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsBoolean()
  triggerOnExit?: boolean;
}

export class UpdateGeofenceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  siteId?: string | null;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GeofenceVertexDto)
  @ArrayMinSize(3)
  polygon?: GeofenceVertexDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PartialGeofenceAlarmConfigDto)
  alarm?: PartialGeofenceAlarmConfigDto;

  @IsOptional()
  @IsBoolean()
  appliesToAdsb?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToDrones?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToTargets?: boolean;

  @IsOptional()
  @IsBoolean()
  appliesToDevices?: boolean;
}
