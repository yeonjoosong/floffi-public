import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useEscapeClose } from "../lib/escapeStack";
import { ModalCloseButton } from "./ModalCloseButton";

function avatarInitial(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  const upper = first.toUpperCase();
  return upper === first.toLowerCase() ? first : upper;
}

function firstGrapheme(s: string): string {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) {
    const seg = new Seg(undefined, { granularity: "grapheme" });
    for (const { segment } of seg.segment(s)) return segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}

function avatarGlyph(avatar: string, nickname: string, email = ""): string {
  const a = avatar.trim();
  if (a !== "") return a;
  const fromNick = avatarInitial(nickname);
  if (fromNick !== "") return fromNick;
  return avatarInitial(email);
}

const AVATAR_EMOJI_GROUPS: Array<{ label: string; emojis: string[] }> = [
  { label: "표정", emojis: ["😀", "😄", "😁", "😊", "🙂", "😉", "😎", "🤓", "🥳", "😇", "🤔", "😴", "🤩", "😍", "🤗", "😺"] },
  { label: "사람·손", emojis: ["👋", "🙌", "👍", "👏", "🙏", "💪", "🫡", "🧑‍💻", "👩‍💻", "👨‍💻", "🧙", "🦸", "🥷", "🧑‍🚀", "🧑‍🎨", "🕵️"] },
  { label: "동물·자연", emojis: ["🐶", "🐱", "🦊", "🐼", "🐨", "🦁", "🐯", "🐸", "🐵", "🦄", "🐙", "🦋", "🌱", "🌳", "🌸", "🍀"] },
  { label: "사물·기호", emojis: ["⭐️", "✨", "🔥", "⚡️", "💡", "🚀", "🎯", "🏆", "🎉", "💎", "🧩", "📌", "📚", "🎨", "🛠️", "❤️"] },
];

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

