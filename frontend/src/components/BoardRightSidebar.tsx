import { MemoryPanel } from "./MemoryPanel";
import { SecurityPanel } from "./SecurityPanel";
import { WorkspaceSettingsPanel } from "./WorkspaceSettingsPanel";
import { BoardHistoryPanel, BoardVaultPanel } from "./BoardKnowledgePanels";
import { BoardInboxPanel, type InboxFilter } from "./BoardInboxPanel";
import { BoardSettingsAIPanel, BoardSettingsGeneralPanel, BoardSettingsNotificationsPanel } from "./BoardSettingsPanels";
import type {
  AgentMember,
  BossReport,
  ChannelBadge,
  NotificationTarget,
  ProviderConfig,
  SessionHistoryItem,
  Task,
  Team,
  VaultDocument,
  WebhookConfig,
  WorkspaceSettings,
} from "../lib/types";
import type { ThemeMode, ThemeState } from "../lib/theme";
import type { WorkspaceListItem } from "../lib/workspaces";
import type { RefObject } from "react";

export type RightTab = "inbox" | "settings" | "vault" | "history";
export type SettingsSubTab = "general" | "workspace" | "security" | "memory" | "ai" | "notifications";

function SidebarTab(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-role={props.active ? "sidebar-tab-active" : "sidebar-tab"}
      className={[
        "flex h-12 flex-1 items-center justify-center gap-1.5 whitespace-nowrap px-3 text-xs font-bold transition",
        props.active ? "border-b-2 border-ac text-t1" : "text-t3 hover:text-t2",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

export function BoardRightSidebar(props: {
  rightDrawerOpen: boolean;
  rightDrawerScrollRef: RefObject<HTMLDivElement | null>;
  rightTab: RightTab;
  settingsSubTab: SettingsSubTab;
  unreadCount: number;
  nickname: string;
  avatarLabel: string;
  bossReports: BossReport[];
  teams: Team[];
  teamMembers: AgentMember[];
  tasks: Task[];
  inboxFilter: InboxFilter;
  inboxFilterOpen: boolean;
  themeState: ThemeState;
  workspaceSettings: WorkspaceSettings;
  workspaceList: WorkspaceListItem[];
  activeWorkspaceID: string;
  selfUserID: string;
  totpEnabled: boolean;
  emailVerified: boolean;
  sessionEmail: string;
  isAdmin: boolean;
  providers: ProviderConfig[];
  channels: ChannelBadge[];
  webhookConfig: WebhookConfig;
  notifications: NotificationTarget[];
  vaultSearchQuery: string;
  vaultSearchResults: VaultDocument[];
  vaultSearchLoading: boolean;
  newVaultTitle: string;
  newVaultNote: string;
  vaultDocs: VaultDocument[];
  sessions: SessionHistoryItem[];
  onOpenUserInfo: () => void;
  onLogout: () => void;
  onSetRightTab: (tab: RightTab) => void;
  onSetSettingsSubTab: (tab: SettingsSubTab) => void;
  onToggleInboxFilterOpen: () => void;
  onInboxFilterChange: (next: InboxFilter) => void;
  onOpenClearInbox: () => void;
  onApproveReport: (reportId: string) => void;
  onRejectReport: (reportId: string, feedback: string) => void;
  onRestoreTask: (reportId: string) => void;
  onStartTask: (taskId: string, status: Task["executionStatus"]) => void;
  onApproveKBReport: (reportId: string) => void;
  onDemoteKBReport: (reportId: string) => void;
  onResetKBReport: (reportId: string) => void;
  onThemeModeChange: (mode: ThemeMode) => void;
  onAccentColorChange: (color: string) => void;
  onKitschNameChange: (name: string) => void;
  onToyChassisColorChange: (color: string) => void;
  onBaseColorChange: (color: string) => void;
  onTextColorChange: (color: string) => void;
  onWorkspaceSettingsChange: (value: WorkspaceSettings) => void;
  onReloadWorkspaces: () => Promise<void>;
  onSwitchWorkspace: (workspaceId: string) => void;
  onResendVerifyEmail: () => void;
  onSessionInvalidated: () => void;
  onAccountDeleted: () => void;
  onToggleProvider: (providerId: string) => void;
  onProviderModelChange: (providerId: string, model: string) => void;
  onOpenPlayground: () => void;
  onToggleChannel: (channelId: string) => void;
  onUpdateWebhookConfig: (next: Partial<WebhookConfig>) => void;
  onRegenerateWebhookToken: () => void;
  onAddNotification: (name: string, url: string) => void;
  onRemoveNotification: (id: string) => void;
  onToggleNotification: (id: string) => void;
  onUpdateNotification: (id: string, name: string, url: string) => void;
  onVaultSearchQueryChange: (value: string) => void;
  onNewVaultTitleChange: (value: string) => void;
  onNewVaultNoteChange: (value: string) => void;
  onAddVaultDoc: () => void;
  onRemoveVaultDoc: (docId: string) => void;
}) {
  return (
    <aside
      data-role="right-sidebar"
      className={[
        "flex w-[85vw] max-w-[340px] shrink-0 flex-col overflow-hidden border-l border-bd/10 bg-s1",
        "max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:shadow-2xl max-md:transition-transform max-md:duration-200",
        props.rightDrawerOpen ? "max-md:translate-x-0" : "max-md:translate-x-full",
        "md:w-72 md:translate-x-0 xl:w-80",
      ].join(" ")}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-bd/10 px-3 py-2.5 md:hidden">
        <button
          type="button"
          onClick={props.onOpenUserInfo}
          aria-label="사용자 정보"
          title={props.nickname}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 py-1.5 transition hover:bg-s2"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ac text-xs font-black text-white"
            style={{ fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",inherit' }}
          >
            {props.avatarLabel}
          </span>
          <span className="truncate text-sm font-bold text-t1">{props.nickname}</span>
        </button>
        <button
          type="button"
          onClick={props.onLogout}
          className="shrink-0 rounded-xl border border-bd/12 bg-s2 px-3 py-1.5 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1"
        >
          로그아웃
        </button>
      </div>

      <div className="flex shrink-0 items-center overflow-x-auto border-b border-bd/10">
        <SidebarTab active={props.rightTab === "inbox"} onClick={() => props.onSetRightTab("inbox")}>
          받은함
          {props.unreadCount > 0 ? (
            <span className="ml-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-ac text-[9px] font-black text-white">
              {props.unreadCount}
            </span>
          ) : null}
        </SidebarTab>
        <SidebarTab active={props.rightTab === "settings"} onClick={() => props.onSetRightTab("settings")}>설정</SidebarTab>
        <SidebarTab active={props.rightTab === "vault"} onClick={() => props.onSetRightTab("vault")}>보관함</SidebarTab>
        <SidebarTab active={props.rightTab === "history"} onClick={() => props.onSetRightTab("history")}>기록</SidebarTab>
      </div>

      {props.rightTab === "settings" ? (
        <div className="shrink-0 border-b border-bd/10 bg-s1 px-4 py-2">
          {([
            {
              label: "계정 및 워크스페이스",
              tabs: [
                { value: "general", label: "일반" },
                { value: "workspace", label: "워크스페이스" },
                { value: "security", label: "보안" },
              ],
            },
            {
              label: "운영 및 자동화",
              tabs: [
                { value: "ai", label: "AI" },
                { value: "notifications", label: "알림" },
                { value: "memory", label: "메모리" },
              ],
            },
          ] as Array<{ label: string; tabs: Array<{ value: SettingsSubTab; label: string }> }>).map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-t3">{group.label}</p>
              <div className="grid grid-cols-3 gap-1">
                {group.tabs.map((tab) => {
                  const active = props.settingsSubTab === tab.value;
                  return (
                    <button
                      key={tab.value}
                      type="button"
                      data-role="icon-btn"
                      onClick={() => props.onSetSettingsSubTab(tab.value)}
                      aria-pressed={active}
                      className={[
                        "rounded-lg px-2 py-1.5 text-[11px] font-bold transition-colors",
                        active ? "bg-ac/10 text-ac" : "text-t3 hover:bg-s2 hover:text-t1",
                      ].join(" ")}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div ref={props.rightDrawerScrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 [scrollbar-gutter:stable]">
        {props.rightTab === "inbox" ? (
          <BoardInboxPanel
            bossReports={props.bossReports}
            teams={props.teams}
            teamMembers={props.teamMembers}
            tasks={props.tasks}
            inboxFilter={props.inboxFilter}
            inboxFilterOpen={props.inboxFilterOpen}
            onToggleFilterOpen={props.onToggleInboxFilterOpen}
            onInboxFilterChange={props.onInboxFilterChange}
            onClearInboxOpen={props.onOpenClearInbox}
            onApproveReport={props.onApproveReport}
            onRejectReport={props.onRejectReport}
            onRestoreTask={props.onRestoreTask}
            onStartTask={props.onStartTask}
            onApproveKBReport={props.onApproveKBReport}
            onDemoteKBReport={props.onDemoteKBReport}
            onResetKBReport={props.onResetKBReport}
          />
        ) : null}

        {props.rightTab === "settings" ? (
          <>
            {props.settingsSubTab === "general" ? (
              <BoardSettingsGeneralPanel
                themeState={props.themeState}
                workspaceSettings={props.workspaceSettings}
                onThemeModeChange={props.onThemeModeChange}
                onAccentColorChange={props.onAccentColorChange}
                onKitschNameChange={props.onKitschNameChange}
                onToyChassisColorChange={props.onToyChassisColorChange}
                onBaseColorChange={props.onBaseColorChange}
                onTextColorChange={props.onTextColorChange}
                onWorkspaceSettingsChange={props.onWorkspaceSettingsChange}
              />
            ) : null}
            {props.settingsSubTab === "workspace" ? (
              <WorkspaceSettingsPanel
                active={props.workspaceList.find((workspace) => workspace.id === props.activeWorkspaceID) ?? null}
                selfUserID={props.selfUserID}
                onRefreshList={props.onReloadWorkspaces}
                onSwitchAway={(leavingId) => {
                  const next = props.workspaceList.find((workspace) => workspace.id !== leavingId);
                  if (next) props.onSwitchWorkspace(next.id);
                }}
              />
            ) : null}
            {props.settingsSubTab === "security" ? (
              <SecurityPanel
                totpEnabled={props.totpEnabled}
                emailVerified={props.emailVerified}
                onResendVerifyEmail={props.onResendVerifyEmail}
                onTotpChanged={props.onSessionInvalidated}
                onAccountDeleted={props.onAccountDeleted}
                sessionEmail={props.sessionEmail}
                isAdmin={props.isAdmin}
              />
            ) : null}
            {props.settingsSubTab === "memory" ? <MemoryPanel /> : null}
            {props.settingsSubTab === "ai" ? (
              <BoardSettingsAIPanel
                workspaceSettings={props.workspaceSettings}
                providers={props.providers}
                onWorkspaceSettingsChange={props.onWorkspaceSettingsChange}
                onToggleProvider={props.onToggleProvider}
                onProviderModelChange={props.onProviderModelChange}
                onOpenPlayground={props.onOpenPlayground}
              />
            ) : null}
            {props.settingsSubTab === "notifications" ? (
              <BoardSettingsNotificationsPanel
                channels={props.channels}
                webhookConfig={props.webhookConfig}
                notifications={props.notifications}
                onToggleChannel={props.onToggleChannel}
                onUpdateWebhookConfig={props.onUpdateWebhookConfig}
                onRegenerateWebhookToken={props.onRegenerateWebhookToken}
                onAddNotification={props.onAddNotification}
                onRemoveNotification={props.onRemoveNotification}
                onToggleNotification={props.onToggleNotification}
                onUpdateNotification={props.onUpdateNotification}
              />
            ) : null}
          </>
        ) : null}

        {props.rightTab === "vault" ? (
          <BoardVaultPanel
            vaultSearchQuery={props.vaultSearchQuery}
            vaultSearchResults={props.vaultSearchResults}
            vaultSearchLoading={props.vaultSearchLoading}
            newVaultTitle={props.newVaultTitle}
            newVaultNote={props.newVaultNote}
            vaultDocs={props.vaultDocs}
            onVaultSearchQueryChange={props.onVaultSearchQueryChange}
            onNewVaultTitleChange={props.onNewVaultTitleChange}
            onNewVaultNoteChange={props.onNewVaultNoteChange}
            onAddVaultDoc={props.onAddVaultDoc}
            onRemoveVaultDoc={props.onRemoveVaultDoc}
          />
        ) : null}

        {props.rightTab === "history" ? <BoardHistoryPanel sessions={props.sessions} /> : null}
      </div>
    </aside>
  );
}
