import {
  MeshtasticLikeParser,
  ensureMeshtasticProtobufs,
} from './protocols/meshtastic-like.parser';
import { SerialProtocolParser } from './serial.types';

export type ProtocolKey = 'meshtastic-like' | 'raw-lines' | 'nmea-like';

export { ensureMeshtasticProtobufs };

export function createParser(protocol: ProtocolKey): SerialProtocolParser {
  switch (protocol) {
    case 'raw-lines':
    case 'nmea-like':
      // fall back to meshtastic-like for now; extend with dedicated parsers as needed.
      return new MeshtasticLikeParser();
    case 'meshtastic-like':
    default:
      return new MeshtasticLikeParser();
  }
}
