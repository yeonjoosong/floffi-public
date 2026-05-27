import { useState } from "react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import type { WorkspaceListItem } from "../lib/workspaces";

type ExecStatus = "queued" | "active" | "retrying" | "completed";

type BoardTopBarProps = {
  boardTitle: string;
  rightTab: "inbox" | "settings" | "vault" | "history";
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;
  statusPanelOpen: boolean;
  forceCompact: boolean;
  unreadCount: number;
  activeCount: number;
  retryingCount: number;
  queuedCount: number;
  nickname: string;
  avatarLabel: string;
  emailVerified: boolean;
  workspaceList: WorkspaceListItem[];
  activeWorkspaceID: string;
  workspaceCap: number;
  onReloadWorkspace: () => void;
  onBoardTitleChange: (value: string) => void;
  onToggleLeftDrawer: () => void;
  onSetLeftTabTeams: () => void;
  onToggleStatusPanel: () => void;
  onOpenInboxDrawer: () => void;
  onOpenUserInfo: () => void;
  onLogout: () => void;
  onToggleForceCompact: () => void;
  onOpenSettingsDrawer: () => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string) => Promise<void>;
  onReloadWorkspaces: () => Promise<void>;
  onDismissAllDrawers: () => void;
  onFocusExecution: (status: ExecStatus) => void;
  onResendVerifyEmail: () => void;
};

