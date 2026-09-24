import { apiClient } from './client';

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ? existing.pushManager.getSubscription() : null;
}

export async function enablePush(): Promise<void> {
  const { publicKey } = await apiClient.get<{ publicKey: string | null }>('/push/public-key');
  if (!publicKey) {
    throw new Error('Push is not configured on the server (VAPID keys missing).');
  }
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }
  const reg = await registration();
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(publicKey),
    }));
  await apiClient.post('/push/subscriptions', subscription.toJSON());
}

export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) {
    return;
  }
  await apiClient.delete('/push/subscriptions', {
    body: { endpoint: subscription.endpoint } as never,
  });
  await subscription.unsubscribe();
}

export function sendTestPush(): Promise<unknown> {
  return apiClient.post('/push/test');
}
