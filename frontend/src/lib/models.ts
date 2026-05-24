import type { LLMProvider } from "./byok";

// Curated model lineup. Free-text model entry was deliberately removed in
// favour of this list — the trade-offs are documented in chat (floffi users
// are small-team / free-tier; the safety of "no silent paid-model typos" beats
// the freedom of arbitrary model names).
//
// When a new model needs adding: append here, no other code changes required.

export type ModelTier = "free" | "cheap" | "standard" | "expensive";

export type ModelOption = {
  id: string;
  label: string;   // short human description
  tier: ModelTier;
};

export const MODEL_OPTIONS: Record<LLMProvider, ModelOption[]> = {
  gemini: [
    { id: "gemini-2.5-flash", label: "빠름 · 무료 티어",   tier: "free" },
    { id: "gemini-2.5-pro",   label: "가장 정확",          tier: "expensive" },
  ],
  openai: [
    { id: "o4-mini",      label: "추론형",  tier: "cheap" },
    { id: "gpt-4o-mini",  label: "가성비",  tier: "cheap" },
    { id: "gpt-4o",       label: "균형",    tier: "standard" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001",   label: "빠름",        tier: "cheap" },
    { id: "claude-sonnet-4-5-20251001",  label: "균형",        tier: "standard" },
    { id: "claude-opus-4-5-20251001",    label: "최고 정확도", tier: "expensive" },
  ],
};

// First option in each provider's list is the default for new workspaces.
export function defaultModelFor(provider: LLMProvider): string {
  return MODEL_OPTIONS[provider][0].id;
}

// Providers temporarily not wired for runtime use — UI shows them as disabled.
// Anthropic stays in this set until model IDs are verified against an account
// and the provider toggle is unfrozen.
export const DISABLED_PROVIDERS: ReadonlySet<LLMProvider> = new Set<LLMProvider>(["anthropic"]);

export function isProviderEnabled(provider: LLMProvider): boolean {
  return !DISABLED_PROVIDERS.has(provider);
}

// findModel returns the curated option that matches `id`, or null if the saved
// value falls outside the curated set (legacy / hand-edited workspaces).
export function findModel(provider: LLMProvider, id: string): ModelOption | null {
  return MODEL_OPTIONS[provider].find((o) => o.id === id) ?? null;
}

// tierBadge returns Tailwind class fragments for the cost/availability badge,
// or null when no badge should be shown. We intentionally only badge "free"
// and "standard" — "cheap" and "expensive" labels were dropped because they
// felt judgmental and didn't add useful information for picking a model.
export function tierBadge(tier: ModelTier): { className: string; label: string } | null {
  switch (tier) {
    case "free":
      return { className: "bg-green-800/25 text-green-700", label: "무료" };
    case "standard":
      return { className: "bg-bd/15 text-t2", label: "표준" };
    case "cheap":
    case "expensive":
      return null;
  }
}
