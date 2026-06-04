import { useRef, useState } from "react";
import type { Task } from "../lib/types";

function PendingImageTile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url] = useState(() => URL.createObjectURL(file));
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-lg border border-ac/40 bg-s2">
      {!failed ? (
        <img src={url} alt={file.name}
          onError={() => setFailed(true)}
          className="block h-32 w-full object-cover" />
      ) : (
        <div className="flex h-32 w-full items-center justify-center text-[11px] text-t3">
          미리보기 불가
        </div>
      )}
      <div className="truncate px-2 py-1 text-[11px] text-ac">신규 · {file.name}</div>
      <button type="button"
        onClick={onRemove}
        aria-label={`${file.name} 첨부 취소`}
        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-err/40 bg-err/85 text-white shadow transition hover:bg-err">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M 2 2 L 10 10 M 10 2 L 2 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function AttachmentGallery({
  task,
  editing = false,
  pendingFiles,
  removedIds,
  onStageAdd,
  onStageRemove,
  onUnstageAdd,
  onUnstageRemove,
}: {
  task: Task;
  editing?: boolean;
  pendingFiles?: File[];
  removedIds?: Set<string>;
  onStageAdd?: (file: File) => void;
  onStageRemove?: (attachmentId: string) => void;
  onUnstageAdd?: (index: number) => void;
  onUnstageRemove?: (attachmentId: string) => void;
}) {
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
  const isImageAttachment = (a: { mime: string; name: string }) =>
    a.mime.startsWith("image/") || IMAGE_EXT_RE.test(a.name);
  const isImageFile = (f: File) => f.type.startsWith("image/") || IMAGE_EXT_RE.test(f.name);

  const atts = task.attachments ?? [];
  const images = atts.filter(isImageAttachment);
  const others = atts.filter((a) => !isImageAttachment(a));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const staged = pendingFiles ?? [];
  const removed = removedIds ?? new Set<string>();

  if (!editing && atts.length === 0 && staged.length === 0) return null;

  const visibleCount = atts.length - removed.size + staged.length;

  return (
    <div className="mt-6 border-t border-bd/10 pt-4">
      <p className="mb-2 text-xs font-black text-t3">첨부 ({visibleCount})</p>
      {images.length > 0 || staged.some(isImageFile) ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((a) => {
            const url = `/api/tasks/${task.id}/attachments/${a.id}`;
            const isRemoved = removed.has(a.id);
            const previewBody = (
              <>
                <img src={url} alt={a.name}
                  className="block h-32 w-full object-cover" loading="lazy" />
                <div className="truncate px-2 py-1 text-[11px] text-t3">{a.name}</div>
              </>
            );
            return (
              <div key={a.id}
                className={[
                  "relative overflow-hidden rounded-lg border bg-s2 transition",
                  isRemoved ? "border-err/40 opacity-40" : "border-bd/10 hover:border-ac/40",
                ].join(" ")}>
                {isRemoved ? (
                  <div className="block cursor-not-allowed" aria-disabled="true" title="삭제 예정 — 되돌리기 후 다운로드 가능">
                    {previewBody}
                  </div>
                ) : (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                    {previewBody}
                  </a>
                )}
                {editing ? (
                  isRemoved ? (
                    <button type="button"
                      onClick={() => onUnstageRemove?.(a.id)}
                      aria-label={`${a.name} 삭제 취소`}
                      className="absolute right-1.5 top-1.5 inline-flex h-6 items-center justify-center rounded-full border border-bd/30 bg-s1/90 px-2 text-[10px] font-bold text-t1 shadow transition hover:bg-s2">
                      되돌리기
                    </button>
                  ) : (
                    <button type="button"
                      onClick={() => onStageRemove?.(a.id)}
                      aria-label={`${a.name} 삭제`}
                      className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full border border-err/40 bg-err/85 text-white shadow transition hover:bg-err">
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                        <path d="M 2 2 L 10 10 M 10 2 L 2 10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                      </svg>
                    </button>
                  )
                ) : null}
              </div>
            );
          })}
          {editing && staged.map((f, idx) => {
            if (!isImageFile(f)) return null;
            return (
              <PendingImageTile
                key={`__pending-${idx}`}
                file={f}
                onRemove={() => onUnstageAdd?.(idx)}
              />
            );
          })}
        </div>
      ) : null}
      {others.length > 0 || staged.some((f) => !isImageFile(f)) ? (
        <ul className="mt-2 space-y-1">
          {others.map((a) => {
            const isRemoved = removed.has(a.id);
            return (
              <li key={a.id} className={`flex items-center gap-2 ${isRemoved ? "opacity-40" : ""}`}>
                {isRemoved ? (
                  <span className="cursor-not-allowed text-xs text-t3 line-through" title="삭제 예정 — 되돌리기 후 다운로드 가능">
                    {a.name} ({Math.max(1, Math.round(a.size / 1024))} KB)
                  </span>
                ) : (
                  <a href={`/api/tasks/${task.id}/attachments/${a.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs font-bold text-ac transition hover:opacity-80">
                    {a.name} ({Math.max(1, Math.round(a.size / 1024))} KB)
                  </a>
                )}
                {editing ? (
                  isRemoved ? (
                    <button type="button"
                      onClick={() => onUnstageRemove?.(a.id)}
                      className="rounded-md border border-bd/30 bg-s2 px-1.5 py-0.5 text-[10px] font-bold text-t1 transition hover:bg-s3">
                      되돌리기
                    </button>
                  ) : (
                    <button type="button"
                      onClick={() => onStageRemove?.(a.id)}
                      className="rounded-md border border-err/30 bg-err/10 px-1.5 py-0.5 text-[10px] font-bold text-err transition hover:bg-err/20">
                      삭제
                    </button>
                  )
                ) : null}
              </li>
            );
          })}
          {editing && staged.map((f, idx) => {
            if (isImageFile(f)) return null;
            return (
              <li key={`__pending-${idx}`} className="flex items-center gap-2 text-xs text-ac">
                신규 · {f.name} ({Math.max(1, Math.round(f.size / 1024))} KB)
                <button type="button"
                  onClick={() => onUnstageAdd?.(idx)}
                  className="rounded-md border border-err/30 bg-err/10 px-1.5 py-0.5 text-[10px] font-bold text-err transition hover:bg-err/20">
                  취소
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {editing && onStageAdd ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files;
              if (files && files.length > 0) {
                for (const f of Array.from(files)) onStageAdd(f);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }
            }}
          />
          <button type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-bd/15 bg-s2 px-2 py-1 text-[11px] font-bold text-t1 transition hover:bg-s3">
            찾아보기
          </button>
          <span className="text-[11px] text-t3">여러 개 선택 가능 · 저장 시 업로드됩니다</span>
        </div>
      ) : null}
    </div>
  );
}
