import { Transform } from 'class-transformer';
import { IsNumber, IsOptional } from 'class-validator';

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class UpdateFpvConfigDto {
  @IsOptional()
  @Transform(({ value }) => toNumberOrNull(value))
  @IsNumber()
  frequencyMHz?: number | null;

  @IsOptional()
  @Transform(({ value }) => toNumberOrNull(value))
  @IsNumber()
  bandwidthMHz?: number | null;

  @IsOptional()
  @Transform(({ value }) => toNumberOrNull(value))
  @IsNumber()
  gainDb?: number | null;
}
