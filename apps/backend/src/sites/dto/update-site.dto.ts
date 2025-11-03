import { IsHexColor, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSiteDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;
}
