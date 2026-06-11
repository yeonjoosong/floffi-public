import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";
import { BookmarkIcon } from "./BookmarkIcon";

/* ═══════════════════════════════════════════════════
   RunbookBookModal — runbook 본문을 "가운데를 펼친 책" 형태로 보여주는 모달.

   - 양면 스프레드: 한 화면에 왼쪽/오른쪽 두 페이지가 책등(spine)을
     사이에 두고 펼쳐진다. 페이지 넘김은 스프레드(2쪽) 단위.
   - 페이지네이션은 번호가 아니라 책장을 넘기는 메타포: 좌우 가장자리의
     ‹ › 버튼(+ 키보드 ←/→)으로 넘긴다.
   - runbook의 "[섹션]" 헤더가 자연스러운 장(章) 경계라서 페이지 분할
     기준으로 쓰고, 같은 헤더가 오른쪽 가장자리의 책갈피 탭이 된다 —
     원하는 섹션으로 바로 점프.
   - 마지막 페이지에는 "처음부터 다시 읽기" 버튼이 붙는다.
   - 닫기: X 버튼 없음. 책 위에 드리운 책갈피 리본을 당기면(클릭)
     양 페이지가 책등 쪽으로 접히며 닫힌다. ESC/배경 클릭도 동일 동작.
═══════════════════════════════════════════════════ */

type BookPage = {
  /** 이 페이지가 속한 섹션 라벨 (책갈피 라벨과 동일). */
  section: string;
  lines: string[];
  /** 같은 섹션이 여러 페이지로 쪼개질 때 2페이지째부터 true — 헤더 반복 방지. */
  continued: boolean;
};

type Bookmark = { label: string; page: number };

/** 한 페이지에 담을 본문 줄 수. 책 페이지 높이(고정)와 행간에 맞춘 값. */
const LINES_PER_PAGE = 14;

/** 닫기 애니메이션(리본 당김 + 페이지 접힘) 길이 — styles.css와 동기. */
const CLOSE_ANIM_MS = 300;

/** 섹션 헤더 "[수집 — 설명]" → 책갈피 라벨 "수집" (대시/콜론 앞까지). */
function bookmarkLabel(header: string): string {
  const inner = header.replace(/^\[/, "").replace(/\]$/, "");
  const cut = inner.split(/[—:-]/)[0].trim();
  return (cut || inner).slice(0, 10);
}

/** runbook 본문 → 섹션 경계 우선으로 페이지 분할 + 책갈피 목록. */
export function paginateRunbook(note: string): { pages: BookPage[]; bookmarks: Bookmark[] } {
  type Section = { label: string; lines: string[] };
  const sections: Section[] = [];
  let current: Section = { label: "개요", lines: [] };
  for (const raw of note.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^\[.+\]\s*$/.test(line.trim())) {
      if (current.lines.some((l) => l.trim() !== "")) sections.push(current);
      current = { label: bookmarkLabel(line.trim()), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.some((l) => l.trim() !== "")) sections.push(current);

  const pages: BookPage[] = [];
  const bookmarks: Bookmark[] = [];
  for (const sec of sections) {
    // 섹션 앞뒤의 빈 줄은 페이지 낭비라 정리
    const lines = [...sec.lines];
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    if (lines.length === 0) continue;

    bookmarks.push({ label: sec.label, page: pages.length });
    for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
      pages.push({
        section: sec.label,
        lines: lines.slice(i, i + LINES_PER_PAGE),
        continued: i > 0,
      });
    }
  }
  if (pages.length === 0) {
    pages.push({ section: "개요", lines: ["(내용 없음)"], continued: false });
    bookmarks.push({ label: "개요", page: 0 });
  }
  return { pages, bookmarks };
}

/** 펼친 책 — bold stroke, currentColor 상속 (BookmarkIcon 패턴). */
export function BookIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      {/* 좌/우 페이지 + 가운데 책등 */}
      <path d="M 12 6 C 10 4.5 7 4 3.5 4.5 V 19 C 7 18.5 10 19 12 20.5" />
      <path d="M 12 6 C 14 4.5 17 4 20.5 4.5 V 19 C 17 18.5 14 19 12 20.5" />
      <path d="M 12 6 V 20.5" />
    </svg>
  );
}

