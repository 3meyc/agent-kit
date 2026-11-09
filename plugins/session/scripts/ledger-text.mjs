/**
 * Pure text helpers for the session ledger (testable).
 *
 * Records no longer quote the conversation — a clipped prompt or closing message describes one
 * minute of a session and misleads about the rest — so the path-relativizing and markdown-safety
 * helpers that once guarded those quotes are gone with them. What remains is the one-line clip
 * used for the decision pairs the hook still captures verbatim, and the secret scanner.
 */

/** @param {string} value @param {number} max */
export function clip(value, max) {
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A record's title from the first sentence of a prose body (an Intent, a recap), trimmed to index
 * width; undefined for an empty body. A leading bullet is dropped so a one-item list still names
 * the session.
 * @param {string} body
 */
export function sentenceTitle(body) {
  const flat = String(body ?? "")
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return undefined;
  const sentence = flat.match(/^(.+?[.;])\s/)?.[1] ?? flat;
  return clip(sentence.replace(/[.;]$/, ""), 70);
}

/**
 * What a transcript text block says, or "" when it is not conversation. Injected context (CLAUDE.md,
 * memory, git status) arrives in system reminders and is cut. The desktop app wraps pasted text as
 * `<pasted_content id="…">…</pasted_content id="…">`; that is the prompt itself, so it is unwrapped,
 * since a session opened by a pasted brief would otherwise have no prompt and get no record. Any
 * other block that opens with a tag (`<command-name>`, `<task-notification>`) is tool chatter.
 * @param {string} text
 */
export function conversationText(text) {
  const cut = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (cut.startsWith("<") && !/^<pasted_content[\s>]/.test(cut)) return "";
  return cut.replace(/<\/?pasted_content\b[^>]*>/g, "").trim();
}

export const REDACTED = "[redacted]";

/**
 * Records are committed and pushed, and the summarizer writes them from the raw transcript — which
 * is exactly where a pasted key would come from. Token shapes are matched outright; a bare word
 * like "token" only counts with an assignment and a long value, so "token savings" never matches.
 * Order matters: `sk-ant-` must win over the generic `sk-` shape.
 * @type {[kind: string, pattern: RegExp][]}
 */
const SECRET_PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{32,}/g],
  ["github-token", /\bghp_[A-Za-z0-9]{30,}/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g],
];

// The value is redacted and the key kept, so the record still says what was there. A value that is
// already the marker is skipped, or every rewrite would find the previous redaction again.
const ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|token)(\s*[:=]\s*)(?!["'`]?\[redacted\])\S{8,}/gi;

/**
 * @param {string} text
 * @returns {{ kind: string, match: string }[]}
 */
export function findSecrets(text) {
  const found = [];
  let rest = String(text);
  for (const [kind, pattern] of SECRET_PATTERNS) {
    for (const match of rest.matchAll(pattern)) found.push({ kind, match: match[0] });
    // Blank what matched so a later, looser shape does not report the same secret twice.
    rest = rest.replace(pattern, REDACTED);
  }
  for (const match of rest.matchAll(ASSIGNMENT)) found.push({ kind: "assignment", match: match[0] });
  return found;
}

/** @param {string} text */
export function redactSecrets(text) {
  let out = String(text);
  for (const [, pattern] of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out.replace(ASSIGNMENT, `$1$2${REDACTED}`);
}
