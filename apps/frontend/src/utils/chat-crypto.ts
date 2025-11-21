export async function encryptText(keyBase64: string, plaintext: string): Promise<string> {
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `${ivB64}:${ctB64}`;
}

export async function decryptText(keyBase64: string, payload: string): Promise<string> {
  const [ivPart, ctPart] = payload.split(':');
  if (!ivPart || !ctPart) throw new Error('Invalid payload');
  const iv = Uint8Array.from(atob(ivPart), (c) => c.charCodeAt(0));
  const ct = Uint8Array.from(atob(ctPart), (c) => c.charCodeAt(0));
  const keyBytes = Uint8Array.from(atob(keyBase64), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ct);
  return new TextDecoder().decode(plainBuf);
}

export function parseKeyInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Enter a key.');
  const isHex = /^[0-9a-fA-F]+$/.test(trimmed);
  if (isHex) {
    if (trimmed.length !== 64) throw new Error('Hex key must be 64 characters (32 bytes).');
    const bytes = trimmed.match(/.{1,2}/g)?.map((pair) => parseInt(pair, 16)) ?? [];
    return btoa(String.fromCharCode(...bytes));
  }
  const bytes = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) {
    throw new Error('Base64 key must decode to 32 bytes.');
  }
  return trimmed;
}
