import { apiClient } from './client';
import { ChatMessage } from './types';

export type SendChatRequest = {
  siteId?: string;
  text?: string;
  cipherText?: string;
  encrypted?: boolean;
};

export function sendChatMessage(body: SendChatRequest) {
  return apiClient.post<ChatMessage>('/chat/messages', body);
}