function StatChip(props: {
  label: string;
  value: number;
  color: "ac" | "ok" | "warn" | "err";
  pulse?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const cls: Record<string, string> = {
    ac: "border-ac/25 bg-ac/10 text-ac-lo",
    ok: "border-ok/30 bg-ok/10 text-ok",
    warn: "border-warn/30 bg-warn/10 text-warn",
    err: "border-err/30 bg-err/10 text-err",
  };
  const hoverCls: Record<string, string> = {
    ac: "hover:bg-ac/20",
    ok: "hover:bg-ok/20",
    warn: "hover:bg-warn/20",
    err: "hover:bg-err/20",
  };
  const dot: Record<string, string> = {
    ac: "bg-ac", ok: "bg-ok", warn: "bg-warn", err: "bg-err",
  };
  const base = `flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-semibold ${cls[props.color]}`;
  const inner = (
    <>
      {props.pulse ? <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${dot[props.color]}`} /> : null}
      <span className="font-black">{props.value}</span>
      <span className="text-[11px] opacity-70">{props.label}</span>
    </>
  );
  if (props.onClick) {
    return <button type="button" data-role="stat-chip" onClick={props.onClick} title={props.title} className={`${base} cursor-pointer transition ${hoverCls[props.color]} active:scale-95`}>{inner}</button>;
  }
  return <div data-role="stat-chip" title={props.title} className={`${base} opacity-60`}>{inner}</div>;
}

function BoardTitleInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  if (!focused && draft !== value) setDraft(value);

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); onChange(draft); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      className="min-w-0 flex-1 truncate bg-transparent text-sm font-black tracking-tight text-t1 outline-none md:text-base"
    />
  );
}

function EmailVerifyBanner({ emailVerified, onResend }: { emailVerified: boolean; onResend: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (emailVerified || dismissed) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-ac/30 bg-ac/15 px-4 py-2 text-xs">
      <span className="font-bold text-t1">이메일 인증이 완료되지 않았어요.</span>
      <span className="text-t2">메일함의 인증 링크를 눌러 완료해주세요.</span>
      <button type="button" onClick={onResend} className="ml-auto rounded-md border border-ac/40 bg-ac/20 px-2 py-1 text-[11px] font-bold text-ac transition hover:bg-ac/30">인증 메일 재발송</button>
      <button type="button" onClick={() => setDismissed(true)} aria-label="배너 닫기" className="rounded-md px-1 text-t3 hover:text-t1">✕</button>
    </div>
  );
}

function HamburgerIcon() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
}

function GearIcon() {
  return <svg width="16" height="16" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" /><path d="M10 1.5v3M10 15.5v3M3.5 10h-3M19.5 10h-3M5.4 5.4l-2.1-2.1M16.7 16.7l-2.1-2.1M5.4 14.6l-2.1 2.1M16.7 3.3l-2.1 2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>;
}

function CompactToggleIcon(props: { active: boolean }) {
  if (props.active) {
    return <svg width="16" height="16" viewBox="0 0 18 18" fill="none"><rect x="5" y="1.5" width="8" height="15" rx="1.6" stroke="currentColor" strokeWidth="2.2" /><path d="M8 14h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>;
  }
  return <svg width="16" height="16" viewBox="0 0 18 18" fill="none"><rect x="1.5" y="3" width="15" height="10" rx="1.4" stroke="currentColor" strokeWidth="2.2" /><path d="M6 16h6M9 13v3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /></svg>;
}

export function BoardTopBar(props: BoardTopBarProps) {
  const backlogCount = props.retryingCount + props.queuedCount;

  return (
    <>
      <header data-role="topbar" className="flex h-14 shrink-0 items-center gap-2 border-b border-bd/10 bg-s1 px-3 md:gap-3 md:px-4 xl:gap-4 xl:px-6">
        <button type="button" onClick={() => { if (!props.leftDrawerOpen) props.onSetLeftTabTeams(); props.onToggleLeftDrawer(); }} aria-label={props.leftDrawerOpen ? "메뉴 닫기" : "메뉴 열기"} aria-pressed={props.leftDrawerOpen} title={props.leftDrawerOpen ? "메뉴 닫기" : "메뉴 열기"} className={["flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition md:hidden", props.leftDrawerOpen ? "bg-s2 text-t1" : "text-t2 hover:bg-s2 hover:text-t1"].join(" ")}><HamburgerIcon /></button>
        <button type="button" onClick={props.onReloadWorkspace} className="flex shrink-0 items-center gap-2.5 rounded-full p-1 transition hover:bg-s2 active:scale-95"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-ac text-[11px] font-black tracking-tight text-white">FL</div><span className="hidden pr-2 text-base font-black tracking-tight text-t1 md:block">Floffi</span></button>
        <div className="hidden h-5 w-px shrink-0 bg-bd/10 xl:block" />
        <BoardTitleInput value={props.boardTitle} onChange={props.onBoardTitleChange} placeholder="워크스페이스 이름" />
        <WorkspaceSwitcher workspaces={props.workspaceList} activeID={props.activeWorkspaceID} cap={props.workspaceCap} onSwitch={props.onSwitchWorkspace} onCreate={props.onCreateWorkspace} onReload={props.onReloadWorkspaces} />
        <div className="ml-auto hidden items-center gap-1.5 lg:flex xl:gap-2">
          <StatChip label="받은함" value={props.unreadCount} color="ac" pulse={props.unreadCount > 0} title="받은함으로 이동" onClick={props.onOpenInboxDrawer} />
          <StatChip label="실행중" value={props.activeCount} color="ok" title={props.activeCount > 0 ? "실행중 태스크 보기" : "실행중 태스크 없음"} onClick={props.activeCount > 0 ? () => props.onFocusExecution("active") : undefined} />
          <StatChip
            label="대기/재시도"
            value={backlogCount}
            color="warn"
            pulse={backlogCount > 0}
            title={backlogCount > 0 ? "대기 또는 재요청중 태스크 보기" : "대기 또는 재요청중 태스크 없음"}
            onClick={backlogCount > 0 ? () => props.onFocusExecution(props.retryingCount > 0 ? "retrying" : "queued") : undefined}
          />
        </div>
        <div className="ml-auto flex items-center gap-1 md:hidden">
          <button type="button" data-role="status-panel-trigger" onClick={props.onToggleStatusPanel} aria-expanded={props.statusPanelOpen} aria-label={props.statusPanelOpen ? "상태 패널 닫기" : "상태 패널 열기"} title={props.statusPanelOpen ? "상태 패널 닫기" : "상태 패널 열기"} className={["relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition", props.statusPanelOpen ? "bg-s2 text-t1" : "text-t2 hover:bg-s2 hover:text-t1"].join(" ")}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" className={`transition-transform ${props.statusPanelOpen ? "rotate-180" : ""}`} aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>{props.retryingCount > 0 ? <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-warn ring-1 ring-s1" aria-hidden="true" /> : null}</button>
          <button type="button" onClick={props.onOpenInboxDrawer} aria-pressed={props.rightDrawerOpen && props.rightTab === "inbox"} aria-label={props.unreadCount > 0 ? `받은함 ${props.unreadCount}건` : "받은함"} className={["relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition", props.rightDrawerOpen && props.rightTab === "inbox" ? "bg-s2 text-t1" : props.unreadCount > 0 ? "text-ac hover:bg-s2" : "text-t2 hover:bg-s2 hover:text-t1"].join(" ")}><svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M 3 4 H 13 V 11 H 9.5 L 8.5 12 H 7.5 L 6.5 11 H 3 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /><path d="M 3 4 L 5.5 7 H 10.5 L 13 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round" /></svg>{props.unreadCount > 0 ? <span className="absolute right-1 top-1 h-2 w-2 animate-pulse rounded-full bg-ac ring-1 ring-s1" aria-hidden="true" /> : null}</button>
        </div>
        <div className="ml-2 hidden shrink-0 items-center gap-2 md:flex"><button type="button" onClick={props.onOpenUserInfo} aria-label="사용자 정보" title={props.nickname} className="flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition hover:bg-s2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ac text-xs font-black text-white" style={{ fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",inherit' }}>{props.avatarLabel}</span><span className="hidden text-sm text-t2 2xl:block">{props.nickname}</span></button><button type="button" onClick={props.onLogout} className="rounded-xl border border-bd/12 bg-s2 px-3 py-1.5 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1">로그아웃</button></div>
        <button type="button" onClick={props.onToggleForceCompact} aria-pressed={props.forceCompact} aria-label={props.forceCompact ? "축소 모드 끄기" : "축소 모드 켜기"} title={props.forceCompact ? "축소 모드 끄기" : "축소 모드 켜기"} data-role="compact-toggle" className={["hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition md:flex", props.forceCompact ? "border-ac/35 bg-ac/12 text-ac" : "border-transparent text-t2 hover:bg-s2 hover:text-t1"].join(" ")}><CompactToggleIcon active={props.forceCompact} /></button>
        <button type="button" onClick={props.onOpenSettingsDrawer} aria-label={props.rightDrawerOpen && props.rightTab === "settings" ? "설정 닫기" : "설정 열기"} aria-pressed={props.rightDrawerOpen && props.rightTab === "settings"} title={props.rightDrawerOpen && props.rightTab === "settings" ? "설정 닫기" : "설정 열기"} className={["flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition md:hidden", props.rightDrawerOpen && props.rightTab === "settings" ? "bg-s2 text-t1" : "text-t2 hover:bg-s2 hover:text-t1"].join(" ")}><GearIcon /></button>
      </header>
      <EmailVerifyBanner emailVerified={props.emailVerified} onResend={props.onResendVerifyEmail} />
      {props.statusPanelOpen ? (
        <div data-role="status-panel" className="flex shrink-0 items-center justify-end gap-1.5 border-b border-bd/10 bg-s1 px-3 py-2 md:hidden">
          <StatChip label="실행중" value={props.activeCount} color="ok" onClick={props.activeCount > 0 ? () => { props.onDismissAllDrawers(); props.onFocusExecution("active"); } : undefined} />
          <StatChip label="재요청중" value={props.retryingCount} color="warn" pulse={props.retryingCount > 0} onClick={props.retryingCount > 0 ? () => { props.onDismissAllDrawers(); props.onFocusExecution("retrying"); } : undefined} />
          <StatChip label="대기" value={props.queuedCount} color="warn" onClick={props.queuedCount > 0 ? () => { props.onDismissAllDrawers(); props.onFocusExecution("queued"); } : undefined} />
        </div>
      ) : null}
    </>
  );
}
