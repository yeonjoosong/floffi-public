import { useEffect, useState } from "react";
import { BYOKSection } from "./BYOKSection";
import { NotificationSection, WebhookSection } from "./SettingsDeliverySections";
import { ThemeCustomPanel } from "./ThemeCustomPanel";
import { Card, EmptyMsg, FField, FSelect, SideSection, Toggle } from "./BoardViewPrimitives";
import { THEME_LABELS } from "../lib/theme";
import type { ThemeMode, ThemeState } from "../lib/theme";
import { getKey, type LLMProvider } from "../lib/byok";
import { MODEL_OPTIONS, findModel, isProviderEnabled, tierBadge } from "../lib/models";
import type { ChannelBadge, NotificationTarget, ProviderConfig, WebhookConfig, WorkspaceSettings } from "../lib/types";

const KNOWN_PROVIDERS = new Set<string>(["gemini", "openai", "anthropic"]);
function asLLMProvider(id: string): LLMProvider | null {
  const lower = id.toLowerCase();
  return KNOWN_PROVIDERS.has(lower) ? (lower as LLMProvider) : null;
}

function WarningIcon(props: { size?: number; className?: string }) {
  const size = props.size ?? 16;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={["inline-block", props.className ?? ""].join(" ")}>
      <path d="M8 1.5L15 14H1L8 1.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.5V9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function BoardSettingsGeneralPanel(props: {
  themeState: ThemeState;
  workspaceSettings: WorkspaceSettings;
  onThemeModeChange: (mode: ThemeMode) => void;
  onAccentColorChange: (color: string) => void;
  onKitschNameChange: (name: string) => void;
  onToyChassisColorChange: (color: string) => void;
  onBaseColorChange: (color: string) => void;
  onTextColorChange: (color: string) => void;
  onWorkspaceSettingsChange: (value: WorkspaceSettings) => void;
}) {
  return (
    <>
      <SideSection title="테마">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-[11px] text-t3">화면 모드</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(["dark", "light", "system", "kitsch", "candy", "toy", "win98"] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => props.onThemeModeChange(mode)}
                  className={[
                    "rounded-xl border py-2 text-[11px] font-bold transition",
                    props.themeState.mode === mode ? "border-ac bg-ac/15 text-ac" : "border-bd/10 bg-s2 text-t2 hover:bg-s3 hover:text-t1",
                  ].join(" ")}
                >
                  {mode === "kitsch" ? (props.themeState.kitschName || THEME_LABELS.kitsch) : THEME_LABELS[mode]}
                </button>
              ))}
            </div>
          </div>

          <ThemeCustomPanel
            themeState={props.themeState}
            onAccentColorChange={props.onAccentColorChange}
            onBaseColorChange={props.onBaseColorChange}
            onTextColorChange={props.onTextColorChange}
            onToyChassisColorChange={props.onToyChassisColorChange}
            onKitschNameChange={props.onKitschNameChange}
          />
        </div>
      </SideSection>

      <SideSection title="워크스페이스">
        <div className="space-y-3">
          <FField label="오케스트레이션 모드">
            <FSelect
              value={props.workspaceSettings.orchestrationMode}
              onChange={(value) => props.onWorkspaceSettingsChange({ ...props.workspaceSettings, orchestrationMode: value as WorkspaceSettings["orchestrationMode"] })}
              options={[{ value: "auto", label: "자동" }, { value: "explicit", label: "명시적" }, { value: "manual", label: "수동" }]}
            />
          </FField>
          <FField label="프롬프트 모드">
            <FSelect
              value={props.workspaceSettings.promptMode}
              onChange={(value) => props.onWorkspaceSettingsChange({ ...props.workspaceSettings, promptMode: value as WorkspaceSettings["promptMode"] })}
              options={[{ value: "full", label: "전체" }, { value: "task", label: "태스크" }, { value: "minimal", label: "최소" }, { value: "none", label: "없음" }]}
            />
          </FField>
          <FField label="메모리 티어">
            <FSelect
              value={props.workspaceSettings.memoryLevel}
              onChange={(value) => props.onWorkspaceSettingsChange({ ...props.workspaceSettings, memoryLevel: value as WorkspaceSettings["memoryLevel"] })}
              options={[{ value: "L0", label: "L0 · 단기" }, { value: "L1", label: "L1 · 에피소드" }, { value: "L2", label: "L2 · 의미론적" }]}
            />
            <p className="mt-1.5 text-[11px] text-t3">
              {{ L0: "태스크 완료 후 초기화. 독립적·격리 작업에 적합.", L1: "세션 내 태스크 간 결과를 연결합니다. (기본값)", L2: "패턴을 추출해 장기 지식으로 축적합니다." }[props.workspaceSettings.memoryLevel]}
            </p>
          </FField>
          <FField label="자동 로그아웃">
            <FSelect
              value={String(props.workspaceSettings.idleLogoutMinutes ?? 15)}
              onChange={(value) => props.onWorkspaceSettingsChange({ ...props.workspaceSettings, idleLogoutMinutes: Number(value) })}
              options={[
                { value: "0", label: "사용 안 함" },
                { value: "5", label: "5분" },
                { value: "15", label: "15분 (기본)" },
                { value: "30", label: "30분" },
                { value: "60", label: "1시간" },
              ]}
            />
          </FField>
        </div>
      </SideSection>
    </>
  );
}

