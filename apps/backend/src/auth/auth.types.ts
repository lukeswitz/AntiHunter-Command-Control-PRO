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

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthTokenPayload;
    authToken?: string;
  }
}

export {};
