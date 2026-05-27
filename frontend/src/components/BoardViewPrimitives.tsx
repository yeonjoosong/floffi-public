import { useRef, type ReactNode } from "react";

export function SideSection(props: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-2.5 text-[11px] font-black uppercase tracking-wider text-t3">{props.title}</p>
      {props.children}
    </div>
  );
}

export function Card(props: { children: ReactNode; highlight?: boolean }) {
  return (
    <div
      data-role={props.highlight ? "card-highlight" : "card"}
      className={[
        "rounded-xl border p-3",
        props.highlight ? "border-ac/35 bg-ac/8" : "border-bd/10 bg-s2",
      ].join(" ")}
    >
      {props.children}
    </div>
  );
}

export function Toggle(props: { on: boolean; onClick: () => void; disabled?: boolean }) {
  const isDisabled = props.disabled === true;
  return (
    <button
      type="button"
      role="switch"
      data-role="toggle"
      data-on={props.on ? "true" : "false"}
      aria-checked={props.on}
      disabled={isDisabled}
      onClick={isDisabled ? undefined : props.onClick}
      className={[
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 transition-colors",
        isDisabled ? "cursor-not-allowed border-t3/30 bg-t3/15 opacity-50" : "cursor-pointer",
        !isDisabled && (props.on ? "border-ac bg-ac" : "border-t3/40 bg-t3/25"),
      ].filter(Boolean).join(" ")}
    >
      <span data-role="toggle-knob" className={[
        "inline-block h-4 w-4 transform rounded-full transition-transform",
        props.on ? "translate-x-[22px] bg-white" : "translate-x-0.5 bg-t3",
      ].join(" ")} />
    </button>
  );
}

export function FInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; compact?: boolean; onSubmit?: () => void; onCancel?: () => void }) {
  return (
    <input
      className={[
        "w-full rounded-xl border border-bd/10 bg-s2 text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15",
        props.compact ? "px-3 py-2 text-xs" : "px-3 py-2.5 text-sm",
      ].join(" ")}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing)  { e.preventDefault(); props.onSubmit?.(); }
        if (e.key === "Escape") { e.preventDefault(); props.onCancel?.(); }
      }}
    />
  );
}

export function FTextarea(props: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; onCancel?: () => void }) {
  return (
    <textarea
      className="w-full resize-none rounded-xl border border-bd/10 bg-s2 px-3 py-2.5 text-sm text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      rows={props.rows ?? 3}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.preventDefault(); props.onCancel?.(); }
      }}
    />
  );
}

export function FSelect(props: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>; placeholder?: string }) {
  return (
    <select
      className="w-full rounded-xl border border-bd/10 bg-s2 px-3 py-2.5 text-sm text-t1 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

export function FDateInput(props: { value: string; onChange: (v: string) => void }) {
  return (
    <input type="date"
      className="block w-full min-w-0 rounded-xl border border-bd/10 bg-s2 px-2 py-2.5 text-sm text-t1 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  );
}

export function FField(props: { label: string; children: ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wider text-t3">{props.label}</span>
      {props.children}
    </div>
  );
}

export function AttachmentPicker(props: { files: File[]; onChange: (files: File[]) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  function add(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = [...props.files, ...Array.from(list)];
    props.onChange(next);
  }
  function remove(idx: number) {
    const next = props.files.filter((_, i) => i !== idx);
    props.onChange(next);
  }
  return (
    <div className="space-y-2">
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
      <button type="button" onClick={() => inputRef.current?.click()} className="rounded-lg border-0 bg-ac/10 px-3 py-1.5 text-xs font-bold text-ac transition hover:bg-ac/20">
        찾아보기
      </button>
      {props.files.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {props.files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-lg border border-bd/10 bg-s2 px-2 py-1 text-xs text-t2">
              <span className="max-w-[160px] truncate">{f.name}</span>
              <span className="text-t3">({Math.max(1, Math.round(f.size / 1024))} KB)</span>
              <button type="button" onClick={() => remove(i)} aria-label="제거" className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-bd/10 bg-s1 text-t3 transition hover:bg-err/15 hover:text-err">
                <svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M 2 2 L 10 10 M 10 2 L 2 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-t3">파일을 첨부하면 에이전트가 그 내용을 읽고 요청에 따라 요약·분석·정리·수정·판정 등을 수행합니다.</p>
      )}
    </div>
  );
}

export function PrimaryBtn(props: { onClick: () => void; children: ReactNode; full?: boolean; size?: "sm" | "lg" }) {
  return (
    <button type="button" onClick={props.onClick} data-role="primary-btn"
      className={[
        "rounded-xl bg-gradient-to-br from-ac-lo to-ac-hi font-bold text-white transition hover:-translate-y-0.5 hover:brightness-110 active:translate-y-0",
        props.full ? "w-full" : "",
        props.size === "lg" ? "px-5 py-3 text-sm" : "px-4 py-2.5 text-sm",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

export function DangerBtn(props: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={props.onClick}
      className="shrink-0 rounded-lg border border-bd/10 px-2 py-1 text-[11px] font-semibold text-t3 transition hover:border-err/25 hover:bg-err/10 hover:text-err"
    >
      {props.children}
    </button>
  );
}

export function EmptyMsg(props: { children: ReactNode }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-bd/10 px-4 py-6 text-center text-sm text-t3">
      {props.children}
    </div>
  );
}

export function Tag(props: { children: ReactNode }) {
  return <span data-role="tag" className="rounded-lg border border-bd/8 bg-s3 px-2 py-0.5 text-[11px] text-t2">{props.children}</span>;
}

export function ExecBadge(props: { status: string }) {
  const map: Record<string, string> = {
    queued: "border-warn/35 bg-warn/10 text-warn",
    active: "border-ok/35 bg-ok/10 text-ok",
    retrying: "border-warn/50 bg-warn/15 text-warn",
    completed: "border-bd/10 bg-s3 text-t3",
  };
  const labels: Record<string, string> = {
    queued: "대기", active: "실행중", retrying: "재요청중", completed: "완료",
  };
  const pulse = props.status === "retrying";
  return (
    <span data-role="exec-badge" className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] font-black ${map[props.status] ?? map.completed}`}>
      {pulse ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" /> : null}
      {labels[props.status] ?? props.status}
    </span>
  );
}
