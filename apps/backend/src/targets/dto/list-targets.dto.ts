import { TargetStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class ListTargetsDto {
  @IsOptional()
  @IsEnum(TargetStatus)
  status?: TargetStatus;

  @IsOptional()
  @IsString()
  siteId?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}