/** 처음으로 돌아가기 — 반시계 원형 화살표, bold stroke. */
function RestartIcon({ size = 13, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"
      className={className} aria-hidden="true">
      <path d="M 4.5 12 a 7.5 7.5 0 1 0 2.2 -5.3" />
      <path d="M 6.5 2.5 L 6.5 7 L 11 7" />
    </svg>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === "left" ? <path d="M 15 5 L 8 12 L 15 19" /> : <path d="M 9 5 L 16 12 L 9 19" />}
    </svg>
  );
}

/** 펼친 책의 한 면. side에 따라 책등 쪽 음영과 모서리 둥글기가 달라진다. */
function BookPagePane(props: {
  page: BookPage | undefined;
  side: "left" | "right";
  pageNo: number | null;
  /** 마지막 스프레드의 오른면 — 콜로폰(끝 + 다시 읽기)을 받는다. */
  tail?: { onRestart: () => void } | null;
  closing: boolean;
}) {
  const { page, side } = props;
  const isLeft = side === "left";
  return (
    <div
      className={[
        // 모서리 라운딩 없음 — 위/아래는 표제띠와 폴리오가 캡을 씌우고,
        // 좌우 직선 구간은 컨테이너 보더가 형태를 정의한다.
        "relative min-h-[400px] flex-1 px-7 py-6 sm:px-9",
        props.closing ? (isLeft ? "runbook-fold-left" : "runbook-fold-right") : "",
      ].join(" ")}
      style={{
        background: isLeft
          ? // 책등(안쪽)으로 갈수록 살짝 어두워지는 종이 — 펼친 책의 골
            "linear-gradient(to right, color-mix(in srgb, rgb(var(--base)) 95%, rgb(var(--ac)) 5%) 82%, color-mix(in srgb, rgb(var(--base)) 86%, black 14%) 100%)"
          : "linear-gradient(to left, color-mix(in srgb, rgb(var(--base)) 95%, rgb(var(--ac)) 5%) 82%, color-mix(in srgb, rgb(var(--base)) 86%, black 14%) 100%)",
      }}
    >
      {page ? (
        <>
          <p className="mb-3 border-b border-bd/15 pb-1.5 text-[11px] font-black uppercase tracking-wider text-ac/80">
            {page.section}
            {page.continued ? <span className="ml-1 font-bold text-t3">(이어서)</span> : null}
          </p>
          <div className="whitespace-pre-wrap break-words text-[13px] leading-6 text-t1">
            {page.lines.join("\n")}
          </div>
        </>
      ) : (
        // 본문이 홀수 쪽일 때 마지막 스프레드의 빈 오른면 — 백지 그대로 두면
        // 깨져 보여서 콜로폰 자리로 쓴다.
        <div className="flex h-full min-h-[340px] items-center justify-center" />
      )}

      {props.tail ? (
        <div className={["flex justify-center", page ? "mt-6" : "absolute inset-x-0 top-1/2 -translate-y-1/2"].join(" ")}>
          <button
            type="button"
            onClick={props.tail.onRestart}
            className="inline-flex items-center gap-1.5 rounded-full border border-ac/30 bg-ac/10 px-4 py-2 text-xs font-black text-ac transition hover:bg-ac/20"
          >
            <RestartIcon className="shrink-0" />
            <span>처음부터 다시 읽기</span>
          </button>
        </div>
      ) : null}

      {/* 쪽번호 — 바깥쪽 아래 모서리 (책의 관례) */}
      {props.pageNo !== null ? (
        <span className={["absolute bottom-2.5 text-[10.5px] font-bold tracking-widest text-t3", isLeft ? "left-5" : "right-5"].join(" ")}>
          {props.pageNo}
        </span>
      ) : null}
    </div>
  );
}

