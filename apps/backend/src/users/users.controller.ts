import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

import { UsersService } from './users.service';
import { AllowLegalPending, Roles } from '../auth/auth.decorators';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { ListUsersDto } from './dto/list-users.dto';
import { UpdateCurrentUserDto } from './dto/update-current-user.dto';
import { UpdateUserPermissionsDto } from './dto/update-user-permissions.dto';
import { UpdateUserSiteAccessDto } from './dto/update-user-site-access.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @AllowLegalPending()
  getMe(@Req() req: Request) {
    const userId = req.auth?.sub;
    return this.usersService.getCurrentUser(userId!);
  }

  @Put('me')
  @AllowLegalPending()
  updateMe(@Req() req: Request, @Body() dto: UpdateCurrentUserDto) {
    const userId = req.auth?.sub;
    return this.usersService.updateCurrentUser(userId!, dto);
  }

  @Get()
  @Roles(Role.ADMIN)
  listUsers(@Query() dto: ListUsersDto) {
    return this.usersService.listUsers(dto);
  }

  @Get('features')
  @Roles(Role.ADMIN)
  listFeatures() {
    return this.usersService.getFeatureFlags();
  }

  @Post()
  @Roles(Role.ADMIN)
  createUser(@Req() req: Request, @Body() dto: CreateUserDto) {
    const actorId = req.auth?.sub;
    return this.usersService.createUser(dto, actorId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN)
  updateUser(@Param('id') id: string, @Req() req: Request, @Body() dto: UpdateUserDto) {
    const actorId = req.auth?.sub;
    return this.usersService.updateUser(id, dto, actorId!);
  }

  @Post(':id/unlock')
  @Roles(Role.ADMIN)
  unlockUser(@Param('id') id: string, @Req() req: Request) {
    const actorId = req.auth?.sub;
    return this.usersService.unlockUser(id, actorId ?? undefined);
  }

  @Get(':id')
  @Roles(Role.ADMIN)
  getUserDetails(@Param('id') id: string) {
    return this.usersService.getUserDetails(id);
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  disableUser(@Param('id') id: string, @Req() req: Request) {
    const actorId = req.auth?.sub;
    return this.usersService.disableUser(id, actorId!);
  }

  @Patch(':id/permissions')
  @Roles(Role.ADMIN)
  updatePermissions(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: UpdateUserPermissionsDto,
  ) {
    const actorId = req.auth?.sub;
    return this.usersService.updateUserPermissions(id, dto, actorId!);
  }

  @Patch(':id/sites')
  @Roles(Role.ADMIN)
  updateSiteAccess(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() dto: UpdateUserSiteAccessDto,
  ) {
    const actorId = req.auth?.sub;
    return this.usersService.updateUserSiteAccess(id, dto, actorId!);
  }

  @Post(':id/password-reset')
  @Roles(Role.ADMIN)
  sendPasswordReset(@Param('id') id: string, @Req() req: Request) {
    const actorId = req.auth?.sub;
    return this.usersService.sendPasswordReset(id, actorId!);
  }

  @Post('invitations')
  @Roles(Role.ADMIN)
  createInvitation(@Req() req: Request, @Body() dto: CreateInvitationDto) {
    const actorId = req.auth?.sub;
    return this.usersService.createInvitation(dto, actorId!);
  }

  @Get(':id/audit')
  @Roles(Role.ADMIN)
  listAudit(@Param('id') id: string, @Query('take') take?: string) {
    const limit = take ? Math.min(Math.max(Number(take), 1), 200) : 50;
    return this.usersService.listUserAudit(id, limit);
  }
}
