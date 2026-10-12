export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

const STORAGE_KEYS = {
  accessToken: "dira_access_token",
  refreshToken: "dira_refresh_token",
  user: "dira_user",
} as const;

const ACCESS_COOKIE = "dira_access_token";
/** Match the access-token lifetime so middleware and the API expire together. */
const ACCESS_COOKIE_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function setAccessCookie(token: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${ACCESS_COOKIE}=${token}; path=/; max-age=${ACCESS_COOKIE_MAX_AGE_SEC}; SameSite=Strict`;
}

function clearAccessCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${ACCESS_COOKIE}=; path=/; max-age=0; SameSite=Strict`;
}

export function saveTokens(tokens: AuthTokens): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.accessToken, tokens.accessToken);
  localStorage.setItem(STORAGE_KEYS.refreshToken, tokens.refreshToken);
  setAccessCookie(tokens.accessToken);
}

export type StoredUser = {
  id: string;
  handle: string;
  name: string;
  email: string;
  createdAt?: string;
};

export function saveUser(user: object): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
}

export function getUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEYS.user);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredUser;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEYS.accessToken);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEYS.refreshToken);
}

export function clearTokens(): void {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith("dira_")) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
  clearAccessCookie();
}

export function isAuthenticated(): boolean {
  return Boolean(getAccessToken());
}
