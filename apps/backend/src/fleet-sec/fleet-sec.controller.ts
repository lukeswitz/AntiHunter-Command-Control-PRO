import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Request } from 'express';

import { FleetSecService } from './fleet-sec.service';
import { Roles } from '../auth/auth.decorators';

class RegisterIdentityDto {
  @IsString()
  @MaxLength(120)
  label!: string;

  @IsString()
  @MaxLength(120)
  publicKey!: string;

  @IsIn(['primary', 'rescue', 'operator'])
  role!: 'primary' | 'rescue' | 'operator';
}

class ImportIdentityDto {
  @IsString()
  @MaxLength(120)
  label!: string;

  @IsString()
  privateKey!: string;

  @IsString()
  publicKey!: string;
}

class RevokeIdentityDto {
  @IsString()
  fingerprint!: string;

  @IsString()
  @MaxLength(200)
  reason!: string;
}

class SetAdminKeysDto {
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  keyFingerprints!: string[];
}

class SetIsManagedDto {
  @IsBoolean()
  value!: boolean;
}

class PolicyDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  expectedAdminKeyFingerprints?: string[];

  @IsOptional()
  @IsBoolean()
  expectedIsManaged?: boolean;
}

class RotatePskDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(7)
  channelIndex!: number;

  @IsOptional()
  @IsString()
  psk?: string;

  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  targets!: number[];

  @IsString()
  ack!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

class RetryDto {
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  targets!: number[];
}

@Controller('fleet-security')
export class FleetSecController {
  constructor(private readonly fleet: FleetSecService) {}

  private userId(req: Request): string {
    return req.auth?.sub ?? 'unknown';
  }

  @Get('identity')
  identity(@Req() req: Request) {
    return this.fleet.getIdentity(this.userId(req));
  }

  @Get('identities')
  identities() {
    return this.fleet.listIdentities();
  }

  @Get('identity/pubkey')
  pubkey() {
    return this.fleet.exportPubkey();
  }

  @Post('identities')
  @Roles(Role.ADMIN)
  register(@Req() req: Request, @Body() dto: RegisterIdentityDto) {
    return this.fleet.registerIdentity(this.userId(req), dto.label, dto.publicKey, dto.role);
  }

  @Post('identity/import')
  @Roles(Role.ADMIN)
  import(@Req() req: Request, @Body() dto: ImportIdentityDto) {
    return this.fleet.importIdentity(this.userId(req), dto.label, dto.privateKey, dto.publicKey);
  }

  @Post('identity/revoke')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  revoke(@Req() req: Request, @Body() dto: RevokeIdentityDto) {
    return this.fleet.revokeIdentity(this.userId(req), dto.fingerprint, dto.reason);
  }

  @Get('trust')
  trust() {
    return this.fleet.listTrust();
  }

  @Post('trust/:nodeNum/verify')
  @Roles(Role.ADMIN, Role.OPERATOR)
  @HttpCode(200)
  verify(@Req() req: Request, @Param('nodeNum', ParseIntPipe) nodeNum: number) {
    return this.fleet.verifyTrust(this.userId(req), nodeNum);
  }

  @Put('trust/:nodeNum/admin-keys')
  @Roles(Role.ADMIN)
  adminKeys(
    @Req() req: Request,
    @Param('nodeNum', ParseIntPipe) nodeNum: number,
    @Body() dto: SetAdminKeysDto,
  ) {
    return this.fleet.setAdminKeys(this.userId(req), nodeNum, dto.keyFingerprints);
  }

  @Put('trust/:nodeNum/is-managed')
  @Roles(Role.ADMIN)
  isManaged(
    @Req() req: Request,
    @Param('nodeNum', ParseIntPipe) nodeNum: number,
    @Body() dto: SetIsManagedDto,
  ) {
    return this.fleet.setIsManaged(this.userId(req), nodeNum, dto.value);
  }

  @Get('policy')
  policy() {
    return this.fleet.getPolicy();
  }

  @Put('policy')
  @Roles(Role.ADMIN)
  setPolicy(@Req() req: Request, @Body() dto: PolicyDto) {
    return this.fleet.setPolicy(this.userId(req), {
      expectedAdminKeyFps: dto.expectedAdminKeyFingerprints,
      expectedIsManaged: dto.expectedIsManaged,
    });
  }

  @Get('channels')
  channels() {
    return this.fleet.listChannels();
  }

  @Post('channels/refresh')
  @Roles(Role.ADMIN, Role.OPERATOR)
  @HttpCode(200)
  refreshChannels(@Req() req: Request) {
    return this.fleet.refreshChannels(this.userId(req));
  }

  @Post('rotations')
  @Roles(Role.ADMIN)
  rotate(@Req() req: Request, @Body() dto: RotatePskDto) {
    return this.fleet.rotatePsk(
      this.userId(req),
      dto.channelIndex,
      dto.psk ?? null,
      dto.targets,
      dto.ack,
      dto.notes ?? '',
    );
  }

  @Get('rotations/:id')
  rotation(@Param('id') id: string) {
    return this.fleet.getRotation(id);
  }

  @Post('rotations/:id/retire')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  retire(@Req() req: Request, @Param('id') id: string) {
    return this.fleet.retireOldPsk(this.userId(req), id);
  }

  @Post('rotations/:id/retry')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  retry(@Req() req: Request, @Param('id') id: string, @Body() dto: RetryDto) {
    return this.fleet.retryRotation(this.userId(req), id, dto.targets);
  }
}