export function RunbookBookModal(props: { title: string; note: string; onClose: () => void }) {
  const { pages, bookmarks } = useMemo(() => paginateRunbook(props.note), [props.note]);
  // 스프레드(펼친 양면) 단위 페이지네이션: spread s → 왼면 2s, 오른면 2s+1
  const [spread, setSpread] = useState(0);
  const [turnDir, setTurnDir] = useState<"next" | "prev">("next");
  const [closing, setClosing] = useState(false);

  const lastSpread = Math.ceil(pages.length / 2) - 1;
  const leftPage = pages[spread * 2];
  const rightPage = pages[spread * 2 + 1];
  const isLast = spread === lastSpread;

  const go = (target: number, dir: "next" | "prev") => {
    setTurnDir(dir);
    setSpread(Math.max(0, Math.min(lastSpread, target)));
  };

  // 책갈피 리본 당김 → 페이지가 책등으로 접히는 애니메이션 후 실제 닫기
  const requestClose = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(props.onClose, CLOSE_ANIM_MS);
  };
  useEscapeClose(true, requestClose);

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
      aria-label={`Runbook: ${props.title}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" && spread < lastSpread) go(spread + 1, "next");
        if (e.key === "ArrowLeft" && spread > 0) go(spread - 1, "prev");
      }}
    >
      <div onClick={requestClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-hidden />

      {/* 책 본체 — 키보드 페이지 넘김을 받기 위해 자동 포커스 */}
      <div
        data-role="modal-window"
        ref={(el) => el?.focus()}
        tabIndex={-1}
        className={[
          "absolute left-1/2 top-1/2 w-[min(96vw,920px)] -translate-x-1/2 -translate-y-1/2 outline-none",
          closing ? "runbook-book-closing" : "",
        ].join(" ")}
      >
        {/* overflow-hidden — 책갈피 탭/리본을 포함한 모든 레이어가 책의
            둥근 모서리 안쪽에 머물도록 클리핑. 탭이 모달 밖으로 비져나가
            어긋나 보이던 문제의 핵심 수정. */}
        <div className="relative overflow-hidden rounded-2xl border-2 border-bd/25 shadow-2xl"
          style={{ background: "color-mix(in srgb, rgb(var(--base)) 88%, rgb(var(--ac)) 12%)" }}>

          {/* 표제부 — 책 표지의 제목띠 느낌 */}
          <div className="flex items-center gap-2 border-b border-bd/15 bg-gradient-to-r from-ac-lo/15 to-ac-hi/10 px-5 py-3 pr-24">
            <BookIcon size={18} className="shrink-0 text-ac" />
            <h3 className="min-w-0 truncate text-base font-black text-t1">{props.title}</h3>
          </div>

          {/* 닫기 책갈피 리본 — 표제띠 위에서 페이지 위로 드리워져 있고,
              당기면(클릭) 책이 접히며 닫힌다. hover 시 살짝 딸려 내려와
              "당길 수 있음"을 암시. */}
          <button
            type="button"
            onClick={requestClose}
            aria-label="책갈피를 당겨 닫기"
            title="책갈피를 당겨 닫기"
            className={[
              "group absolute right-10 top-0 z-30 flex w-9 flex-col items-center pb-3 pt-2",
              "bg-gradient-to-b from-ac-lo to-ac-hi text-white shadow-lg outline-none",
              // closing 중에는 hover 유틸리티를 빼서 runbook-ribbon-pulled 의
              // transform 과 경합하지 않게 한다 (버벅임 원인이던 충돌 제거).
              closing
                ? "runbook-ribbon-pulled"
                : "transition-transform duration-200 hover:translate-y-2 focus-visible:translate-y-2",
            ].join(" ")}
            style={{ height: "104px", clipPath: "polygon(0 0, 100% 0, 100% 100%, 50% calc(100% - 12px), 0 100%)" }}
          >
            {/* 리본 위 세로 "닫기" 라벨 */}
            <span className="mt-1 flex flex-col items-center gap-0.5 text-[10px] font-black leading-none tracking-widest">
              <span>닫</span>
              <span>기</span>
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
              className="mt-1.5 transition-transform group-hover:translate-y-0.5" aria-hidden="true">
              <path d="M 12 4 V 17" /><path d="M 6 12 L 12 18 L 18 12" />
            </svg>
          </button>

          <div className="relative flex">
            {/* 펼친 양면 — key 가 바뀔 때마다 넘김 애니메이션 재실행.
                runbook-spread 가 공유 perspective 를 제공해 닫힘 접힘이
                양 페이지에서 같은 3D 공간으로 움직인다. */}
            <div
              key={spread}
              className={[
                "runbook-spread flex min-w-0 flex-1",
                closing ? "" : turnDir === "next" ? "runbook-page-turn-next" : "runbook-page-turn-prev",
              ].join(" ")}
            >
              <BookPagePane
                page={leftPage}
                side="left"
                pageNo={leftPage ? spread * 2 + 1 : null}
                tail={null}
                closing={closing}
              />

              {/* 책등(spine) — 가운데 골. 양쪽 페이지 그라데이션과 만나
                  접힌 골짜기처럼 보인다. */}
              <div className="relative w-[3px] shrink-0 self-stretch" aria-hidden>
                <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/40 to-black/25" />
              </div>

              <BookPagePane
                page={rightPage}
                side="right"
                pageNo={rightPage ? spread * 2 + 2 : null}
                tail={isLast ? { onRestart: () => go(0, "prev") } : null}
                closing={closing}
              />
            </div>

            {/* ‹ › — 책 좌우 가장자리의 페이지 넘김 버튼. closing 중에는
                고정 레이어가 접히는 페이지 위에 남아 어긋나 보이므로 즉시
                숨긴다 (탭/화살표 동일). */}
            {!closing && spread > 0 ? (
              <button
                type="button"
                onClick={() => go(spread - 1, "prev")}
                aria-label="이전 페이지"
                title="이전 페이지 (←)"
                className="absolute left-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full border border-bd/20 bg-s1/90 p-2 text-t2 shadow-md transition hover:scale-110 hover:text-ac"
              >
                <Chevron dir="left" />
              </button>
            ) : null}
            {!closing && spread < lastSpread ? (
              <button
                type="button"
                onClick={() => go(spread + 1, "next")}
                aria-label="다음 페이지"
                title="다음 페이지 (→)"
                className="absolute right-1.5 top-1/2 z-10 -translate-y-1/2 rounded-full border border-bd/20 bg-s1/90 p-2 text-t2 shadow-md transition hover:scale-110 hover:text-ac"
              >
                <Chevron dir="right" />
              </button>
            ) : null}

            {/* 섹션 책갈피 탭 — 책 오른쪽 가장자리 "안쪽"에 정렬해 항상
                모달 경계와 라인이 맞는다 (바깥 돌출 오프셋이 선택 전 위치를
                어긋나 보이게 하던 문제 수정). 닫기 리본(높이 104px) 아래에서
                시작해 겹치지 않는다. */}
            {!closing ? (
              <div className="absolute right-0 top-[72px] z-20 flex flex-col items-end gap-1.5" aria-label="책갈피">
                {bookmarks.slice(0, 9).map((bm) => {
                  const active = leftPage?.section === bm.label || rightPage?.section === bm.label;
                  const targetSpread = Math.floor(bm.page / 2);
                  return (
                    <button
                      key={`${bm.label}-${bm.page}`}
                      type="button"
                      onClick={() => go(targetSpread, targetSpread >= spread ? "next" : "prev")}
                      title={`${bm.label} — ${bm.page + 1}쪽으로 이동`}
                      className={[
                        "flex max-w-[120px] items-center gap-1 rounded-l-lg border border-r-0 py-1 pl-2 pr-2 text-[10px] font-black shadow-sm transition",
                        active
                          ? "border-ac/40 bg-ac/90 text-white"
                          : "border-bd/20 bg-s2/95 text-t2 hover:-translate-x-0.5 hover:text-ac",
                      ].join(" ")}
                    >
                      <BookmarkIcon active={active} size={11} className="shrink-0" />
                      <span className="truncate">{bm.label}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          {/* 하단 폴리오 — 펼친 면 기준 쪽 표시 */}
          <div className="rounded-b-2xl border-t border-bd/15 px-5 py-2 text-center text-[11px] font-bold tracking-widest text-t3">
            — {spread * 2 + 1}{rightPage ? `·${spread * 2 + 2}` : ""} / {pages.length} —
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