function FInput(props: { value: string; onChange: (v: string) => void; placeholder?: string; onSubmit?: () => void; onCancel?: () => void }) {
  return (
    <input
      className="w-full rounded-xl border border-bd/10 bg-s2 px-3 py-2.5 text-sm text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
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

function EmojiAvatarPicker(props: {
  anchor: HTMLElement | null;
  current: string;
  onPick: (emoji: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const [hasCustom, setHasCustom] = useState(false);
  useEscapeClose(true, props.onClose);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    function place() {
      const a = props.anchor;
      if (!a) return;
      const r = a.getBoundingClientRect();
      const width = Math.min(window.innerWidth - 24, 360);
      let left = r.left;
      if (left + width > window.innerWidth - 12) left = window.innerWidth - 12 - width;
      if (left < 12) left = 12;
      setPos({ top: r.bottom + 8, left });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [props.anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (props.anchor?.contains(t)) return;
      props.onClose();
    };
    const id = window.setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
    };
  }, [props]);

  return createPortal(
    <div
      ref={rootRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.min(window.innerWidth - 24, 360) }}
      className="z-[70] rounded-2xl border-2 border-bd/15 bg-s1 p-3 shadow-2xl"
      role="dialog"
      aria-label="이모지 선택"
    >
      <div className="emoji-picker-scroll max-h-[260px] space-y-3 overflow-y-auto pr-1">
        {AVATAR_EMOJI_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="mb-1.5 text-[10px] font-black uppercase tracking-wider text-t3">{group.label}</p>
            <div className="grid grid-cols-6 gap-1.5">
              {group.emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => props.onPick(emoji)}
                  aria-label={emoji}
                  className={[
                    "flex aspect-square items-center justify-center rounded-xl leading-none transition hover:bg-s3",
                    props.current === emoji ? "bg-ac/20 ring-1 ring-ac/50" : "",
                  ].join(" ")}
                  style={{ fontFamily: EMOJI_FONT, fontSize: "26px" }}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-bd/10 pt-3">
        <input
          ref={customRef}
          className="min-w-0 flex-1 rounded-lg border border-bd/10 bg-s2 px-2.5 py-1.5 text-base text-t1 placeholder:text-t3 transition focus:border-ac/50 focus:bg-s1 focus:ring-2 focus:ring-ac/15"
          defaultValue=""
          maxLength={8}
          placeholder="직접 입력"
          onInput={(e) => {
            const el = e.target as HTMLInputElement;
            const one = firstGrapheme(el.value);
            if (el.value !== one) el.value = one;
            setHasCustom(one.trim() !== "");
          }}
          style={{ fontFamily: hasCustom ? EMOJI_FONT : "inherit" }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) props.onPick(v);
            props.onClose();
          }}
        />
        <button
          type="button"
          disabled={!hasCustom}
          onClick={() => {
            const v = customRef.current?.value.trim() ?? "";
            if (v) props.onPick(v);
            props.onClose();
          }}
          className="shrink-0 rounded-lg border border-ac/40 bg-ac/15 px-2.5 py-1.5 text-[11px] font-bold text-ac transition hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          적용
        </button>
        <button
          type="button"
          onClick={props.onClear}
          title="이모지 삭제 — 닉네임/이메일 첫 글자로 표시"
          className="shrink-0 rounded-lg border border-err/40 bg-err/10 px-2.5 py-1.5 text-[11px] font-bold text-err transition hover:bg-err/20"
        >
          삭제
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function UserInfoModal(props: {
  username: string;
  nickname: string;
  email: string;
  avatar: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.nickname);
  const [avatarDraft, setAvatarDraft] = useState(props.avatar);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const avatarBtnRef = useRef<HTMLButtonElement>(null);

  useEscapeClose(true, props.onClose);

  const previewGlyph = avatarGlyph(avatarDraft, draft, props.email);

  async function patch(path: string, body: unknown): Promise<boolean> {
    const res = await fetch(path, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  }

  async function save() {
    if (saving) return;
    setError("");
    setSaving(true);
    try {
      if (!(await patch("/api/auth/profile/nickname", { nickname: draft.trim() }))) {
        setError("저장에 실패했어요.");
        return;
      }
      if (avatarDraft.trim() !== props.avatar) {
        if (!(await patch("/api/auth/profile/avatar", { avatar: avatarDraft.trim() }))) {
          setError("아바타 저장에 실패했어요.");
          return;
        }
      }
      props.onSaved();
      props.onClose();
    } catch {
      setError("저장 요청에 실패했어요.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true">
      <div className="confirm-toast-backdrop absolute inset-0 bg-black/45 backdrop-blur-sm" aria-hidden />
      <div data-role="modal-window"
        className="absolute left-1/2 top-1/2 w-[min(94vw,460px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-3xl border-2 border-bd/20 bg-s1 shadow-2xl">
        <ModalCloseButton onClose={props.onClose} />
        <div data-role="modal-titlebar" className="flex items-center justify-between border-b border-bd/10 px-5 py-3 pr-12">
          <h3 className="text-base font-black text-t1">사용자 정보</h3>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-t3">로그인 ID</label>
            <div className="rounded-xl border border-bd/10 bg-s2 px-3 py-2 text-sm text-t2">
              {props.username}
            </div>
            <p className="mt-1.5 text-[11px] text-t3">이메일로 가입할 때 자동 생성된 고유 식별자입니다.</p>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-black uppercase tracking-wider text-t3">아바타 · 닉네임</label>
            <div className="flex items-center gap-3">
              <div className="relative">
                <button
                  ref={avatarBtnRef}
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                  title="이모지 선택"
                  className="group relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ac text-lg font-black text-white ring-2 ring-transparent transition hover:ring-ac/40"
                  style={{ fontFamily: '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",inherit' }}
                >
                  {previewGlyph}
                  <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-s1 bg-s2 text-[9px] text-t2 transition group-hover:bg-s3" aria-hidden>
                    ✎
                  </span>
                </button>
                {pickerOpen ? (
                  <EmojiAvatarPicker
                    anchor={avatarBtnRef.current}
                    current={avatarDraft.trim()}
                    onPick={(emoji) => { setAvatarDraft(emoji); setPickerOpen(false); }}
                    onClear={() => { setAvatarDraft(""); setPickerOpen(false); }}
                    onClose={() => setPickerOpen(false)}
                  />
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <FInput
                  value={draft}
                  onChange={setDraft}
                  onSubmit={save}
                />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-t3">
              상단바에 표시됩니다. 비워두면 이메일 앞부분이 사용돼요.
            </p>
          </div>
          {error ? (
            <p className="text-[12px] font-bold text-red-500">{error}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-bd/10 px-5 py-3">
          <button type="button" onClick={props.onClose}
            className="rounded-xl border border-bd/12 bg-s2 px-4 py-1.5 text-xs font-bold text-t2 transition hover:bg-s3 hover:text-t1">
            취소
          </button>
          <button type="button" onClick={save} disabled={saving}
            className="rounded-xl border border-ac/40 bg-ac/15 px-4 py-1.5 text-xs font-bold text-ac transition hover:bg-ac/25 disabled:cursor-not-allowed disabled:opacity-60">
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
