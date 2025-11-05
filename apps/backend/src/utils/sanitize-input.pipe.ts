import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';

import { sanitizeRecursively, sanitizeString } from './sanitize';

@Injectable()
export class SanitizeInputPipe implements PipeTransform {
  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    if (typeof value === 'string') {
      return sanitizeString(value);
    }

    if (!value || typeof value !== 'object') {
      return value;
    }

    return sanitizeRecursively(value);
  }
}
