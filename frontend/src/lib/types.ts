export type Section = {
  id: string;
  title: string;
};

export type WorkflowStep = {
  agentId: string;
  sectionId: string;
  label: string;
};

export type NotificationTarget = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
};

export type WebhookConfig = {
  token: string;
  enabled: boolean;
};

export type TaskAttachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  storedName: string;
  uploadedAt: string;
};

export type Task = {
  id: string;
  title: string;
  description: string;
  assignee: string;
  status: string;
  createdAt: string;
  date: string;
  teamId: string;
  agentId: string;
  executionStatus: "queued" | "active" | "retrying" | "completed";
  reportId: string;
  workflowEnabled: boolean;
  workflowStep: number;
  workflowSteps: WorkflowStep[];
  accumulatedContext: string;
  attachments?: TaskAttachment[];
  // Stickers / markers the user has applied to flag the task for later
  // review. Open-ended string list so new sticker types don't require a
  // type change; the registry of valid IDs lives in lib/markers.ts.
  markers?: string[];
  // Soft-delete timestamp (RFC3339 UTC). When set, the task is hidden from
  // boards and lives in the trash UI until the server hard-deletes it.
  deletedAt?: string;
  // When true, the agent calls Gemini's image-generation model instead of
  // the text model. The returned PNG is saved as a fresh attachment.
  imageOutput?: boolean;
  // Number of variations to lay out on a single canvas when imageOutput is
  // true. 1 = no grid (single image). Allowed values: 1, 4, 6, 9, 10, 12.
  imageGridCount?: number;
};

export type Session = {
  authenticated: boolean;
  username: string;
  // Phase 11 — 서버가 회원의 고유 UUID를 함께 내려준다. 워크스페이스
  // 멤버 목록에서 "본인" 행을 식별하는 데 사용. 비로그인 응답에는 없음.
  userId?: string;
  // 사용자 표시 이름. 비어있으면 서버가 email의 local-part로 채워서 보낸다.
  // username은 내부적으로만 쓰이고, UI는 nickname을 우선 노출한다.
  nickname?: string;
  // 아바타 오버라이드(보통 이모지 한 글자). 비어있으면 nickname의 첫
  // 코드포인트(avatarInitial)로 폴백한다 — 기존 동작.
  avatar?: string;
  email?: string;
  emailVerified?: boolean;
  totpEnabled?: boolean;
  // Phase 6.4 — admin-view permission. Gates the admin section in
  // SecurityPanel + the /api/auth/admin/* endpoints. Absent === false.
  isAdmin?: boolean;
  // MFA 단계 응답: 비번 통과 후 TOTP 확인 대기 상태.
  mfaRequired?: boolean;
  challengeToken?: string;
};

export type ProviderConfig = {
  id: string;
  name: string;
  model: string;
  enabled: boolean;
};

export type ChannelBadge = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
};

export type SessionHistoryItem = {
  id: string;
  title: string;
  updatedAt: string;
  summary: string;
};

export type WorkspaceSettings = {
  orchestrationMode: "auto" | "explicit" | "manual";
  promptMode: "full" | "task" | "minimal" | "none";
  memoryLevel: "L0" | "L1" | "L2";
  // What the agent calls the user. Empty = fall back to session.username,
  // then to "보스". Set via the settings panel input.
  displayName?: string;
  // 자동 로그아웃 임계치 (분). 0 = 비활성화, 기본 15. 활동이 없는 시간이
  // 이 값을 넘으면 경고 토스트가 뜨고, 이후 카운트다운이 끝나면 자동 로그아웃.
  // 절대 한계(8시간)는 이 값과 무관하게 항상 작동.
  idleLogoutMinutes?: number;
  // AI 에이전트 토글: "ai"(기본) = LLM이 워크플로 실행. "mcp" = LLM 완전
  // 차단 — 알람/수동 실행 모두 runbook의 [MCP] 단계만 결정론적으로 실행.
  agentMode?: "ai" | "mcp";
};

export type AgentMember = {
  id: string;
  name: string;
  role: string;
  teamId: string;
  status: "idle" | "busy" | "offline";
};

export type VaultDocument = {
  id: string;
  title: string;
  note: string;
};

export type Team = {
  id: string;
  name: string;
  mission: string;
};

export type BossReport = {
  id: string;
  taskId: string;
  teamId: string;
  agentId: string;
  title: string;
  summary: string;
  deliveredAt: string;
  status: "new" | "approved" | "rejected";
  feedback?: string;
  taskTitle?: string;
  workflowEnabled?: boolean;
  workflowStep?: number;
  workflowSteps?: WorkflowStep[];
  // Stage 1-B RAG trust gating. 1.0 = "지식베이스 등록" 으로 명시 승인 →
  // 에이전트 프롬프트 inject 허용. 0.5 = 자동 (사용자 검색만), 0.0 = demote.
  // Optional — 서버는 omitempty 로 보내므로 미설정/0 값을 자동 0.5 로 해석.
  trustScore?: number;
  approvedBy?: string;
  approvedAt?: string;
};

export type WorkspaceState = {
  boardTitle: string;
  sections: Section[];
  tasks: Task[];
  workspaceSettings: WorkspaceSettings;
  teams: Team[];
  teamMembers: AgentMember[];
  vaultDocs: VaultDocument[];
  providers: ProviderConfig[];
  channels: ChannelBadge[];
  sessions: SessionHistoryItem[];
  bossReports: BossReport[];
  webhookConfig: WebhookConfig;
  notifications: NotificationTarget[];
};

export type VaultSearchResponse = {
  results: VaultDocument[];
};
