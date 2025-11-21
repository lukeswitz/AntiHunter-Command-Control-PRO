import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

import { ChatService } from './chat.service';
import { SendChatMessageDto } from './dto/send-chat-message.dto';
import { Roles } from '../auth/auth.decorators';
import { AuthGuard } from '../auth/auth.guard';

@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('messages')
  @Roles(Role.ADMIN, Role.OPERATOR, Role.ANALYST, Role.VIEWER)
  async send(@Req() req: Request, @Body() dto: SendChatMessageDto) {
    return this.chatService.sendMessage(dto, req.auth);
  }
}
