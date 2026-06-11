import { useEffect, useRef, useState } from "react";
import type { NotificationTarget, WebhookConfig } from "../lib/types";
import { Card, DangerBtn, EmptyMsg, FInput, PrimaryBtn, SideSection, Toggle } from "./BoardViewPrimitives";

export function WebhookSection(props: {
  config: WebhookConfig;
  onToggle: () => void;
  onRegenerate: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const ingestPath = props.config.token
    ? `/api/webhooks/${props.config.token}/ingest`
    : "";

  const fullUrl = props.config.token
    ? `${window.location.origin}${ingestPath}`
    : "";

  function fallbackCopy(text: string) {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
    document.body.appendChild(el);
    el.focus();
    el.select();
    try {
      document.execCommand("copy");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } finally {
      document.body.removeChild(el);
    }
  }

  function copyUrl() {
    const text = fullUrl;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  return (
    <SideSection title="Webhook 수신">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-bold text-t1">크론 수신 엔드포인트</p>
            <p className="text-[11px] text-t3">{props.config.enabled ? "활성화됨" : "비활성화됨"}</p>
          </div>
          <Toggle on={props.config.enabled} onClick={props.onToggle} />
        </div>

        {props.config.enabled && (
          <>
            <div className="rounded-xl border border-bd/10 bg-s3 px-3 py-2">
              <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-t3">엔드포인트 URL</p>
              <p className="break-all font-mono text-[11px] text-t2">{fullUrl}</p>
            </div>

            <div className="flex gap-1.5">
              <button type="button" onClick={copyUrl}
                className="flex-1 rounded-xl border border-bd/10 bg-s2 py-1.5 text-[11px] font-bold text-t2 transition hover:bg-s3 hover:text-t1">
                {copied ? "복사됨" : "URL 복사"}
              </button>
              <button type="button" onClick={props.onRegenerate}
                className="flex-1 rounded-xl border border-err/25 bg-err/8 py-1.5 text-[11px] font-bold text-err transition hover:bg-err/15">
                토큰 재생성
              </button>
            </div>

            <div className="rounded-xl border border-ac/15 bg-ac/5 px-3 py-2">
              <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-ac">크론 스크립트 예시</p>
              <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-relaxed text-t2">{`#!/bin/bash
DATA=$(your_data_command)
[ -z "$DATA" ] && exit 0

curl -sX POST \\
  "${fullUrl}" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\\"source\\\": \\\"cron-name\\\",
    \\\"data\\\": \\\"$DATA\\\",
    \\\"hasNewData\\\": true
  }"`}</pre>
            </div>
          </>
        )}
      </div>
    </SideSection>
  );
}

function NotificationCard(props: {
  n: NotificationTarget;
  onRemove: () => void;
  onToggle: () => void;
  onUpdate: (name: string, url: string) => void;
}) {
  const { n } = props;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(n.name);
  const [editUrl, setEditUrl] = useState(n.url);
  const nameRef = useRef<HTMLParagraphElement>(null);
  const urlRef = useRef<HTMLParagraphElement>(null);
  const [nameClamped, setNameClamped] = useState(false);
  const [urlClamped, setUrlClamped] = useState(false);

  useEffect(() => {
    const nameEl = nameRef.current;
    const urlEl = urlRef.current;
    if (nameEl) setNameClamped(nameEl.scrollWidth > nameEl.clientWidth);
    if (urlEl) setUrlClamped(urlEl.scrollWidth > urlEl.clientWidth);
  }, [n.name, n.url]);

  function handleSave() {
    const trimUrl = editUrl.trim();
    if (!trimUrl) return;
    props.onUpdate(editName.trim() || trimUrl, trimUrl);
    setEditing(false);
  }

  function handleCancel() {
    setEditName(n.name);
    setEditUrl(n.url);
    setEditing(false);
  }

  const showToggle = !editing && (nameClamped || urlClamped);

  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1.5">
              <input
                className="w-full rounded-lg border border-bd/10 bg-s3 px-2.5 py-1.5 text-sm text-t1 transition focus:border-ac/50 focus:ring-1 focus:ring-ac/20"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="이름"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); handleSave(); } if (e.key === "Escape") { e.preventDefault(); handleCancel(); } }}
              />
              <input
                className="w-full rounded-lg border border-bd/10 bg-s3 px-2.5 py-1.5 font-mono text-[11px] text-t2 transition focus:border-ac/50 focus:ring-1 focus:ring-ac/20"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
                placeholder="https://host/api/receive"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); handleSave(); } if (e.key === "Escape") { e.preventDefault(); handleCancel(); } }}
              />
              <div className="flex gap-1.5">
                <button type="button" className="flex-1 rounded-lg bg-ac/15 px-2 py-1 text-[11px] font-bold text-ac transition hover:bg-ac/25" onClick={handleSave}>저장</button>
                <button type="button" className="flex-1 rounded-lg border border-bd/10 bg-s3 px-2 py-1 text-[11px] font-bold text-t3 transition hover:text-t1" onClick={handleCancel}>취소</button>
              </div>
            </div>
          ) : (
            <>
              <p ref={nameRef} className={["text-sm font-bold text-t1", expanded ? "break-all" : "truncate"].join(" ")}>{n.name}</p>
              <p ref={urlRef} className={["font-mono text-[10px] text-t3", expanded ? "break-all" : "truncate"].join(" ")}>{n.url}</p>
              <div className="mt-1.5 flex gap-1.5">
                <button type="button" className="rounded-lg bg-ac/15 px-2 py-0.5 text-[11px] font-bold text-ac transition hover:bg-ac/25" onClick={() => { setEditName(n.name); setEditUrl(n.url); setEditing(true); setExpanded(false); }}>수정</button>
                {showToggle ? (
                  <button type="button" className="rounded-lg bg-ac/15 px-2 py-0.5 text-[11px] font-bold text-ac transition hover:bg-ac/25" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "접기 ↑" : "펼치기 ↓"}
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
        {!editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Toggle on={n.enabled} onClick={props.onToggle} />
            <DangerBtn onClick={props.onRemove}>삭제</DangerBtn>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function NotificationSection(props: {
  notifications: NotificationTarget[];
  onAdd: (name: string, url: string) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string) => void;
  onUpdate: (id: string, name: string, url: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  function handleAdd() {
    const trimName = name.trim();
    const trimUrl = url.trim();
    if (!trimUrl) return;
    props.onAdd(trimName || trimUrl, trimUrl);
    setName("");
    setUrl("");
  }

  return (
    <SideSection title="알림 전송">
      <div className="space-y-2">
        {props.notifications.length === 0 ? (
          <EmptyMsg>등록된 알림 대상이 없습니다.</EmptyMsg>
        ) : (
          props.notifications.map((n) => (
            <NotificationCard key={n.id} n={n}
              onRemove={() => props.onRemove(n.id)}
              onToggle={() => props.onToggle(n.id)}
              onUpdate={(nameValue, urlValue) => props.onUpdate(n.id, nameValue, urlValue)}
            />
          ))
        )}

        <div className="space-y-2 border-t border-bd/8 pt-2">
          <FInput value={name} onChange={setName} placeholder="이름 (선택)" compact onSubmit={handleAdd} />
          <FInput value={url} onChange={setUrl} placeholder="https://host/api/receive" compact onSubmit={handleAdd} />
          <PrimaryBtn onClick={handleAdd} full>+ 알림 URL 추가</PrimaryBtn>
        </div>
      </div>
    </SideSection>
  );
}
