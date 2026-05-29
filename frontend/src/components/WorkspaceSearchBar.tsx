import { useEffect, useRef, useState } from "react";
import { searchWorkspace, type SearchHit } from "../lib/search";

// SAFE_TAG_OPEN / CLOSE — 임시 sentinel. snippet 에서 우리가 박은 <b>/</b> 만
// 살리고 나머지는 escape 하기 위해 먼저 sentinel 로 치환 → 전체 escape →
// sentinel 을 다시 태그로 복원한다. snippet body 안에 같은 sentinel 문자열이
// 들어 있으면 자기 자신도 escape 되므로 충돌 없음.
const SAFE_TAG_OPEN = "CLAW_B_OPEN";
const SAFE_TAG_CLOSE = "CLAW_B_CLOSE";

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightSnippet(snippet: string): string {
  const seeded = snippet.replace(/<b>/g, SAFE_TAG_OPEN).replace(/<\/b>/g, SAFE_TAG_CLOSE);
  return escapeHTML(seeded)
    .replace(new RegExp(SAFE_TAG_OPEN, "g"), '<b class="text-ac">')
    .replace(new RegExp(SAFE_TAG_CLOSE, "g"), "</b>");
}

// WorkspaceSearchBar — Stage 1-A 상단 검색.
//
// 우측 패널의 받은함 상단에 살짝 끼우는 형태로 마운트한다. UX 목표:
//   • 1줄 입력 → 200 ms 디바운스 → top-10 결과를 그 자리에 드롭다운
//   • 결과 클릭은 source_type 에 따라 다른 동작:
//       task   → 부모가 보드에서 해당 카드를 선택
//       report → 부모가 받은함 카드를 펼침
//       vault  → 단계 1 에선 알림만 (vault 패널이 별도 모달이라 별 처리)
//   • 빈 쿼리면 드롭다운 자체를 닫음

export type SearchBarProps = {
  onPickTask?: (taskId: string) => void;
  onPickReport?: (reportId: string) => void;
};

export function WorkspaceSearchBar(props: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const q = query.trim();
    if (!q) {
      setHits([]);
      setOpen(false);
      setError(null);
      return;
    }
    setLoading(true);
    timer.current = window.setTimeout(async () => {
      try {
        const rows = await searchWorkspace(q, 10);
        setHits(rows);
        setOpen(true);
        setError(null);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setHits([]);
        setOpen(true);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [query]);

  function pick(h: SearchHit) {
    if (h.sourceType === "task") props.onPickTask?.(h.sourceId);
    if (h.sourceType === "report") props.onPickReport?.(h.sourceId);
    setOpen(false);
    setQuery("");
  }

  return (
    <div className="relative">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (query.trim()) setOpen(true); }}
        onKeyDown={(e) => { if (e.key === "Escape") { setOpen(false); setQuery(""); } }}
        placeholder="이 워크스페이스에서 검색 (태스크 · 리포트 · 문서)"
        className="block w-full rounded-xl border border-bd/15 bg-s1 px-3 py-2 text-[12px] text-t1 placeholder:text-t3/60 focus:border-ac/40 focus:outline-none"
      />
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl border border-bd/15 bg-s1 shadow-lg">
          {loading ? (
            <p className="px-3 py-2 text-[11px] text-t3">검색 중…</p>
          ) : error ? (
            <p className="px-3 py-2 text-[11px] text-err">검색 실패: {error}</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-[11px] text-t3">결과 없음.</p>
          ) : (
            <ul className="divide-y divide-bd/10">
              {hits.map((h) => (
                <li key={`${h.sourceType}-${h.sourceId}`}>
                  <button
                    type="button"
                    onClick={() => pick(h)}
                    className="block w-full px-3 py-2 text-left transition hover:bg-s2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[12px] font-bold text-t1">{h.title || "(제목 없음)"}</span>
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-t3">
                        {h.sourceType === "report" ? "리포트" : h.sourceType === "task" ? "태스크" : "문서"}
                      </span>
                    </div>
                    {h.snippet ? (
                      <p
                        className="mt-1 line-clamp-2 text-[11px] leading-snug text-t3"
                        // SQLite snippet() 은 body 안의 < > & 를 그대로 돌려주고
                        // 그 위에 <b>…</b> 만 덧붙인다. 사용자가 입력한 < script
                        // 같은 페이로드가 그대로 박힐 수 있으므로 일반 HTML 은
                        // 모두 escape 한 뒤, snippet 자체가 만든 <b>/</b> 만
                        // 다시 살린다.
                        dangerouslySetInnerHTML={{ __html: highlightSnippet(h.snippet) }}
                      />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
