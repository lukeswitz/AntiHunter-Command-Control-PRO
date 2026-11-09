import { BadRequestException, Controller, Delete, Get, Param } from '@nestjs/common';
import { Role } from '@prisma/client';

import { CampaignsService } from './campaigns.service';
import { Roles } from '../auth/auth.decorators';

const CAMPAIGN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,23}$/;

function assertName(name: string): string {
  if (!CAMPAIGN_NAME_PATTERN.test(name)) {
    throw new BadRequestException('Campaign names use A-Z, a-z, 0-9, - or _ (max 23).');
  }
  return name;
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list() {
    return this.campaigns.list();
  }

  @Get(':name')
  detail(@Param('name') name: string) {
    return this.campaigns.detail(assertName(name));
  }

  @Delete(':name')
  @Roles(Role.ADMIN)
  remove(@Param('name') name: string) {
    return this.campaigns.remove(assertName(name));
  }
}
