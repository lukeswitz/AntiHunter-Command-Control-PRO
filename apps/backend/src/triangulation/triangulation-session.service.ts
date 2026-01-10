import { Injectable, Logger } from '@nestjs/common';

interface TriangulationSession {
  mac: string;
  siteId: string;
  startTime: Date;
  durationSeconds: number;
  commandId: string;
}

@Injectable()
export class TriangulationSessionService {
  private readonly logger = new Logger(TriangulationSessionService.name);
  private readonly sessions = new Map<string, TriangulationSession>();

  startSession(mac: string, durationSeconds: number, siteId: string, commandId: string): void {
    const key = this.makeKey(mac, siteId);
    const session: TriangulationSession = {
      mac,
      siteId,
      startTime: new Date(),
      durationSeconds,
      commandId,
    };

    this.sessions.set(key, session);

    this.logger.log(
      `Started triangulation session for ${mac} in site ${siteId} (duration: ${durationSeconds}s)`,
    );

    setTimeout(() => {
      this.stopSession(mac, siteId);
    }, durationSeconds * 1000);
  }

  stopSession(mac: string, siteId: string): void {
    const key = this.makeKey(mac, siteId);
    const session = this.sessions.get(key);

    if (session) {
      this.sessions.delete(key);
      this.logger.log(`Stopped triangulation session for ${mac} in site ${siteId}`);
    }
  }

  isActive(mac: string, siteId: string): boolean {
    const key = this.makeKey(mac, siteId);
    const session = this.sessions.get(key);

    if (!session) {
      return false;
    }

    const elapsed = Date.now() - session.startTime.getTime();
    const isExpired = elapsed > session.durationSeconds * 1000;

    if (isExpired) {
      this.sessions.delete(key);
      return false;
    }

    return true;
  }

  getActiveSession(mac: string, siteId: string): TriangulationSession | null {
    const key = this.makeKey(mac, siteId);
    const session = this.sessions.get(key);

    if (!session) {
      return null;
    }

    const elapsed = Date.now() - session.startTime.getTime();
    const isExpired = elapsed > session.durationSeconds * 1000;

    if (isExpired) {
      this.sessions.delete(key);
      return null;
    }

    return session;
  }

  getAllActiveSessions(): TriangulationSession[] {
    const now = Date.now();
    const active: TriangulationSession[] = [];

    for (const [key, session] of this.sessions.entries()) {
      const elapsed = now - session.startTime.getTime();
      const isExpired = elapsed > session.durationSeconds * 1000;

      if (isExpired) {
        this.sessions.delete(key);
      } else {
        active.push(session);
      }
    }

    return active;
  }

  private makeKey(mac: string, siteId: string): string {
    return `${siteId}:${mac.toUpperCase()}`;
  }
}
