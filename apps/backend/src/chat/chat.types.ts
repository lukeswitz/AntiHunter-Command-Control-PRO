export type ChatMessageEvent = {
  type: 'chat.message';
  id: string;
  siteId: string;
  originSiteId: string;
  fromUserId?: string;
  fromEmail?: string;
  fromRole?: string;
  fromDisplayName?: string | null;
  encrypted: boolean;
  text?: string;
  cipherText?: string;
  ts: string;
};

export type ChatClearEvent = {
  type: 'chat.clear';
  originSiteId: string;
  target: 'all' | string;
  ts: string;
};
