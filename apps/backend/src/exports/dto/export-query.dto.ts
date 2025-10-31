import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

export class ExportQueryDto {
  @IsOptional()
  @IsIn(['csv', 'json', 'geojson'])
  format?: 'csv' | 'json' | 'geojson';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  siteId?: string;
}
