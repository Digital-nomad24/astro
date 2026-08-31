import { ApiError, type ApiErrorBody } from '../types/api';

const API_URL = import.meta.env.VITE_API_URL;

function applyNgrokHeaders(headers: Headers): void {
  if (API_URL.includes('ngrok-free.app')) {
    headers.set('ngrok-skip-browser-warning', 'true');
  }
}

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;

export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

async function parseError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    /* empty */
  }
  const message = body
    ? Array.isArray(body.message)
      ? body.message.join(', ')
      : body.message
    : response.statusText;
  return new ApiError(response.status, body?.code ?? 'UNKNOWN', message);
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await tokenProvider();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  applyNgrokHeaders(headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    throw await parseError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export { API_URL };
