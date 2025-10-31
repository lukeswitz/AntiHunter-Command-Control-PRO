import { forceLogout, getAuthToken } from '../auth/session';

type RequestOptions = RequestInit & {
  skipAuth?: boolean;
  tokenOverride?: string | null;
};

const API_BASE = '/api';

async function request<T>(input: RequestInfo | URL, options: RequestOptions = {}): Promise<T> {
  const { skipAuth, tokenOverride, headers: initHeaders, body, ...rest } = options;
  const headers: Record<string, string> = {};

  if (!(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (initHeaders) {
    Object.assign(headers, initHeaders as Record<string, string>);
  }

  const authToken = tokenOverride ?? (skipAuth ? null : getAuthToken());
  if (authToken) {
    headers.Authorization = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`;
  }

  const response = await fetch(input, {
    ...rest,
    body:
      body instanceof FormData || typeof body === 'string'
        ? body
        : body
          ? JSON.stringify(body)
          : undefined,
    headers,
  });

  if (response.status === 401) {
    forceLogout();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const apiClient = {
  get<T>(path: string, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, options);
  },
  post<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'POST',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  put<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'PUT',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  patch<T, B = unknown>(path: string, body?: B, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'PATCH',
      body: body as RequestOptions['body'],
      ...options,
    });
  },
  delete<T>(path: string, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'DELETE',
      ...options,
    });
  },
  upload<T>(path: string, formData: FormData, options?: RequestOptions) {
    return request<T>(`${API_BASE}${path}`, {
      method: 'POST',
      body: formData,
      ...options,
    });
  },
};
