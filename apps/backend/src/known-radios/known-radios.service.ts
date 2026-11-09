import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KnownMeshRadio } from '@prisma/client';

import { buildCommandPayload } from '../commands/command-builder';
import { CommandsService } from '../commands/commands.service';
import { PrismaService } from '../prisma/prisma.service';
import { SerialAlertEvent } from '../serial/serial.types';

export interface MeshRadioSighting {
  mac: string;
  radio: string;
  name: string | null;
  rssi: number | null;
  nodeId: string | null;
  lastSeen: string;
  known: boolean;
}

const MAX_SIGHTINGS = 200;

@Injectable()
export class KnownRadiosService implements OnModuleInit {
  private readonly logger = new Logger(KnownRadiosService.name);
  private readonly known = new Map<string, KnownMeshRadio>();
  private readonly sightings = new Map<string, Omit<MeshRadioSighting, 'known'>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const rows = await this.prisma.knownMeshRadio.findMany();
    rows.forEach((row) => this.known.set(row.mac, row));
  }

  list(): { known: KnownMeshRadio[]; recent: MeshRadioSighting[] } {
    const known = [...this.known.values()].sort((a, b) => a.mac.localeCompare(b.mac));
    const recent = [...this.sightings.values()]
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
      .map((s) => ({ ...s, known: this.known.has(s.mac) }));
    return { known, recent };
  }

  observe(event: SerialAlertEvent): boolean {
    const data = event.data;
    if (!data || data.detectionType !== 'RADIO_DETECTED' || typeof data.mac !== 'string') {
      return false;
    }
    const mac = data.mac.toUpperCase();
    const previous = this.sightings.get(mac);
    const name = typeof data.name === 'string' && data.name ? data.name : (previous?.name ?? null);
    this.sightings.delete(mac);
    this.sightings.set(mac, {
      mac,
      radio: typeof data.radio === 'string' ? data.radio : 'Meshtastic',
      name,
      rssi: typeof data.rssi === 'number' ? data.rssi : null,
      nodeId: event.nodeId ?? null,
      lastSeen: new Date().toISOString(),
    });
    if (this.sightings.size > MAX_SIGHTINGS) {
      const oldest = this.sightings.keys().next().value;
      if (oldest) this.sightings.delete(oldest);
    }
    return this.known.has(mac);
  }

  async add(input: { mac?: string; radio?: string; name?: string }, userId?: string) {
    const params = [input.mac ?? '', input.radio ?? ''];
    if (input.name?.trim()) params.push(input.name.trim());
    const built = buildCommandPayload({ target: '@ALL', name: 'RADIO_KNOWN_ADD', params });
    const [mac, radio, name] = built.params;
    const row = await this.prisma.knownMeshRadio.upsert({
      where: { mac },
      create: { mac, radio, name: name ?? null, addedBy: userId ?? null },
      update: { radio, name: name ?? null },
    });
    this.known.set(mac, row);
    await this.send('RADIO_KNOWN_ADD', built.params, userId);
    return row;
  }

  async remove(rawMac: string, userId?: string) {
    const built = buildCommandPayload({
      target: '@ALL',
      name: 'RADIO_KNOWN_DEL',
      params: [rawMac],
    });
    const [mac] = built.params;
    if (!this.known.has(mac)) {
      throw new BadRequestException(`${mac} is not a known radio.`);
    }
    await this.prisma.knownMeshRadio.delete({ where: { mac } });
    this.known.delete(mac);
    await this.send('RADIO_KNOWN_DEL', [mac], userId);
    return { ok: true };
  }

  async sync(userId?: string) {
    for (const row of this.known.values()) {
      const params = row.name ? [row.mac, row.radio, row.name] : [row.mac, row.radio];
      await this.send('RADIO_KNOWN_ADD', params, userId);
    }
    return { sent: this.known.size };
  }

  private async send(name: string, params: string[], userId?: string): Promise<void> {
    try {
      await this.commands.sendCommand({ target: '@ALL', name, params }, userId);
    } catch (error) {
      this.logger.warn(
        `Could not send ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }
}
