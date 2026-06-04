import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";
import { AttachmentGallery } from "./AttachmentGallery";
import { ConfirmToast } from "./ConfirmToast";
import { parseInline, renderMarkdown } from "./reportMarkdown";
import { getKey, type LLMProvider } from "../lib/byok";
import {
  DRAFTS_FLUSH_EVENT,
  DRAFTS_RESTORE_EVENT,
  readDrafts,
  setTaskModalDraft,
  type IdleDraftsPayload,
} from "../lib/idleDrafts";
import { MODEL_OPTIONS, findModel, isProviderEnabled, tierBadge } from "../lib/models";
import { downloadReportAsMarkdown, isManualCloseStub } from "../lib/reportFiles";
import type { AgentMember, BossReport, ProviderConfig, Task, Team } from "../lib/types";

const KNOWN_PROVIDERS = new Set<string>(["gemini", "openai", "anthropic"]);

function asLLMProvider(id: string): LLMProvider | null {
  const lower = id.toLowerCase();
  return KNOWN_PROVIDERS.has(lower) ? (lower as LLMProvider) : null;
}

function formatDate(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function Tag(props: { children: ReactNode }) {
  return (
    <span data-role="tag" className="rounded-lg border border-bd/8 bg-s3 px-2 py-0.5 text-[11px] text-t2">
      {props.children}
    </span>
  );
}

function BearIcon({ className, size = 84 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 88 100" fill="none" className={className}>
      <ellipse cx="44" cy="96" rx="26" ry="2.5" fill="#000" opacity="0.16" />
      <path d="M 44 5 Q 48 1 51 3" stroke="#15803d" strokeWidth="2" strokeLinecap="round" fill="none" />
      <circle cx="44" cy="8" r="4.2" fill="#ef4444" stroke="#7f1d1d" strokeWidth="2" />
      <ellipse cx="45.6" cy="6.6" rx="1.2" ry="1.6" fill="#fff" opacity="0.65" />
      <path d="M 22 24 Q 22 12 44 12 Q 66 12 66 24 Z" fill="#fbcfe8" stroke="#9d174d" strokeWidth="2.5" strokeLinejoin="round" />
      <ellipse cx="44" cy="22" rx="20" ry="1.8" fill="#fff5dc" />
      <ellipse cx="34" cy="17" rx="4" ry="2" fill="#fff" opacity="0.55" />
      <path d="M 44 38 C 42 30, 36 22, 26 24 C 16 26, 14 34, 16 44 C 8 48, 4 60, 6 76 C 8 92, 26 100, 44 100 C 62 100, 80 92, 82 76 C 84 60, 80 48, 72 44 C 74 34, 72 26, 62 24 C 52 22, 46 30, 44 38 Z" fill="#a16336" stroke="#3d2510" strokeWidth="2.8" strokeLinejoin="round" />
      <ellipse cx="22" cy="34" rx="4" ry="5" transform="rotate(-16 22 34)" fill="#d4a574" />
      <ellipse cx="66" cy="34" rx="4" ry="5" transform="rotate(16 66 34)" fill="#d4a574" />
      <ellipse cx="44" cy="76" rx="14" ry="9" fill="#d4a574" stroke="#3d2510" strokeWidth="2" />
      <path d="M 16 64 C 12 60, 12 56, 16 58 C 20 56, 20 60, 16 64 Z" fill="#fda4af" />
      <path d="M 72 64 C 68 60, 68 56, 72 58 C 76 56, 76 60, 72 64 Z" fill="#fda4af" />
      <path d="M 28 56 Q 32 61 36 56" stroke="#3d2510" strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M 52 56 Q 56 61 60 56" stroke="#3d2510" strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <path d="M 41 71 L 47 71 L 44 75 Z" fill="#3d2510" />
      <path d="M 44 76 Q 41 79 39.5 78" stroke="#3d2510" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M 44 76 Q 47 79 48.5 78" stroke="#3d2510" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function UpArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M 5 13 L 10 7 L 15 13" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReportModal(props: { report?: BossReport; team?: Team; agent?: AgentMember; task?: Task; availableAgents?: AgentMember[]; providers?: ProviderConfig[]; onProviderModelChange?: (providerId: string, model: string) => void; onToggleProvider?: (providerId: string) => void; onAddAttachment?: (file: File) => Promise<void>; onRemoveAttachment?: (attachmentId: string) => Promise<void>; onRerun?: () => void; onUpdate?: (patch: Partial<Task>) => void; onClose: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const editable = !!props.task && !!props.onUpdate && !props.report;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(props.task?.title ?? "");
  const [draftDescription, setDraftDescription] = useState(props.task?.description ?? "");
  const [draftImageOutput, setDraftImageOutput] = useState(!!props.task?.imageOutput);
  const [draftImageGridCount, setDraftImageGridCount] = useState(props.task?.imageGridCount ?? 1);
  const [draftAgentId, setDraftAgentId] = useState(props.task?.agentId ?? "");
  const [draftPendingFiles, setDraftPendingFiles] = useState<File[]>([]);
  const [draftRemovedAttachmentIds, setDraftRemovedAttachmentIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRerunOpen, setConfirmRerunOpen] = useState(false);
  const agentEditable = editable && !props.task?.workflowEnabled && (props.availableAgents?.length ?? 0) > 0;
  useEscapeClose(true, props.onClose);
  function resetDrafts() { setDraftTitle(props.task?.title ?? ""); setDraftDescription(props.task?.description ?? ""); setDraftImageOutput(!!props.task?.imageOutput); setDraftImageGridCount(props.task?.imageGridCount ?? 1); setDraftAgentId(props.task?.agentId ?? ""); setDraftPendingFiles([]); setDraftRemovedAttachmentIds(new Set()); setSaveError(null); }
  async function commitEdits(): Promise<boolean> {
    const liveTitle = titleInputRef.current?.value ?? draftTitle;
    const liveDescription = descTextareaRef.current?.value ?? draftDescription;
    const trimmedTitle = liveTitle.trim();
    if (!trimmedTitle || saving) return false;
    setSaving(true); setSaveError(null);
    const patch: Partial<Task> = { title: trimmedTitle, description: liveDescription.trim(), imageOutput: draftImageOutput, imageGridCount: draftImageOutput ? draftImageGridCount : undefined };
    if (agentEditable && draftAgentId && draftAgentId !== props.task?.agentId) {
      const nextAgent = props.availableAgents?.find((a) => a.id === draftAgentId);
      if (nextAgent) { patch.agentId = nextAgent.id; patch.assignee = nextAgent.name; }
    }
    props.onUpdate?.(patch);
    const failures: string[] = [];
    if (props.onRemoveAttachment) for (const id of draftRemovedAttachmentIds) { try { await props.onRemoveAttachment(id); } catch (e) { failures.push(`삭제 실패: ${e instanceof Error ? e.message : id}`); } }
    if (props.onAddAttachment) for (const file of draftPendingFiles) { try { await props.onAddAttachment(file); } catch (e) { failures.push(`업로드 실패 (${file.name}): ${e instanceof Error ? e.message : "unknown"}`); } }
    setSaving(false);
    if (failures.length > 0) { setSaveError(failures.join("\n")); setDraftPendingFiles([]); setDraftRemovedAttachmentIds(new Set()); return false; }
    setDraftPendingFiles([]); setDraftRemovedAttachmentIds(new Set()); setEditing(false); return true;
  }
  useEffect(() => { const el = contentRef.current; if (!el) return; const onScroll = () => setShowScrollTop(el.scrollTop > 200); el.addEventListener("scroll", onScroll); return () => el.removeEventListener("scroll", onScroll); }, []);
  useEffect(() => { if (!editing || !props.task) return; const taskId = props.task.id; const onFlush = () => { setTaskModalDraft({ taskId, title: titleInputRef.current?.value ?? draftTitle, description: descTextareaRef.current?.value ?? draftDescription, imageOutput: draftImageOutput, imageGridCount: draftImageGridCount, agentId: draftAgentId, savedAt: Date.now() }); }; window.addEventListener(DRAFTS_FLUSH_EVENT, onFlush); return () => window.removeEventListener(DRAFTS_FLUSH_EVENT, onFlush); }, [editing, props.task, draftTitle, draftDescription, draftImageOutput, draftImageGridCount, draftAgentId]);
  const restoredRef = useRef(false);
  useEffect(() => { function applyTaskModal(tm: IdleDraftsPayload["taskModal"]) { if (restoredRef.current) return; if (!tm || !props.task || tm.taskId !== props.task.id) return; restoredRef.current = true; setEditing(true); setDraftTitle(tm.title ?? ""); setDraftDescription(tm.description ?? ""); if (typeof tm.imageOutput === "boolean") setDraftImageOutput(tm.imageOutput); if (typeof tm.imageGridCount === "number") setDraftImageGridCount(tm.imageGridCount); if (typeof tm.agentId === "string") setDraftAgentId(tm.agentId); } const onRestore = (ev: Event) => { const ce = ev as CustomEvent<IdleDraftsPayload>; applyTaskModal(ce.detail?.taskModal); }; window.addEventListener(DRAFTS_RESTORE_EVENT, onRestore as EventListener); const cached = readDrafts(); if (cached?.taskModal) applyTaskModal(cached.taskModal); return () => window.removeEventListener(DRAFTS_RESTORE_EVENT, onRestore as EventListener); }, [props.task]);
  const scrollToTop = () => contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  return createPortal(<div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true"><div data-role="modal-window" className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-bd/15 bg-s1 shadow-2xl" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") e.stopPropagation(); }}><div data-role="modal-titlebar" className="relative flex shrink-0 items-start gap-3 rounded-t-2xl border-b border-bd/10 bg-s1 px-6 py-4 pr-12"><div className="min-w-0 flex-1">{editing ? <input ref={titleInputRef} type="text" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} onCompositionEnd={(e) => setDraftTitle((e.target as HTMLInputElement).value)} placeholder="제목" className="w-full rounded-lg border border-bd/15 bg-s2 px-2 py-1 text-base font-black text-t1 focus:border-ac/50 focus:outline-none focus:ring-2 focus:ring-ac/15" autoFocus /> : <p className="text-base font-black text-t1">{parseInline(props.report?.title ?? props.task?.title ?? "태스크 상세")}</p>}<p className="mt-0.5 text-xs text-ac/70">{props.report ? formatDate(props.report.deliveredAt) : props.task?.createdAt ? formatDate(props.task.createdAt) : ""}</p></div><ModalCloseButton onClose={props.onClose} /></div><div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-bd/10 px-6 pt-3 pb-4"><div className="flex flex-wrap items-center gap-2">{props.team ? <Tag>{props.team.name}</Tag> : null}{props.agent ? <Tag>{props.agent.name}</Tag> : null}{props.report ? <Tag>{props.report.status === "approved" ? "승인됨" : props.report.status === "rejected" ? "재요청됨" : "검토 중"}</Tag> : props.task ? <Tag>{props.task.executionStatus === "completed" ? "완료" : props.task.executionStatus === "active" ? "실행 중" : props.task.executionStatus === "retrying" ? "재시도 중" : "대기"}</Tag> : null}</div><div className="flex items-center gap-1.5">{editable && !editing ? <button type="button" onClick={() => { resetDrafts(); setEditing(true); }} className="rounded-lg border border-bd/15 bg-s2 px-2 py-0.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1">편집</button> : null}{editable && editing ? <><button type="button" onClick={() => { resetDrafts(); setEditing(false); }} disabled={saving} className="rounded-lg border border-bd/15 bg-s2 px-2 py-0.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40">취소</button><button type="button" onMouseDown={() => { const ae = document.activeElement as HTMLElement | null; if (ae && (ae === titleInputRef.current || ae === descTextareaRef.current)) ae.blur(); }} onClick={() => { void commitEdits(); }} disabled={!draftTitle.trim() || saving} className="rounded-lg border border-ok/40 bg-ok/15 px-2 py-0.5 text-[11px] font-bold text-ok transition enabled:hover:bg-ok/25 disabled:cursor-not-allowed disabled:opacity-40">{saving ? "저장중…" : "저장"}</button></> : null}{props.report ? <button type="button" onClick={() => downloadReportAsMarkdown(props.report!, props.task)} title="현재 보고서를 .md 파일로 다운로드" className="rounded-lg border border-bd/15 bg-s2 px-2 py-0.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1">저장</button> : null}{props.task && props.onRerun && !editing ? (() => { const exec = props.task.executionStatus; const disabled = exec === "active" || exec === "retrying"; const label = exec === "active" ? "실행중…" : exec === "retrying" ? "재시도중…" : exec === "completed" ? "재실행" : "시작"; const needsConfirm = exec === "completed" && !!props.report; return <button type="button" onClick={() => { if (needsConfirm) setConfirmRerunOpen(true); else { props.onRerun?.(); props.onClose(); } }} disabled={disabled} className="rounded-lg border border-ac/40 bg-ac/15 px-2 py-0.5 text-[11px] font-bold text-ac transition enabled:hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-40">{label}</button>; })() : null}</div></div><div ref={contentRef} className="flex-1 overflow-y-auto px-6 py-5">{props.report ? <><>{isManualCloseStub(props.report.summary) ? <div className="mb-4 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5"><p className="text-[12px] font-bold leading-relaxed text-amber-700 dark:text-amber-400">AI 실행 없이 수동으로 마감된 보고서입니다.</p><p className="mt-1 text-[11px] leading-relaxed text-amber-800/85 dark:text-amber-300/85">상단의 \"재실행\" 버튼을 누르면 AI 에이전트가 동일한 요청을 다시 실행하고, 새 결과가 받은함에 별도 항목으로 도착합니다.</p></div> : null}</><>{renderMarkdown(props.report.summary)}</></> : props.task ? <><p className="mb-2 text-[11px] font-black uppercase tracking-wider text-t3">설명</p>{editing ? <textarea ref={descTextareaRef} value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} onCompositionEnd={(e) => setDraftDescription((e.target as HTMLTextAreaElement).value)} rows={6} placeholder="자세한 내용" className="w-full resize-y rounded-lg border border-bd/15 bg-s2 px-3 py-2 text-sm leading-relaxed text-t1 focus:border-ac/50 focus:outline-none focus:ring-2 focus:ring-ac/15" /> : props.task.description ? <div className="whitespace-pre-wrap text-sm leading-relaxed text-t2">{props.task.description}</div> : <p className="text-sm text-t3">설명이 없습니다.</p>}{editing && props.onProviderModelChange && props.onToggleProvider && props.providers ? (() => { type Row = { providerId: string; providerName: string; llm: LLMProvider; opt: (typeof MODEL_OPTIONS)[LLMProvider][number]; hasKey: boolean }; const rows: Row[] = []; for (const p of props.providers) { const llm = asLLMProvider(p.id); if (!llm || !isProviderEnabled(llm)) continue; const hasKey = !!getKey(llm); for (const opt of MODEL_OPTIONS[llm]) rows.push({ providerId: p.id, providerName: p.name, llm, opt, hasKey }); } const activeProv = props.providers.find((p) => p.enabled); const currentValue = activeProv ? `${activeProv.id}::${activeProv.model}` : ""; const currentRow = rows.find((r) => r.providerId === activeProv?.id && r.opt.id === activeProv?.model) ?? null; const currentBadge = currentRow ? tierBadge(currentRow.opt.tier) : null; const onSelect = (value: string) => { const [providerId, modelId] = value.split("::"); if (!providerId || !modelId) return; const row = rows.find((r) => r.providerId === providerId && r.opt.id === modelId); if (!row || !row.hasKey) return; props.onProviderModelChange?.(providerId, modelId); for (const p of props.providers!) { if (p.id === providerId) { if (!p.enabled) props.onToggleProvider?.(p.id); } else if (p.enabled) { props.onToggleProvider?.(p.id); } } }; return <div className="mt-4 flex items-center gap-2 rounded-xl border border-bd/10 bg-s2 px-2.5 py-2 text-xs text-t2"><label className="shrink-0 font-bold text-t1" htmlFor="modal-model-select">AI 모델</label>{rows.length > 0 ? <><select id="modal-model-select" value={currentValue} onChange={(e) => onSelect(e.target.value)} className="min-w-0 flex-1 cursor-pointer rounded-lg border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15">{!currentRow && activeProv ? <option value={currentValue} disabled>{activeProv.name} · {activeProv.model} (비표준)</option> : null}{rows.map((r) => <option key={`${r.providerId}::${r.opt.id}`} value={`${r.providerId}::${r.opt.id}`} disabled={!r.hasKey}>{r.providerName} · {r.opt.id}{!r.hasKey ? " — API 키 미등록" : ""}</option>)}</select>{currentBadge ? <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold ${currentBadge.className}`}>{currentBadge.label}</span> : null}</> : <span className="text-[11px] text-t3">선택 가능한 모델이 없습니다.</span>}</div>; })() : null}{editing && agentEditable ? <div className="mt-3 flex items-center gap-2 rounded-xl border border-bd/10 bg-s2 px-2.5 py-2 text-xs text-t2"><label className="font-bold text-t1" htmlFor="modal-agent-select">담당 에이전트</label><select id="modal-agent-select" value={draftAgentId} onChange={(e) => setDraftAgentId(e.target.value)} className="cursor-pointer rounded-lg border border-bd/10 bg-s1 px-2 py-1 text-[11px] font-bold text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15">{props.availableAgents?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div> : null}{editing && props.task.workflowEnabled ? <p className="mt-3 text-[11px] text-t3">워크플로 태스크는 단계별 담당 에이전트가 워크플로 정의로 고정됩니다.</p> : null}{editing ? <div data-role="form-panel" className="mt-4 rounded-xl border border-bd/10 bg-s2 p-2.5 text-xs text-t2"><div className="flex items-center gap-2"><input type="checkbox" checked={draftImageOutput} onChange={(e) => setDraftImageOutput(e.target.checked)} className="h-4 w-4 shrink-0 cursor-pointer accent-ac" /><span className="font-bold text-t1">이미지</span><select id="modal-image-grid-count" aria-label="이미지 개수와 배치" disabled={!draftImageOutput} value={draftImageGridCount} onChange={(e) => setDraftImageGridCount(Number(e.target.value))} className="select-compact cursor-pointer rounded-lg border border-bd/10 bg-s1 pl-2 pr-5 py-1 text-[11px] font-bold text-t1 transition focus:border-ac/50 focus:ring-2 focus:ring-ac/15 disabled:cursor-not-allowed disabled:opacity-50"><option value={1}>1 (1x1)</option><option value={4}>4 (2x2)</option><option value={6}>6 (2x3)</option><option value={9}>9 (3x3)</option><option value={10}>10 (5x2)</option><option value={12}>12 (3x4)</option></select></div><p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-t3">이미지 작업이 포함된 경우 완료 보고서에 이미지가 첨부됩니다. <span className="whitespace-nowrap">(Gemini 전용)</span></p></div> : props.task.imageOutput ? <p className="mt-3 text-[11px] text-t3">이미지 결과물 받기: ON {props.task.imageGridCount ? `(${props.task.imageGridCount}개)` : ""}</p> : null}{props.task.executionStatus !== "completed" ? <p className="mt-4 text-[11px] text-t3">아직 보고서가 생성되지 않았습니다. 태스크를 실행하거나 워크플로가 완료되면 보고서 본문이 여기에 표시됩니다.</p> : null}</> : null}{props.task ? <AttachmentGallery task={props.task} editing={editing} pendingFiles={draftPendingFiles} removedIds={draftRemovedAttachmentIds} onStageAdd={(f) => setDraftPendingFiles((prev) => [...prev, f])} onStageRemove={(id) => setDraftRemovedAttachmentIds((prev) => { const next = new Set(prev); next.add(id); return next; })} onUnstageAdd={(idx) => setDraftPendingFiles((prev) => prev.filter((_, i) => i !== idx))} onUnstageRemove={(id) => setDraftRemovedAttachmentIds((prev) => { const next = new Set(prev); next.delete(id); return next; })} /> : null}{editing && saveError ? <p className="mt-3 whitespace-pre-line rounded-lg border border-err/30 bg-err/10 p-2 text-[11px] text-err">{saveError}</p> : null}</div>{showScrollTop ? <button type="button" onClick={scrollToTop} data-role="scroll-top" aria-label="맨 위로 가기" title="맨 위로" className="absolute bottom-5 right-5 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-ac text-white shadow-lg transition hover:scale-110 hover:bg-ac-hi"><UpArrowIcon /></button> : null}</div><ConfirmToast open={confirmRerunOpen} title="재실행하시겠어요?" message="새 결과가 받은함에 별도 항목으로 도착합니다. 기존 보고서는 그대로 남습니다." confirmLabel="재실행" cancelLabel="취소" variant="danger" icon={<BearIcon />} extraAction={props.report ? { label: "보고서 저장", onClick: () => downloadReportAsMarkdown(props.report!, props.task) } : undefined} onConfirm={() => { setConfirmRerunOpen(false); props.onRerun?.(); props.onClose(); }} onCancel={() => setConfirmRerunOpen(false)} /></div>, document.body);
}