export function BoardSettingsAIPanel(props: {
  workspaceSettings: WorkspaceSettings;
  providers: ProviderConfig[];
  onWorkspaceSettingsChange: (value: WorkspaceSettings) => void;
  onToggleProvider: (providerId: string) => void;
  onProviderModelChange: (providerId: string, model: string) => void;
  onOpenPlayground: () => void;
}) {
  const [byokKeys, setByokKeys] = useState<Record<LLMProvider, string>>(() => ({
    gemini: getKey("gemini"),
    openai: getKey("openai"),
    anthropic: getKey("anthropic"),
  }));

  useEffect(() => {
    setByokKeys({ gemini: getKey("gemini"), openai: getKey("openai"), anthropic: getKey("anthropic") });
  }, []);

  function focusBYOKInput(provider: LLMProvider) {
    const element = document.getElementById(`byok-input-${provider}`) as HTMLInputElement | null;
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    requestAnimationFrame(() => element.focus());
  }

  return (
    <>
      <SideSection title="AI 에이전트">
        <Card>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-t1">AI 에이전트 실행</p>
            <Toggle
              on={(props.workspaceSettings.agentMode ?? "ai") === "ai"}
              onClick={() => props.onWorkspaceSettingsChange({
                ...props.workspaceSettings,
                agentMode: (props.workspaceSettings.agentMode ?? "ai") === "ai" ? "mcp" : "ai",
              })}
            />
          </div>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-t3">
            {(props.workspaceSettings.agentMode ?? "ai") === "ai"
              ? "ON — AI 에이전트가 워크플로(5단계)를 실행합니다."
              : "OFF — LLM 호출이 완전히 차단됩니다. 알람·수동 실행은 runbook의 [MCP] 섹션에 정의된 MCP 도구만 순서대로 실행하고, 수집된 원시 값으로 보고서를 만듭니다."}
          </p>
        </Card>
      </SideSection>

      <SideSection title="AI 프로바이더">
        {props.providers.length === 0 ? (
          <EmptyMsg>프로바이더가 없습니다.</EmptyMsg>
        ) : (
          <div className="space-y-2">
            {props.providers.map((provider) => {
              const llm = asLLMProvider(provider.id);
              const options = llm ? MODEL_OPTIONS[llm] : [];
              const disabled = llm ? !isProviderEnabled(llm) : false;
              const matched = llm ? findModel(llm, provider.model) : null;
              const badge = matched ? tierBadge(matched.tier) : null;
              const hasKey = llm ? !!byokKeys[llm] : false;
              const showNeedsKeyBadge = !!llm && !disabled && provider.enabled && !hasKey;
              const showKeyOnlyLabel = !!llm && !disabled && !provider.enabled && hasKey;
              return (
                <Card key={provider.id}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="text-sm font-bold text-t1">{provider.name}</p>
                      {disabled ? <span className="rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-700">준비중</span> : null}
                    </div>
                    <Toggle on={!disabled && provider.enabled} onClick={() => props.onToggleProvider(provider.id)} disabled={disabled} />
                  </div>
                  {showNeedsKeyBadge ? (
                    <button
                      type="button"
                      onClick={() => llm && focusBYOKInput(llm)}
                      className="mt-2 flex w-full items-center gap-1.5 rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1 text-left text-[10.5px] font-bold text-amber-700 transition hover:bg-amber-500/20 dark:text-amber-400"
                    >
                      <WarningIcon size={11} className="shrink-0" />
                      <span>API 키 등록</span>
                    </button>
                  ) : showKeyOnlyLabel ? (
                    <p className="mt-1.5 text-[10.5px] font-bold leading-tight text-t3">키 등록됨 · 비활성</p>
                  ) : null}
                  {options.length > 0 ? (
                    <div className="mt-2 flex items-center gap-2">
                      <select
                        value={provider.model}
                        disabled={disabled}
                        onChange={(e) => props.onProviderModelChange(provider.id, e.target.value)}
                        className={[
                          "min-w-0 flex-1 rounded-xl border border-bd/10 bg-s2 px-3 py-1.5 text-xs text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15",
                          disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                        ].join(" ")}
                      >
                        {!matched && provider.model ? <option value={provider.model} disabled>{provider.model}</option> : null}
                        {options.map((option) => <option key={option.id} value={option.id}>{option.id}</option>)}
                      </select>
                      {badge ? (
                        <span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-bold ${badge.className}`}>{badge.label}</span>
                      ) : provider.model ? (
                        <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-1 text-[10px] font-bold text-amber-400">비표준</span>
                      ) : null}
                    </div>
                  ) : (
                    <input
                      className="mt-2 w-full rounded-xl border border-bd/10 bg-s2 px-3 py-1.5 text-xs text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15"
                      value={provider.model}
                      onChange={(e) => props.onProviderModelChange(provider.id, e.target.value)}
                      placeholder="모델명"
                    />
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </SideSection>

      <SideSection title="API 키 (BYOK)">
        <BYOKSection onKeysChange={setByokKeys} />
      </SideSection>

      <SideSection title="모델 테스트">
        <button
          type="button"
          onClick={props.onOpenPlayground}
          className="w-full rounded-xl border border-ac/30 bg-ac/15 px-3 py-2 text-xs font-bold text-ac transition hover:bg-ac/25"
        >
          플레이그라운드 열기
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-t3">프로바이더·모델·프롬프트를 골라 한 번씩 테스트. 워크스페이스에는 영향 없음.</p>
      </SideSection>
    </>
  );
}

export function BoardSettingsNotificationsPanel(props: {
  channels: ChannelBadge[];
  webhookConfig: WebhookConfig;
  notifications: NotificationTarget[];
  onToggleChannel: (channelId: string) => void;
  onUpdateWebhookConfig: (next: Partial<WebhookConfig>) => void;
  onRegenerateWebhookToken: () => void;
  onAddNotification: (name: string, url: string) => void;
  onRemoveNotification: (id: string) => void;
  onToggleNotification: (id: string) => void;
  onUpdateNotification: (id: string, name: string, url: string) => void;
}) {
  return (
    <>
      <SideSection title="채널">
        {props.channels.length === 0 ? (
          <EmptyMsg>채널이 없습니다.</EmptyMsg>
        ) : (
          <div className="space-y-2">
            {props.channels.map((channel) => (
              <Card key={channel.id}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-t1">{channel.name}</p>
                    <p className="text-[11px] text-t3">{channel.status}</p>
                  </div>
                  <Toggle on={channel.enabled} onClick={() => props.onToggleChannel(channel.id)} />
                </div>
              </Card>
            ))}
          </div>
        )}
      </SideSection>

      <WebhookSection
        config={props.webhookConfig}
        onToggle={() => props.onUpdateWebhookConfig({ enabled: !props.webhookConfig.enabled })}
        onRegenerate={props.onRegenerateWebhookToken}
      />

      <NotificationSection
        notifications={props.notifications}
        onAdd={props.onAddNotification}
        onRemove={props.onRemoveNotification}
        onToggle={props.onToggleNotification}
        onUpdate={props.onUpdateNotification}
      />
    </>
  );
}
