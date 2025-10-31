import { Role } from '@prisma/client';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: Role;
  legalAccepted: boolean;
  iat: number;
  exp: number;
  tokenVersion?: number;
  features?: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
      authToken?: string;
    }
  }
}

export {};
