import { useEffect, useState } from "react";
import {
  fetchMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  MEMORY_MAX_CONTENT_LENGTH,
  type UserMemory,
} from "../lib/memories";

// MemoryPanel — Stage 1 of plan/rag-and-memory-roadmap.md.
//
// 사용자별 영구 메모리 관리 UI. 설정 → "메모리" 서브탭에 마운트된다.
// 메모리는 서버의 agent.go 프롬프트 조립 시 자동 inject 되며, 이 패널은
// CRUD 만 담당한다. workspaceId 컬럼은 단계 1 에서는 노출하지 않는다
// (모든 신규 메모리는 "전역"으로 저장 — 단계 2+에서 워크스페이스 스코프
// 분기를 UI 로 노출 검토).
//
// 디자인 트래이드오프:
//   • 인라인 편집 (별도 모달 X) — 메모리 1줄 ~ 2KB 짧은 자연어
//   • 삭제는 즉시 (확인 다이얼로그 X) — 잘못 지워도 다시 적으면 그만
//     이고, 확인창 매번 띄우면 정리 작업이 번거롭다
//   • 정렬은 서버가 updatedAt DESC 로 보내준 그대로

export function MemoryPanel() {
  const [items, setItems] = useState<UserMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);

  // Per-row editing state. Only one row can be in edit mode at a time —
  // editingId is the row's primary key; editingContent is the buffered text.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingContent, setEditingContent] = useState("");

  useEffect(() => {
    let alive = true;
    fetchMemories()
      .then((rows) => {
        if (!alive) return;
        setItems(rows);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e?.message ?? e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function handleCreate() {
    const content = draft.trim();
    if (!content) return;
    if (content.length > MEMORY_MAX_CONTENT_LENGTH) {
      setError(`메모리는 ${MEMORY_MAX_CONTENT_LENGTH}자 이내로 입력해주세요.`);
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const m = await createMemory(content);
      setItems((prev) => [m, ...prev]);
      setDraft("");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(m: UserMemory) {
    setEditingId(m.id);
    setEditingContent(m.content);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingContent("");
  }

  async function saveEdit() {
    if (editingId == null) return;
    const content = editingContent.trim();
    if (!content) return;
    if (content.length > MEMORY_MAX_CONTENT_LENGTH) {
      setError(`메모리는 ${MEMORY_MAX_CONTENT_LENGTH}자 이내로 입력해주세요.`);
      return;
    }
    try {
      const m = await updateMemory(editingId, content);
      setItems((prev) => prev.map((it) => (it.id === m.id ? m : it)));
      cancelEdit();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteMemory(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      if (editingId === id) cancelEdit();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2.5 text-[11px] font-black uppercase tracking-wider text-t3">
          내 메모리
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-t3">
          AI 에이전트가 매 요청마다 자동으로 참고하는 영구 지시 사항입니다.
          시스템 안전 규칙은 못 끄지만, 그 외의 일반 응답 방향은 메모리가
          현재 요청보다 우선합니다. (예: "응답은 항상 한국어로", "회사 톤은
          존댓말 유지", "Python 보다 Go 를 선호")
        </p>
      </div>

      {/* 새 메모리 추가 */}
      <div className="rounded-xl border border-bd/10 bg-s2 p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="기억해두고 싶은 지시 사항을 입력하세요."
          className="block w-full resize-y rounded-lg border border-bd/15 bg-s1 px-2.5 py-2 text-[12px] text-t1 placeholder:text-t3/60 focus:border-ac/40 focus:outline-none"
          rows={2}
          maxLength={MEMORY_MAX_CONTENT_LENGTH}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[10px] text-t3">
            {draft.length} / {MEMORY_MAX_CONTENT_LENGTH}
          </span>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || draft.trim() === ""}
            className="rounded-lg bg-ac px-3 py-1.5 text-[11px] font-bold text-bg disabled:opacity-40"
          >
            {creating ? "추가 중…" : "메모리 추가"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-err/25 bg-err/8 px-3 py-2 text-[11px] text-err">
          {error}
        </div>
      ) : null}

      {/* 목록 */}
      {loading ? (
        <p className="text-[11px] text-t3">메모리를 불러오는 중…</p>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-bd/10 bg-s2 px-3 py-3 text-[11px] text-t3">
          저장된 메모리가 없습니다. 위 입력창에서 첫 메모리를 추가하세요.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => {
            const isEditing = editingId === m.id;
            return (
              <li key={m.id} className="rounded-xl border border-bd/10 bg-s2 p-3">
                {isEditing ? (
                  <>
                    <textarea
                      value={editingContent}
                      onChange={(e) => setEditingContent(e.target.value)}
                      className="block w-full resize-y rounded-lg border border-bd/15 bg-s1 px-2.5 py-2 text-[12px] text-t1 focus:border-ac/40 focus:outline-none"
                      rows={2}
                      maxLength={MEMORY_MAX_CONTENT_LENGTH}
                    />
                    <div className="mt-2 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-lg border border-bd/15 px-2.5 py-1 text-[11px] font-bold text-t2 hover:text-t1"
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        onClick={saveEdit}
                        className="rounded-lg bg-ac px-2.5 py-1 text-[11px] font-bold text-bg"
                      >
                        저장
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap text-[12px] text-t1">{m.content}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[10px] text-t3">
                        {m.workspaceId ? "이 워크스페이스 한정" : "전역 적용"}
                        {" · "}
                        업데이트 {formatRelative(m.updatedAt)}
                      </span>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(m)}
                          className="rounded-lg border border-bd/15 px-2 py-0.5 text-[10px] font-bold text-t2 hover:text-t1"
                        >
                          편집
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(m.id)}
                          className="rounded-lg border border-err/25 bg-err/8 px-2 py-0.5 text-[10px] font-bold text-err hover:bg-err/15"
                        >
                          삭제
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// formatRelative — "방금", "3분 전", "2시간 전", "어제", "3일 전", "2026-04-01"
// 단계 1 에서는 단순 자체 구현. SecurityPanel 의 formatRelative 와는 별도.
function formatRelative(unixSec: number): string {
  if (!unixSec) return "";
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSec;
  if (diff < 60) return "방금";
  if (diff < 60 * 60) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 60 * 60 * 24) return `${Math.floor(diff / (60 * 60))}시간 전`;
  if (diff < 60 * 60 * 24 * 2) return "어제";
  if (diff < 60 * 60 * 24 * 30) return `${Math.floor(diff / (60 * 60 * 24))}일 전`;
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
