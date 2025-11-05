import sanitizeHtml from 'sanitize-html';

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  allowedSchemes: [],
};

export function sanitizeString(value: string): string {
  if (!value) {
    return value;
  }
  const sanitized = sanitizeHtml(value, SANITIZE_OPTIONS);
  return sanitized.trim();
}

export function sanitizeRecursively<T>(input: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof input === 'string') {
    return sanitizeString(input) as T;
  }

  if (!input || typeof input !== 'object') {
    return input;
  }

  if (input instanceof Date || input instanceof RegExp) {
    return input;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(input as any)) {
    return input;
  }

  if (seen.has(input as object)) {
    return input;
  }
  seen.add(input as object);

  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input[index] = sanitizeRecursively((input as any)[index], seen);
    }
    return input;
  }

  Object.keys(input as object).forEach((key) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (input as any)[key] = sanitizeRecursively((input as any)[key], seen);
  });

  return input;
}
