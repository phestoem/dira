import { clearTokens, getAccessToken, getRefreshToken } from "./auth";

export type DiraUser = {
  id: string;
  handle: string;
  name: string;
  email: string;
  createdAt?: string;
  altimetrixUserId?: string | null;
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
    occurredAt?: string | null;
    people: string[];
    financial: IntakeFinancial;
    confidence: number;
    altimetrixContext?: string;
    emotionalSignificance?: string;
  };
  matchingEntities: Array<{ id: string; name: string; entityType: string }>;
  needsClarification: string | null;
  duplicate: {
    existingEventId: string;
    existingTitle: string;
    message: string;
    similarityScore?: number;
  } | null;
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

export async function getMe(): Promise<DiraUser> {
  const res = await apiFetch("/users/me");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<DiraUser>;
}

export async function linkAltimetrix(altimetrixUserId: string): Promise<DiraUser> {
  const res = await apiFetch("/users/me/altimetrix", {
    method: "PATCH",
    body: JSON.stringify({ altimetrixUserId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<DiraUser>;
}

export async function getAltimetrixNudge(): Promise<{ nudge: { message: string; href: string } | null }> {
  const res = await apiFetch("/users/me/altimetrix-nudge");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ nudge: { message: string; href: string } | null }>;
}

export async function syncAltimetrix(): Promise<{ sent: number }> {
  const res = await apiFetch("/users/me/altimetrix/sync", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ sent: number }>;
}

export async function logout(): Promise<{ success: boolean }> {
  const refreshToken = getRefreshToken();
  const res = await apiFetch("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean }>;
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
  occurredAt?: string | null,
): Promise<unknown> {
  const res = await apiFetch("/intake/confirm", {
    method: "POST",
    body: JSON.stringify({
      queueId,
      confirmed: true,
      space,
      ...(occurredAt !== undefined ? { occurredAt } : {}),
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

export async function submitText(content: string): Promise<IntakeResult> {
  const res = await apiFetch("/intake/text", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<IntakeResult>;
}

export type LifeEvent = {
  id: string;
  title: string;
  understoodMeaning: string | null;
  eventType: string;
  space: IntakeSpace;
  status: string;
  source: string | null;
  financials: {
    amount?: number | null;
    currency?: string | null;
    direction?: string | null;
    items?: Array<{
      description: string;
      amount: number | null;
      currency: string | null;
    }>;
  };
  people: Array<{ name?: string; entityId?: string; role?: string }>;
  places: Array<{ name?: string; entityId?: string; role?: string }>;
  notes: string | null;
  occurredAt?: string | null;
  whenLabel?: "Date" | "Added";
  displayDate?: string;
  fullText?: string | null;
  sourceFile?: string | null;
  createdAt: string;
  location: string | null;
  altimetrixEventType?: string | null;
};

export async function listEvents(
  space?: IntakeSpace | "",
  cursor?: string | null,
  search?: string,
): Promise<{
  events: LifeEvent[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  if (space) params.set("space", space);
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  const query = params.toString();
  const res = await apiFetch(`/events${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ events: LifeEvent[]; nextCursor: string | null }>;
}

export async function getEvent(id: string): Promise<LifeEvent> {
  const res = await apiFetch(`/events/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<LifeEvent>;
}

export async function updateEvent(
  id: string,
  patch: {
    title?: string;
    notes?: string | null;
    space?: IntakeSpace;
    status?: string;
    altimetrixEventType?: string | null;
  },
): Promise<LifeEvent> {
  const res = await apiFetch(`/events/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<LifeEvent>;
}

export async function archiveEvent(id: string): Promise<{ success: boolean }> {
  const res = await apiFetch(`/events/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean }>;
}

export type JournalEntry = {
  id: string;
  content: string;
  occurredAt: string;
  createdAt: string;
};

export async function listJournal(): Promise<{ entries: JournalEntry[] }> {
  const res = await apiFetch("/journal");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ entries: JournalEntry[] }>;
}

export type VisionStatus = "seed" | "forming" | "held" | "active";

export type Vision = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  tags: string[];
  location: string | null;
  notes: string | null;
  space: string;
  detectedFromJournal: boolean;
  lastTouchedAt: string;
  createdAt: string;
  rawContent?: string | null;
  nudgeAfter?: string | null;
  connectedEvents?: Array<{ eventId: string; relationship?: string; title?: string }>;
  connectedEntities?: Array<{ entityId: string | null; name: string | null; relationship: string | null }>;
  altimetrixContext?: string | null;
};

export type EntityType = "person" | "place" | "project" | "organisation" | "property" | "other";

export type EntityRecord = {
  id: string;
  name: string;
  entityType: EntityType | string;
  description: string | null;
  space: string;
  status: string;
  attributes: Record<string, unknown>;
  aliases: string[];
  createdAt?: string;
  eventCount?: number;
  visionCount?: number;
  events?: Array<{ id: string; title: string }>;
  visions?: Array<{ id: string; title: string }>;
  merged?: boolean;
};

export type EntityGraph = {
  entity: EntityRecord;
  relationships: Array<{
    type: string;
    relationship: string;
    target: { id: string; name: string; entityType?: string };
  }>;
};

export type Nudge = {
  visionId: string;
  title: string;
  nudgeMessage: string;
};

export async function getStats(): Promise<{ events: number; visions: number; entities: number }> {
  const res = await apiFetch("/stats");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ events: number; visions: number; entities: number }>;
}

export async function listEntities(params: {
  entityType?: string;
  space?: string;
  search?: string;
} = {}): Promise<{ entities: EntityRecord[] }> {
  const query = new URLSearchParams();
  if (params.entityType) query.set("entityType", params.entityType);
  if (params.space) query.set("space", params.space);
  if (params.search) query.set("search", params.search);
  const text = query.toString();
  const res = await apiFetch(`/entities${text ? `?${text}` : ""}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ entities: EntityRecord[] }>;
}

export async function getEntity(id: string): Promise<EntityRecord> {
  const res = await apiFetch(`/entities/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<EntityRecord>;
}

export async function getEntityGraph(id: string): Promise<EntityGraph> {
  const res = await apiFetch(`/entities/${id}/graph`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<EntityGraph>;
}

export async function createEntity(body: {
  name: string;
  entityType: EntityType;
  description?: string;
  space?: IntakeSpace;
  attributes?: Record<string, unknown>;
  aliases?: string[];
}): Promise<EntityRecord> {
  const res = await apiFetch("/entities", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<EntityRecord>;
}

export async function updateEntity(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    status?: string;
    attributes?: Record<string, unknown>;
    aliases?: string[];
  },
): Promise<EntityRecord> {
  const res = await apiFetch(`/entities/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<EntityRecord>;
}

export async function linkEntity(
  id: string,
  body: { targetId: string; targetType: "event" | "vision" | "entity"; relationship: string },
): Promise<{ success: boolean }> {
  const res = await apiFetch(`/entities/${id}/link`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean }>;
}

export async function getPendingNudges(): Promise<{ nudges: Nudge[] }> {
  const res = await apiFetch("/visions/pending-nudges");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ nudges: Nudge[] }>;
}

export async function getVisionSuggestions(id: string): Promise<{
  suggestions: Array<{ id: string; title: string; location: string | null; tags: string[] }>;
}> {
  const res = await apiFetch(`/visions/${id}/suggestions`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{
    suggestions: Array<{ id: string; title: string; location: string | null; tags: string[] }>;
  }>;
}

export async function linkVisionEvent(id: string, eventId: string): Promise<Vision> {
  const res = await apiFetch(`/visions/${id}/link-event`, {
    method: "POST",
    body: JSON.stringify({ eventId }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<Vision>;
}

export async function getVisions(status?: VisionStatus | ""): Promise<{ visions: Vision[] }> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const query = params.toString();
  const res = await apiFetch(`/visions${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ visions: Vision[] }>;
}

export async function getVision(id: string): Promise<Vision> {
  const res = await apiFetch(`/visions/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<Vision>;
}

export async function updateVision(
  id: string,
  data: {
    title?: string;
    summary?: string | null;
    status?: string;
    tags?: string[];
    notes?: string | null;
    nudgeAfter?: string;
  },
): Promise<Vision> {
  const res = await apiFetch(`/visions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<Vision>;
}

export type CommandRecord = {
  type: "event" | "entity" | "vision";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  status?: string;
  location?: string | null;
  when?: string | null;
  amount?: number | null;
  currency?: string | null;
};

export type CommandPreview = {
  type: string;
  id: string;
  title: string;
  change: string;
};

export type CommandResult = {
  commandId: string | null;
  intentType: string;
  confidence: number;
  needsClarification: string | null;
  confirmationRequired: boolean;
  answer?: string;
  summary?: string;
  count?: number;
  results?: CommandRecord[];
  preview?: CommandPreview[];
};

export async function interpretCommand(input: string): Promise<CommandResult> {
  const res = await apiFetch("/commands/interpret", {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<CommandResult>;
}

export async function confirmCommand(
  commandId: string,
  affectedIds: string[] = [],
  confirmed = true,
): Promise<{ success: boolean; changes: string[] }> {
  const res = await apiFetch("/commands/confirm", {
    method: "POST",
    body: JSON.stringify({ commandId, confirmed, affectedIds }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{ success: boolean; changes: string[] }>;
}

export type AdvisorMessage = { role: "user" | "assistant"; content: string };

export type FactType = "financial" | "person" | "place" | "decision" | "date" | "asset" | "other";

export type FactItem = {
  factType: FactType;
  content: string;
  confidence: number;
  suggestedEventTitle: string | null;
};

export type AdvisorReply = {
  reply: string;
  contextUsed: { eventsCount: number; visionsCount: number; entitiesCount: number };
  detectedFacts: FactItem[];
};

const FACT_EVENT_TYPES: Partial<Record<FactType, string>> = {
  financial: "financial",
  decision: "commitment",
  date: "commitment",
  place: "personal",
  asset: "personal",
  other: "personal",
};

export async function advisorChat(messages: AdvisorMessage[]): Promise<AdvisorReply> {
  const res = await apiFetch("/advisor/chat", {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as AdvisorReply;
  return { ...data, detectedFacts: Array.isArray(data.detectedFacts) ? data.detectedFacts : [] };
}

export async function saveFactFromAdvisor(
  content: string,
  factType: FactType,
  suggestedEventTitle?: string | null,
): Promise<unknown> {
  const text = content.trim();
  if (factType === "person") {
    const name = personName(suggestedEventTitle || text);
    return createEntity({
      name,
      entityType: "person",
      description: text,
      space: "personal",
    });
  }
  const intake = await submitText(text.length >= 10 ? text : `${text}. Recorded.`);
  const eventType = FACT_EVENT_TYPES[factType] || "personal";
  return confirmIntake(intake.queueId, "personal", {
    eventType,
    ...(suggestedEventTitle ? { title: suggestedEventTitle } : {}),
  });
}

function personName(value: string) {
  const titled = value.match(/^([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})\b/);
  if (titled && titled[1].length >= 2 && titled[1].length <= 80) return titled[1];
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80).trim() : cleaned;
}

export async function getAdvisorSuggestions(): Promise<string[]> {
  const res = await apiFetch("/advisor/suggest");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { suggestions?: string[] };
  return Array.isArray(data.suggestions) ? data.suggestions : [];
}

export async function askCommand(input: string): Promise<string> {
  const params = new URLSearchParams({ input });
  const res = await apiFetch(`/commands/ask?${params.toString()}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.text();
}

export type HomeRouting = {
  intent: string;
  confidence: number;
  interpretation: string;
};

export type HomeClarification = {
  label: string;
  intent: string;
  description: string;
};

export type HomeResponse = {
  sessionId: string | null;
  routing: HomeRouting;
  action: "proceed" | "confirm" | "clarify";
  result: {
    type: string;
    content: unknown;
    confirmationRequired: boolean;
    confirmationText: string | null;
  };
  clarificationOptions: HomeClarification[] | null;
};

export type HomeLastAction = {
  sessionId: string | null;
  intent: string;
  summary: string;
  saved: boolean;
};

export async function homeInput(
  message: string,
  file?: File | null,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [],
  lastAction?: HomeLastAction | null,
): Promise<HomeResponse> {
  if (file) {
    const body = new FormData();
    body.append("message", message);
    body.append("conversationHistory", JSON.stringify(conversationHistory));
    if (lastAction) body.append("lastAction", JSON.stringify(lastAction));
    body.append("file", file);
    const res = await apiFetch("/home/input", { method: "POST", body });
    if (!res.ok) throw new Error(await parseError(res));
    return res.json() as Promise<HomeResponse>;
  }
  const res = await apiFetch("/home/input", {
    method: "POST",
    body: JSON.stringify({ message, conversationHistory, lastAction: lastAction || null }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<HomeResponse>;
}

export async function homeConfirm(
  sessionId: string,
  confirmed: boolean,
  options: {
    selectedOption?: string;
    space?: IntakeSpace;
    occurredAt?: string | null;
    corrections?: Record<string, unknown>;
  } = {},
): Promise<HomeResponse> {
  const res = await apiFetch("/home/confirm", {
    method: "POST",
    body: JSON.stringify({ sessionId, confirmed, ...options }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<HomeResponse>;
}

export async function saveJournal(content: string, occurredAt?: string): Promise<JournalEntry> {
  const res = await apiFetch("/journal", {
    method: "POST",
    body: JSON.stringify({ content, occurredAt }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<JournalEntry>;
}
