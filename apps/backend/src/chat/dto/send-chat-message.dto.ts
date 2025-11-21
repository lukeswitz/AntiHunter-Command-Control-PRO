import { IsBoolean, IsOptional, IsString, ValidateIf } from 'class-validator';

export class SendChatMessageDto {
  @IsOptional()
  @IsString()
  siteId?: string;

  @ValidateIf((o) => !o.encrypted)
  @IsString()
  text?: string;

  @ValidateIf((o) => o.encrypted)
  @IsString()
  cipherText?: string;

  @IsOptional()
  @IsBoolean()
  encrypted?: boolean;
}
