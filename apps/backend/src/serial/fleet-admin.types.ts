export type ChannelRoleName = 'DISABLED' | 'PRIMARY' | 'SECONDARY';

export interface SecurityConfigView {
  publicKey: Buffer;
  adminKeys: Buffer[];
  isManaged: boolean;
  adminChannelEnabled: boolean;
  hasPrivateKey: boolean;
}

export interface ChannelView {
  index: number;
  role: ChannelRoleName;
  name: string;
  psk: Buffer;
}

export interface SecurityUpdate {
  publicKey?: Buffer;
  privateKey?: Buffer;
  adminKeys?: Buffer[];
  isManaged?: boolean;
  adminChannelEnabled?: boolean;
}

export interface ChannelUpdate {
  index: number;
  name: string;
  role: ChannelRoleName;
  psk: Buffer;
}

export class RadioReKeyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RadioReKeyRefused';
  }
}
