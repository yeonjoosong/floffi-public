// BYOK (Bring Your Own Key) helpers.
//
// User-supplied LLM API keys live ONLY in localStorage on the user's browser
// — never persisted server-side, never logged. apiFetch attaches the key to
// the X-LLM-Key request header which the server consumes transiently and then
// strips. This module is the single chokepoint that touches localStorage so
// any future migration (e.g., session-storage, encrypted-at-rest) only changes
// these few functions.

export type LLMProvider = "gemini" | "openai" | "anthropic";

export const LLM_PROVIDERS: readonly LLMProvider[] = ["gemini", "openai", "anthropic"];

export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

// Default model suggestions when the user hasn't picked one yet.
export const PROVIDER_DEFAULT_MODELS: Record<LLMProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "o4-mini",
  anthropic: "claude-sonnet-4-5-20251001",
};

const STORAGE_PREFIX = "floffi_llm_key_";

function safeLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function getKey(p: LLMProvider): string {
  return safeLocalStorage()?.getItem(STORAGE_PREFIX + p) ?? "";
}

export function setKey(p: LLMProvider, value: string): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  if (value) ls.setItem(STORAGE_PREFIX + p, value);
  else ls.removeItem(STORAGE_PREFIX + p);
}

export function clearKey(p: LLMProvider): void {
  safeLocalStorage()?.removeItem(STORAGE_PREFIX + p);
}

export function clearAllKeys(): void {
  for (const p of LLM_PROVIDERS) clearKey(p);
}

// maskKey returns a display-safe representation: first 4 + middle bullets +
// last 4 characters. Used in Settings UI so the user can recognise their key
// without re-exposing the full secret on screen.
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "•".repeat(key.length);
  return key.slice(0, 4) + "•••••••" + key.slice(-4);
}

// apiFetch wraps fetch() with two floffi conventions:
//   1. credentials: "include" so the session cookie is always sent
//   2. when `provider` is given, attaches X-LLM-Key for that provider
//
// Calls that don't go to LLM endpoints (workspace CRUD, vault search) should
// omit `provider`. Calls that DO trigger LLM upstream (task run, playground)
// should pass the provider currently active so the right key is sent.
export type APIFetchInit = RequestInit & { provider?: LLMProvider };

export async function apiFetch(input: RequestInfo | URL, init: APIFetchInit = {}): Promise<Response> {
  const { provider, headers: rawHeaders, ...rest } = init;
  const headers = new Headers(rawHeaders);
  if (provider) {
    const key = getKey(provider);
    if (key) headers.set("X-LLM-Key", key);
  }
  return fetch(input, {
    ...rest,
    credentials: "include",
    headers,
  });
}
