import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ModalCloseButton } from "./ModalCloseButton";
import { useEscapeClose } from "../lib/escapeStack";
import {
  deleteWorkspace,
  inviteMember,
  leaveWorkspace,
  listMembers,
  removeMember,
  renameWorkspace,
  switchToPersonalMode,
  transferOwner,
  type WorkspaceListItem,
  type WorkspaceMembersResponse,
} from "../lib/workspaces";

// WorkspaceSettingsPanel — settings sub-tab for the currently active
// workspace. Layout mirrors SecurityPanel (sectioned cards) so the
// look is consistent with the existing settings drawer.
//
// Sections:
//   1) 이름 — owner can rename, members see read-only label.
//   2) 멤버 — list members; owner can invite (modal returns one-time
//      link), remove, or transfer ownership.
//   3) 모드 — owner sees "협업 모드로 전환" or "개인 모드로 전환" based
//      on member count. Switch to personal opens a confirm dialog
//      with type-to-confirm matching the workspace name.
//   4) 삭제 — owner only; soft-deletes the workspace.
export function WorkspaceSettingsPanel(props: {
  active: WorkspaceListItem | null;
  selfUserID: string;
  onRefreshList: () => Promise<void>;
  onSwitchAway: (preferredID: string) => void;
}) {
  const [members, setMembers] = useState<WorkspaceMembersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [inviteIssued, setInviteIssued] = useState<{ token: string; email: string; expiresAt: number } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [personalConfirmOpen, setPersonalConfirmOpen] = useState(false);
  const [personalToast, setPersonalToast] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!props.active) {
      setMembers(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listMembers(props.active.id);
      setMembers(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "members_failed");
    } finally {
      setLoading(false);
    }
  }, [props.active]);

  useEffect(() => {
    void loadMembers();
    setRenameDraft(props.active?.name ?? "");
  }, [loadMembers, props.active?.id, props.active?.name]);

  if (!props.active) {
    return (
      <p className="px-2 py-4 text-[11px] text-t3">
        활성 워크스페이스가 없어요. 상단 스위처에서 하나를 선택하거나 새로 만들어주세요.
      </p>
    );
  }

  const isOwner = props.active.role === "owner";
  const memberCount = members?.members.length ?? props.active.memberCount;
  const isCollaborative = memberCount > 1;

  async function doRename() {
    if (!props.active) return;
    const name = renameDraft.trim();
    if (!name || name === props.active.name) return;
    try {
      await renameWorkspace(props.active.id, name);
      await props.onRefreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "rename_failed");
    }
  }

  async function doRemoveMember(userId: string) {
    if (!props.active) return;
    try {
      await removeMember(props.active.id, userId);
      await loadMembers();
      await props.onRefreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "remove_failed");
    }
  }

  async function doTransfer(userId: string) {
    if (!props.active) return;
    try {
      await transferOwner(props.active.id, userId);
      await loadMembers();
      await props.onRefreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "transfer_failed");
    }
  }

  async function doLeave() {
    if (!props.active) return;
    try {
      const leavingID = props.active.id;
      await leaveWorkspace(leavingID);
      // 떠난 워크스페이스에서 빠져 나오므로 다른 워크스페이스로 이동.
      props.onSwitchAway(leavingID);
      await props.onRefreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "leave_failed");
    }
  }

  async function doDelete() {
    if (!props.active) return;
    try {
      const deletingID = props.active.id;
      await deleteWorkspace(deletingID);
      props.onSwitchAway(deletingID);
      await props.onRefreshList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "delete_failed");
    }
  }

  return (
    <>
      <Section title="이름">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={renameDraft}
            disabled={!isOwner}
            onChange={(e) => setRenameDraft(e.target.value)}
            // 저장 버튼과 동일한 가드: 비어 있거나 현재 이름과 같으면 무시.
            // composition 중 Enter 는 한글/일본어 IME 의 변환 확정 키이므로
            // 가로채면 사용자가 입력하던 글자가 날아간다 — isComposing 체크
            // 로 건너뛴다. Esc 는 편집 취소 (원래 이름으로 되돌림).
            onKeyDown={(e) => {
              const active = props.active;
              if (!active) return;
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const draft = renameDraft.trim();
                if (!draft || draft === active.name) return;
                void doRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenameDraft(active.name);
              }
            }}
            className="min-w-0 flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-3 py-2 text-[12px] font-semibold text-t1 placeholder:text-t3/60 outline-none focus:border-ac/40 focus:bg-s1 disabled:opacity-60"
          />
          {isOwner ? (
            <button
              type="button"
              disabled={!renameDraft.trim() || renameDraft.trim() === props.active.name}
              onClick={() => void doRename()}
              className="rounded-xl border border-ac/40 bg-ac/15 px-3 py-2 text-[12px] font-bold text-ac transition hover:bg-ac/25 disabled:opacity-40"
            >저장</button>
          ) : null}
        </div>
      </Section>

      <Section title="멤버">
        {error ? <p className="mb-2 text-[11px] text-red-500">{error}</p> : null}
        {loading ? (
          <p className="text-[11px] text-t3">불러오는 중...</p>
        ) : (
          <>
            <ul className="space-y-1">
              {members?.members.map((m) => {
                const isSelf = m.userId === props.selfUserID;
                return (
                  <li key={m.userId} className="flex items-center gap-2 rounded-xl bg-s2 px-2 py-1.5 text-[11px]">
                    <span className="flex-1 truncate">
                      <span className="font-bold text-t1">{m.nickname || m.username}</span>
                      <span className="ml-1 text-t3">{m.email}</span>
                    </span>
                    {m.role === "owner" ? (
                      <span className="rounded bg-ac/20 px-1 text-[10px] font-bold text-ac">방장</span>
                    ) : null}
                    {isSelf ? (
                      <span className="rounded bg-bd/10 px-1 text-[10px] text-t2">나</span>
                    ) : null}
                    {isOwner && !isSelf ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void doTransfer(m.userId)}
                          title="이 멤버에게 방장 권한 양도"
                          className="rounded-md border border-bd/30 bg-s1 px-1.5 py-0.5 text-[10px] font-bold text-t2 hover:bg-bd/10"
                        >양도</button>
                        <button
                          type="button"
                          onClick={() => void doRemoveMember(m.userId)}
                          title="이 멤버 강퇴"
                          className="rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-bold text-red-500 hover:bg-red-500/20"
                        >강퇴</button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {isOwner && members?.invitations && members.invitations.length > 0 ? (
              <>
                <div className="mt-3 mb-1 text-[10px] font-black uppercase tracking-wider text-t3">대기 중 초대</div>
                <ul className="space-y-1">
                  {members.invitations.map((inv) => (
                    <li key={inv.id} className="flex items-center gap-2 rounded-xl bg-s2 px-2 py-1.5 text-[11px]">
                      <span className="flex-1 truncate text-t2">{inv.invitedEmail}</span>
                      <span className="text-[10px] text-t3">
                        만료 {new Date(inv.expiresAt * 1000).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="mt-3 flex gap-1.5">
              {isOwner ? (
                <button
                  type="button"
                  onClick={() => setInviteOpen(true)}
                  className="flex-1 rounded-xl border border-ac/40 bg-ac/15 px-2 py-1.5 text-[11px] font-bold text-ac hover:bg-ac/25"
                >멤버 초대</button>
              ) : null}
              {!isOwner ? (
                <button
                  type="button"
                  onClick={() => void doLeave()}
                  className="flex-1 rounded-xl border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] font-bold text-red-500 hover:bg-red-500/20"
                >워크스페이스 떠나기</button>
              ) : null}
            </div>
          </>
        )}
      </Section>

      {isOwner ? (
        <Section title="모드">
          <p className="mb-2 text-[11px] leading-relaxed text-t3">
            현재 <span className="font-bold text-t1">{isCollaborative ? "협업" : "개인"}</span> 워크스페이스 (멤버 {memberCount}명).
            {isCollaborative
              ? " 개인 모드로 전환하면 본인 외 모든 멤버가 강퇴돼요."
              : " 협업 모드로 전환하려면 멤버를 초대하세요."}
          </p>
          {isCollaborative ? (
            <button
              type="button"
              onClick={() => setPersonalConfirmOpen(true)}
              className="w-full rounded-xl border-2 border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] font-bold text-red-500 hover:bg-red-500/20"
            >개인 모드로 전환</button>
          ) : (
            <button
              type="button"
              onClick={() => setInviteOpen(true)}
              className="w-full rounded-xl border-2 border-ac/40 bg-ac/15 px-3 py-2 text-[12px] font-bold text-ac hover:bg-ac/25"
            >멤버 초대로 협업 시작</button>
          )}
        </Section>
      ) : null}

      {isOwner ? (
        <Section title="위험 영역">
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`"${props.active?.name}" 워크스페이스를 삭제할까요?\n삭제된 워크스페이스는 복구할 수 없어요.`)) {
                void doDelete();
              }
            }}
            className="w-full rounded-xl border-2 border-red-700/40 bg-red-900/10 px-3 py-2 text-[12px] font-bold text-red-500 hover:bg-red-900/20"
          >워크스페이스 삭제</button>
        </Section>
      ) : null}

      {inviteOpen && props.active ? (
        <InviteModal
          workspaceID={props.active.id}
          workspaceName={props.active.name}
          onClose={() => { setInviteOpen(false); void loadMembers(); }}
          onIssued={(r) => setInviteIssued(r)}
        />
      ) : null}
      {inviteIssued ? (
        <InvitationLinkModal
          email={inviteIssued.email}
          token={inviteIssued.token}
          expiresAt={inviteIssued.expiresAt}
          onClose={() => setInviteIssued(null)}
        />
      ) : null}
      {personalConfirmOpen && props.active ? (
        <PersonalModeConfirmModal
          workspaceID={props.active.id}
          workspaceName={props.active.name}
          memberCount={memberCount}
          members={members?.members ?? []}
          selfUserID={props.selfUserID}
          onCancel={() => setPersonalConfirmOpen(false)}
          onConfirmed={async () => {
            setPersonalConfirmOpen(false);
            setPersonalToast(true);
            await loadMembers();
            await props.onRefreshList();
            setTimeout(() => setPersonalToast(false), 3000);
          }}
        />
      ) : null}
      {personalToast ? (
        <ModeSwitchToast onClose={() => setPersonalToast(false)} />
      ) : null}
    </>
  );
}

// Section wrapper — matches the SecurityPanel layout so the workspace
// sub-tab visually belongs to the same family.
function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 rounded-2xl border border-bd/10 bg-s1 p-3" data-role="card">
      <div className="mb-2 text-[10px] font-black uppercase tracking-wider text-t3">{props.title}</div>
      {props.children}
    </div>
  );
}

// InviteModal — owner enters an email; the server returns a one-time
// invitation token + link. Acts as the gate before showing the link
// so the user picks who they're inviting before the link materializes.
function InviteModal(props: {
  workspaceID: string;
  workspaceName: string;
  onClose: () => void;
  onIssued: (r: { token: string; email: string; expiresAt: number }) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(true, props.onClose);

  async function submit() {
    const trimmed = email.trim();
    if (!trimmed) { setError("이메일을 입력해주세요."); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await inviteMember(props.workspaceID, trimmed);
      props.onIssued({ token: r.token, email: r.invitedEmail, expiresAt: r.expiresAt });
      props.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "invite_failed");
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div data-role="modal-window" className="relative w-full max-w-sm rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
          <h2 className="text-lg font-black tracking-tight">멤버 초대</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm text-t2">
            <span className="font-bold text-t1">{props.workspaceName}</span> 에 초대할 멤버의 이메일을 입력하세요.
            초대 링크는 한 번만 표시돼요.
          </p>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="invitee@example.com"
            autoFocus
            className="w-full rounded-xl border-2 border-bd/10 bg-s2 px-3 py-2 font-semibold text-t1 placeholder:text-t3/60 outline-none focus:border-ac/40 focus:bg-s1"
          />
          {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onClose}
              disabled={busy}
              className="rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2 text-sm font-bold text-t2"
            >취소</button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="rounded-xl bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2 text-sm font-black text-white disabled:opacity-60"
            >{busy ? "처리 중..." : "초대 링크 발급"}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// InvitationLinkModal — shows the raw token once. Mirrors the admin
// reset-password modal: copy-once UX with a clipboard fallback for
// non-secure contexts.
function InvitationLinkModal(props: {
  email: string;
  token: string;
  expiresAt: number;
  onClose: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEscapeClose(true, props.onClose);

  const url = `${window.location.origin}/invite?token=${encodeURIComponent(props.token)}`;
  const expiresAtLabel = new Date(props.expiresAt * 1000).toLocaleString();

  async function copy() {
    const el = inputRef.current;
    if (el) { el.focus(); el.select(); }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setCopyState("ok");
        setTimeout(() => setCopyState("idle"), 1500);
        return;
      }
    } catch { /* fall through */ }
    try {
      if (document.execCommand?.("copy")) {
        setCopyState("ok");
        setTimeout(() => setCopyState("idle"), 1500);
        return;
      }
    } catch { /* fall through */ }
    setCopyState("fail");
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div data-role="modal-window" className="relative w-full max-w-md rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
          <h2 className="text-lg font-black tracking-tight">초대 링크 발급됨</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-t1">
            <p className="font-bold">이 링크는 한 번만 표시돼요.</p>
            <p className="mt-1 text-t2">
              지금 복사해서 <span className="font-bold text-t1">{props.email}</span> 에게 안전한 채널로 전달해주세요.
              모달을 닫으면 다시 볼 수 없고, 새로 발급해야 해요.
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
              초대 링크 ({expiresAtLabel} 만료)
            </label>
            <div className="flex gap-2">
              <input
                ref={inputRef}
                type="text"
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-xl border-2 border-bd/10 bg-s2 px-3 py-2 font-mono text-[11px] text-t1 outline-none"
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded-xl border-2 border-bd/10 bg-gradient-to-br from-ac-lo to-ac-hi px-4 py-2 text-sm font-black text-white"
              >{copyState === "ok" ? "복사됨" : "복사"}</button>
            </div>
            {copyState === "fail" ? (
              <p className="mt-2 text-[11px] text-amber-500">
                자동 복사 실패. 위 입력칸이 선택돼 있으니 Ctrl/⌘-C 로 직접 복사해주세요.
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={props.onClose}
              className="rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2 text-sm font-bold text-t2"
            >닫기</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// PersonalModeConfirmModal — strong confirmation gate for "kick all
// members". Type-to-confirm: the user has to type the workspace name
// exactly. The server enforces the same check, so a skipped client
// dialog still fails.
function PersonalModeConfirmModal(props: {
  workspaceID: string;
  workspaceName: string;
  memberCount: number;
  members: { userId: string; email: string }[];
  selfUserID: string;
  onCancel: () => void;
  onConfirmed: () => Promise<void> | void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscapeClose(true, props.onCancel);

  const others = props.members.filter((m) => m.userId !== props.selfUserID);
  const canConfirm = typed.trim() === props.workspaceName && !busy;

  async function submit() {
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await switchToPersonalMode(props.workspaceID, typed.trim());
      await props.onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "switch_failed");
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div data-role="modal-window" className="relative w-full max-w-md rounded-2xl border-2 border-bd/10 bg-s1 text-t1 shadow-xl">
        <ModalCloseButton onClose={props.onCancel} />
        <div data-role="modal-titlebar" className="rounded-t-2xl border-b border-bd/10 px-6 py-4 pr-12">
          <h2 className="text-lg font-black tracking-tight">개인 모드로 전환</h2>
        </div>
        <div className="px-6 py-5 space-y-4">
          <p className="text-sm leading-relaxed text-t2">
            이 워크스페이스를 개인 모드로 전환하면 본인 외 다른 멤버 {others.length}명이 워크스페이스에서 제거돼요.
          </p>
          {others.length > 0 ? (
            <ul className="rounded-xl border border-bd/10 bg-s2 px-2 py-1 text-[11px] text-t2">
              {others.map((m) => (
                <li key={m.userId} className="py-0.5">• {m.email}</li>
              ))}
            </ul>
          ) : null}
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-t2">
            강퇴된 멤버는 더 이상 이 워크스페이스에 접근할 수 없고, 다시 초대하려면 한 명씩 새로 초대해야 해요.
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">
              확인을 위해 워크스페이스 이름을 정확히 입력하세요
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) void submit(); }}
              placeholder={props.workspaceName}
              autoFocus
              className="w-full rounded-xl border-2 border-bd/10 bg-s2 px-3 py-2 font-semibold text-t1 placeholder:text-t3/60 outline-none focus:border-ac/40 focus:bg-s1"
            />
            {error ? <p className="mt-2 text-[11px] text-red-500">{error}</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={props.onCancel}
              disabled={busy}
              className="rounded-xl border-2 border-bd/10 bg-s2 px-4 py-2 text-sm font-bold text-t2"
            >취소</button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canConfirm}
              className="rounded-xl border-2 border-bd/10 bg-red-600 px-4 py-2 text-sm font-black text-white disabled:opacity-40"
            >{busy ? "처리 중..." : "개인 모드로 전환"}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ModeSwitchToast — emphasizes the result of the personal-mode switch
// without dwelling on "N명을 강퇴했어요" (per the requested wording).
function ModeSwitchToast(props: { onClose: () => void }) {
  return createPortal(
    <div className="fixed bottom-6 right-6 z-50 max-w-sm rounded-2xl border-2 border-ac/40 bg-ac/20 px-4 py-3 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ac text-white">✓</div>
        <div className="flex-1">
          <p className="text-sm font-black text-t1">개인 워크스페이스로 전환됐어요</p>
          <p className="mt-0.5 text-[11px] text-t2">
            이제 본인만 이 워크스페이스에 접근할 수 있어요.
          </p>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          className="text-t3 hover:text-t1"
        >✕</button>
      </div>
    </div>,
    document.body,
  );
}
