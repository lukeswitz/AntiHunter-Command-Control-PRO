import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export type SerialProtocol = 'meshtastic-rewrite' | 'raw-lines' | 'nmea-like';

export class ConnectSerialDto {
  @IsOptional()
  @IsString()
  path?: string;

  @IsOptional()
  @IsNumber()
  @Min(300)
  @Max(921600)
  baudRate?: number;

  @IsOptional()
  @IsString()
  delimiter?: string;

  @IsOptional()
  @IsString()
  @IsIn(['meshtastic-rewrite', 'raw-lines', 'nmea-like'])
  protocol?: SerialProtocol;
}
