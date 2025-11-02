import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export interface CommandCenterEvent {
  type: string;
  siteId?: string | null;
  [key: string]: unknown;
}

@Injectable()
export class EventBusService {
  private readonly subject = new Subject<CommandCenterEvent>();

  getStream(): Observable<CommandCenterEvent> {
    return this.subject.asObservable();
  }

  publish(event: CommandCenterEvent): void {
    this.subject.next(event);
  }
}
