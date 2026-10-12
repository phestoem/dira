import { clearTokens, getAccessToken } from "./auth";

export type DiraUser = {
  id: string;
  handle: string;
  name: string;
  email: string;
};

export type IntakeSpace = "personal" | "family" | "professional" | "vision";

export type IntakeFinancial = {
  hasFinancials: boolean;
  totalAmount: number | null;
  currency: string | null;
  direction: string | null;
  items: Array<{
    description: string;
    amount: number | null;
    currency: string | null;
  }>;
};

export type IntakeResult = {
  queueId: string;
  understood: {
    title: string;
    summary: string;
    contentType: string;
    project: string | null;
    location: string | null;
    people: string[];
    financial: IntakeFinancial;
    confidence: number;
  };
  matchingEntities: Array<{ id: string; name: string; entityType: string }>;
  needsClarification: string | null;
};

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `/api${p}`;
}

function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.href = "/login";
  }
}

function isPublicAuth(path: string) {
  return (
    path.startsWith("/auth/request-otp") ||
    path.startsWith("/auth/verify-otp") ||
    path.startsWith("/auth/refresh") ||
    path.startsWith("/auth/logout")
  );
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (
    init.body != null &&
    typeof init.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(apiUrl(path), { ...init, headers });

  if (res.status === 401 && !isPublicAuth(path)) {
    clearTokens();
    redirectToLogin();
  }

  return res;
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
  } catch {
    /* response was not JSON */
  }
  return "Request failed";
}

export async function requestOTP(email: string): Promise<{
  success: boolean;
  message: string;
}> {
  const res = await fetch(apiUrl("/auth/request-otp"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean; message: string }>;
}

export async function verifyOTP(
  email: string,
  otp: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  user: DiraUser;
}> {
  const res = await fetch(apiUrl("/auth/verify-otp"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, otp }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{
    accessToken: string;
    refreshToken: string;
    user: DiraUser;
  }>;
}

export async function uploadFile(file: File): Promise<IntakeResult> {
  const body = new FormData();
  body.append("file", file);
  const res = await apiFetch("/intake/file", { method: "POST", body });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<IntakeResult>;
}

export async function confirmIntake(
  queueId: string,
  space: IntakeSpace,
  corrections?: Record<string, unknown>,
): Promise<unknown> {
  const res = await apiFetch("/intake/confirm", {
    method: "POST",
    body: JSON.stringify({
      queueId,
      confirmed: true,
      space,
      ...(corrections ? { corrections } : {}),
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function dismissIntake(queueId: string): Promise<{ success: boolean }> {
  const res = await apiFetch("/intake/dismiss", {
    method: "POST",
    body: JSON.stringify({ queueId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean }>;
}
