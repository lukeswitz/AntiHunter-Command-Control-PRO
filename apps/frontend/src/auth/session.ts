/**
 * LocalStorage key name for storing the authentication token.
 * NOTE: This is NOT a secret - it's simply the key name used to access localStorage.
 * The actual authentication token (JWT) stored at this key is the secret value.
 * This key name is intentionally descriptive and public.
 */
const TOKEN_KEY = 'command-center.auth.token';

let cachedToken: string | null = null;
let logoutListener: (() => void) | null = null;

export function loadStoredToken(): string | null {
  if (cachedToken !== null) {
    return cachedToken;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  cachedToken = window.localStorage.getItem(TOKEN_KEY);
  return cachedToken;
}

export function storeAuthToken(token: string | null) {
  cachedToken = token;
  if (typeof window === 'undefined') {
    return;
  }
  if (token) {
    window.localStorage.setItem(TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
  }
}

export function getAuthToken(): string | null {
  return cachedToken ?? loadStoredToken();
}

export function registerLogoutListener(listener: () => void) {
  logoutListener = listener;
}

export function forceLogout() {
  storeAuthToken(null);
  if (logoutListener) {
    logoutListener();
  }
}

export { TOKEN_KEY };
