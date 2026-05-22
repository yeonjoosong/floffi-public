// passwordStrength — client-side mirror of the server policy in
// internal/server/auth/password_strength.go. The server is the
// source of truth (a stale client can't bypass it), but mirroring
// the rules here lets us show the user a precise reason before
// any round-trip.

export const MIN_PASSWORD_LEN = 10;
export const MIN_CHAR_CLASSES = 2;
export const MAX_CONSECUTIVE_REPEAT = 4;
export const MIN_IDENTIFIER_LEN = 5;

const COMMON_WEAK = new Set([
  "password", "password1", "password12",
  "qwerty", "qwerty123", "qwertyuiop",
  "1234567890", "abcdefghij",
  "letmein", "welcome",
  "admin", "administrator",
  "changeme", "iloveyou",
  "floffi", "admin12345",
]);

export type PasswordIssue =
  | "too_short"
  | "needs_more_classes"
  | "too_repetitive"
  | "common_password"
  | "contains_identifier";

export function checkPasswordStrength(
  password: string,
  username = "",
  email = "",
): PasswordIssue | null {
  if (password.length < MIN_PASSWORD_LEN) return "too_short";

  // Character class detection mirrors Go's unicode.IsLower/Upper/Digit.
  // "Symbol" is the catch-all for anything that isn't a letter or digit
  // (whitespace doesn't count toward any class).
  let lower = false, upper = false, digit = false, symbol = false;
  let lastChar = "";
  let runLen = 0;
  for (let i = 0; i < password.length; i++) {
    const ch = password[i];
    if (/[a-zß-öø-ÿ]/.test(ch) || (ch >= "a" && ch <= "z")) lower = true;
    else if (/[A-ZÀ-ÖØ-Þ]/.test(ch) || (ch >= "A" && ch <= "Z")) upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else if (ch !== " " && ch !== "\t") symbol = true;
    // Non-Latin letters (e.g. Korean) also land in "symbol" via this
    // branch, which matches the Go side's default-case bucket — they
    // legitimately add entropy.

    if (i > 0 && ch === lastChar) {
      runLen++;
      if (runLen >= MAX_CONSECUTIVE_REPEAT) return "too_repetitive";
    } else {
      runLen = 1;
    }
    lastChar = ch;
  }

  const classes = (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) + (symbol ? 1 : 0);
  if (classes < MIN_CHAR_CLASSES) return "needs_more_classes";

  const lc = password.toLowerCase();
  if (COMMON_WEAK.has(lc)) return "common_password";

  if (username.length >= MIN_IDENTIFIER_LEN && lc.includes(username.toLowerCase())) {
    return "contains_identifier";
  }
  if (email) {
    const at = email.indexOf("@");
    const local = (at > 0 ? email.slice(0, at) : email).toLowerCase();
    if (local.length >= MIN_IDENTIFIER_LEN && lc.includes(local)) {
      return "contains_identifier";
    }
  }
  return null;
}

// gradePasswordStrength — coarse UX score on top of checkPasswordStrength.
// The policy gate already decides pass/fail; this just maps the user's
// input to a 4-level meter so they get a "stronger" signal as they keep
// adding entropy past the minimum bar.
//
// Levels:
//   0 약함        — doesn't satisfy the policy yet (has a PasswordIssue)
//   1 보통        — passes the policy but only barely (short + 2 classes)
//   2 강함        — passes + 12자 이상 with 3 classes, or 14자+ with 2
//   3 매우 강함   — passes + 16자 이상 with 3+ classes, or 12자+ with all 4
//
// Returns null for empty input so the caller can hide the meter entirely.
export type PasswordGrade = {
  level: 0 | 1 | 2 | 3;
  label: string;
};

export function gradePasswordStrength(
  password: string,
  username = "",
  email = "",
): PasswordGrade | null {
  if (password.length === 0) return null;

  if (checkPasswordStrength(password, username, email) !== null) {
    return { level: 0, label: "약함" };
  }

  // Count character classes the same way the gate does.
  let lower = false, upper = false, digit = false, symbol = false;
  for (let i = 0; i < password.length; i++) {
    const ch = password[i];
    if (/[a-zß-öø-ÿ]/.test(ch) || (ch >= "a" && ch <= "z")) lower = true;
    else if (/[A-ZÀ-ÖØ-Þ]/.test(ch) || (ch >= "A" && ch <= "Z")) upper = true;
    else if (ch >= "0" && ch <= "9") digit = true;
    else if (ch !== " " && ch !== "\t") symbol = true;
  }
  const classes = (lower ? 1 : 0) + (upper ? 1 : 0) + (digit ? 1 : 0) + (symbol ? 1 : 0);
  const len = password.length;

  if ((len >= 16 && classes >= 3) || (len >= 12 && classes >= 4)) {
    return { level: 3, label: "매우 강함" };
  }
  if ((len >= 12 && classes >= 3) || (len >= 14 && classes >= 2)) {
    return { level: 2, label: "강함" };
  }
  return { level: 1, label: "보통" };
}

// Human-readable Korean message for each issue. Used by SignupView /
// ResetPasswordView so the error banner says what's wrong, not just
// "weak password."
export function describePasswordIssue(issue: PasswordIssue): string {
  switch (issue) {
    case "too_short":
      return `비밀번호는 최소 ${MIN_PASSWORD_LEN}자 이상이어야 해요.`;
    case "needs_more_classes":
      return "영문 대/소문자, 숫자, 기호 중 두 가지 이상을 섞어주세요.";
    case "too_repetitive":
      return `같은 문자가 ${MAX_CONSECUTIVE_REPEAT}번 이상 연속될 수 없어요.`;
    case "common_password":
      return "너무 흔한 비밀번호예요. 다른 조합을 사용해주세요.";
    case "contains_identifier":
      return "비밀번호에 아이디나 이메일 일부를 포함할 수 없어요.";
  }
}
