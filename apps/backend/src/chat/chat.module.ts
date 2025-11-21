import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { ChatController } from './chat.controller';
import { ChatMqttService } from './chat-mqtt.service';
import { ChatService } from './chat.service';
import { MqttModule } from '../mqtt/mqtt.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [ConfigModule, MqttModule, WsModule],
  controllers: [ChatController],
  providers: [ChatService, ChatMqttService],
})
export class ChatModule {}
