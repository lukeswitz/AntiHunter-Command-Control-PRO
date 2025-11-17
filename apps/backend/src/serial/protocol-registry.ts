import { MeshtasticRewriteParser } from './protocols/meshtastic-rewrite.parser';
import { SerialProtocolParser } from './serial.types';

export type ProtocolKey = 'meshtastic-rewrite' | 'raw-lines' | 'nmea-like';

export function createParser(protocol: ProtocolKey): SerialProtocolParser {
  switch (protocol) {
    case 'raw-lines':
    case 'nmea-like':
      // fall back to meshtastic rewrite parser until dedicated implementations exist.
      return new MeshtasticRewriteParser();
    case 'meshtastic-rewrite':
    default:
      return new MeshtasticRewriteParser();
  }
}
