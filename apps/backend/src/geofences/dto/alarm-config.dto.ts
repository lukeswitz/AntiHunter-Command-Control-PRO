import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const ALARM_LEVELS = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'] as const;

export class GeofenceAlarmConfigDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @IsIn(ALARM_LEVELS)
  level!: (typeof ALARM_LEVELS)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message!: string;

  @IsOptional()
  @IsBoolean()
  triggerOnExit?: boolean;
}
