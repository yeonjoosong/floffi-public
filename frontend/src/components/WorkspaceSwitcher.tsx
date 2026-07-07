import { useEffect, useRef, useState } from "react";

import type { WorkspaceListItem } from "../lib/workspaces";

// WorkspaceSwitcher — topbar dropdown that lists every workspace the
// signed-in user is a member of and lets them switch the active one or
// create a new one (until they hit the cap).
//
// Why this lives next to the board title:
//   - The title belongs to the *current* workspace. Putting the picker
//     beside it keeps the "where am I" question answered in one glance.
//   - Slack / Notion put the switcher on the side; we keep it inline
//     because floffi has a single column of context — the topbar — and
//     pushing it to the rail would compete with the existing icon
//     stack for limited mobile width.
//
// The trigger shows the active workspace position as "current / total" so
// switching workspaces updates the label immediately. The cap still matters
// for creation, but it is secondary to answering "which workspace am I in".
export function WorkspaceSwitcher(props: {
  workspaces: WorkspaceListItem[];
  activeID: string;
  cap: number;
  onSwitch: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCreating(false);
        setNewName("");
        setError(null);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const activeIndex = props.workspaces.findIndex((w) => w.id === props.activeID);
  const currentPosition = activeIndex >= 0 ? activeIndex + 1 : 0;
  const totalWorkspaces = props.workspaces.length;
  const atCap = totalWorkspaces >= props.cap;

  async function submitCreate() {
    const name = newName.trim();
    if (!name) {
      setError("이름을 입력해주세요.");
      return;
    }
    setError(null);
    try {
      await props.onCreate(name);
      setNewName("");
      setCreating(false);
      setOpen(false);
    } catch (e) {
      const code = (e as Error & { code?: string }).code ?? "";
      if (code === "workspace_cap_reached") {
        setError(`워크스페이스 한도(${props.cap}개)에 도달했어요.`);
      } else {
        setError(e instanceof Error ? e.message : "생성 실패");
      }
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`워크스페이스 전환 (${totalWorkspaces}/${props.cap}개 사용 중)`}
        className="flex items-center gap-1.5 rounded-xl px-2 py-1 text-[11px] font-bold text-t2 transition hover:bg-s2 hover:text-t1"
      >
        <span className="rounded-md border border-bd/20 bg-s2 px-1.5 py-0.5 text-[10px] font-black">
          {currentPosition}/{Math.max(totalWorkspaces, 1)}
        </span>
        <span className="hidden xl:inline">전환</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-full z-40 mt-1 w-72 rounded-2xl border-2 border-bd/10 bg-s1 p-2 shadow-2xl"
          data-role="card"
        >
          <div className="mb-1 flex items-center justify-between px-2 py-1 text-[10px] font-black uppercase tracking-wider text-t3">
            <span>워크스페이스</span>
            <span className="normal-case tracking-normal text-[10px] text-t3">{totalWorkspaces}/{props.cap}개 사용 중</span>
          </div>
          <ul className="max-h-64 overflow-y-auto space-y-0.5">
            {props.workspaces.length === 0 ? (
              <li className="px-2 py-1.5 text-[11px] text-t3">소속된 워크스페이스가 없어요.</li>
            ) : (
              props.workspaces.map((w) => {
                const isActive = w.id === props.activeID;
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!isActive) props.onSwitch(w.id);
                        setOpen(false);
                      }}
                      className={[
                        "flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-[12px] transition",
                        isActive ? "bg-ac/15 text-t1" : "text-t2 hover:bg-s2 hover:text-t1",
                      ].join(" ")}
                    >
                      <span className="flex-1 truncate font-bold">{w.name}</span>
                      <span className="rounded bg-bd/10 px-1 text-[9px] font-bold text-t3">
                        {w.memberCount > 1 ? `${w.memberCount}명 협업` : "개인"}
                      </span>
                      {w.role === "owner" ? (
                        <span className="rounded bg-ac/20 px-1 text-[9px] font-bold text-ac">방장</span>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <div className="mt-2 border-t border-bd/10 pt-2">
            {creating ? (
              <div className="flex flex-col gap-1.5 px-1">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitCreate();
                    if (e.key === "Escape") { setCreating(false); setNewName(""); setError(null); }
                  }}
                  placeholder="새 워크스페이스 이름"
                  autoFocus
                  className="rounded-xl border-2 border-bd/10 bg-s2 px-2 py-1.5 text-[12px] font-semibold text-t1 placeholder:text-t3/60 outline-none focus:border-ac/40 focus:bg-s1"
                />
                {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => { setCreating(false); setNewName(""); setError(null); }}
                    className="flex-1 rounded-xl border border-bd/10 px-2 py-1 text-[11px] font-bold text-t2"
                  >취소</button>
                  <button
                    type="button"
                    onClick={() => void submitCreate()}
                    className="flex-1 rounded-xl bg-gradient-to-br from-ac-lo to-ac-hi px-2 py-1 text-[11px] font-black text-white"
                  >만들기</button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={atCap}
                onClick={() => { setCreating(true); setError(null); }}
                title={atCap ? `워크스페이스 한도(${props.cap}개)에 도달했어요` : ""}
                className="flex w-full items-center justify-center gap-1 rounded-xl border border-dashed border-bd/30 px-2 py-1.5 text-[11px] font-bold text-t2 transition hover:bg-s2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
              >
                + 새 워크스페이스
              </button>
            )}
            <button
              type="button"
              onClick={() => void props.onReload()}
              className="mt-1 w-full rounded-xl px-2 py-1 text-[10px] text-t3 transition hover:text-t1"
            >
              목록 새로고침
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
