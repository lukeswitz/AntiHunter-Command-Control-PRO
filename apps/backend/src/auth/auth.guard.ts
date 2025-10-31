import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';

import { ALLOW_PENDING_KEY, FEATURES_KEY, IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const payload = await this.authService.verifyToken(token);
      request.auth = payload;
      request.authToken = token;

      const allowPending = this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (requiredRoles?.length && !requiredRoles.includes(payload.role)) {
        throw new ForbiddenException('INSUFFICIENT_ROLE');
      }

      const requiredFeatures = this.reflector.getAllAndOverride<string[]>(FEATURES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (requiredFeatures?.length) {
        const featureSet = await this.authService.getUserFeatures(payload.sub, payload.role);
        const missing = requiredFeatures.filter((feature) => !featureSet.includes(feature));
        if (missing.length > 0) {
          throw new ForbiddenException('INSUFFICIENT_FEATURE');
        }
        request.auth.features = featureSet;
      }

      if (!payload.legalAccepted && !allowPending) {
        throw new ForbiddenException('LEGAL_ACK_REQUIRED');
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid authorization token');
    }
  }

  private extractToken(request: { headers?: Record<string, string | string[]> }): string | null {
    const authHeader = request.headers?.authorization ?? request.headers?.Authorization;
    if (typeof authHeader === 'string') {
      const [type, token] = authHeader.split(' ');
      if (type?.toLowerCase() === 'bearer' && token) {
        return token;
      }
      if (!type && authHeader) {
        return authHeader;
      }
    }

    if (Array.isArray(authHeader)) {
      return this.extractToken({ headers: { authorization: authHeader[0] } });
    }

    const sessionHeader = request.headers?.['x-session-token'];
    if (typeof sessionHeader === 'string' && sessionHeader.trim().length > 0) {
      return sessionHeader.trim();
    }

    return null;
  }
}
