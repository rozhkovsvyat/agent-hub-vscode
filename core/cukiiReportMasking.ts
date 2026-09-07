/**
 * Best-effort secret and personal-data masking for Cukii issue reports.
 *
 * This is the dependency-free Portal 5 feedback sanitizer, kept in core so
 * both the webview DOM capture and the extension-host diagnostics pass through
 * exactly the same boundary before anything is persisted or uploaded.
 */
type MaskRule = { re: RegExp; replace: string };

const SECRET_RULES: MaskRule[] = [
  {
    // Structured logs most often serialize credentials as JSON. Keep the
    // quotes and key for diagnostics, but redact the value before it reaches
    // either the durable outbox or an upload body.
    re: /((?:["']?)(?:password|token|api[_-]?key|secret)(?:["']?)\s*[=:]\s*)(["']?)([^"'\s&,;}]+)\2/gi,
    replace: "$1$2[REDACTED]$2",
  },
  {
    re: /\b(password|token|api[_-]?key|secret)\b(\s*[=:]\s*)("?)([^\s"'&,;]+)\3/gi,
    replace: "$1$2[REDACTED]",
  },
  {
    re: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+):[^\s:/@]+@/g,
    replace: "$1:[REDACTED]@",
  },
  {
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
    replace: "Bearer [REDACTED]",
  },
  {
    re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replace: "[REDACTED]",
  },
  { re: /\bsk-[A-Za-z0-9]{8,}/g, replace: "[REDACTED]" },
  { re: /\bghp_[A-Za-z0-9]{8,}/g, replace: "[REDACTED]" },
  { re: /\bglpat-[A-Za-z0-9_-]{8,}/g, replace: "[REDACTED]" },
  { re: /\bxoxb-[A-Za-z0-9-]{8,}/g, replace: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{12,}/g, replace: "[REDACTED]" },
  {
    re: /-----BEGIN[\s\S]*?-----END[^-]*-----/g,
    replace: "[REDACTED]",
  },
  { re: /-----BEGIN [^-]+-----/g, replace: "[REDACTED]" },
];

const PERSONAL_DATA_RULES: MaskRule[] = [
  {
    re: /(\\*"(?:lastName|firstName|middleName|secondName|patronym|patronymic|surname|shortName|displayName|assigneeName|authorName|employeeName|reporterName|creatorName|ownerName|senderName|watcherName|managerName|customerName|responsibleName|commentAuthor|editorName|givenName|given_name|familyName|family_name|[A-Za-z]*[Ff]ullName)\\*"\s*:\s*)(\\*")[^"\\]{0,120}\2/gi,
    replace: "$1$2[NAME]$2",
  },
  {
    re: /(\\*"name\\*"\s*:\s*)(\\*")(?:[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}|[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.?)\2/g,
    replace: "$1$2[NAME]$2",
  },
  { re: /\b\d{3}-\d{3}-\d{3}\s\d{2}\b/g, replace: "[SNILS]" },
  {
    re: /(?:\+7|\b8)[\s\-(]*\d{3}[\s\-)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g,
    replace: "[PHONE]",
  },
  {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: "[EMAIL]",
  },
  {
    re: /(\\*"(?:telegram|telegramLink|telegramUsername|tg|messenger)\\*"\s*:\s*)(\\*")[^"\\]{0,80}\2/gi,
    replace: "$1$2[TELEGRAM]$2",
  },
  { re: /https?:\/\/t\.me\/[A-Za-z0-9_]+/gi, replace: "[TELEGRAM]" },
  // Paths routinely expose the OS account name even when the surrounding log
  // has no e-mail or structured identity field.
  { re: /\b([A-Za-z]:\\Users\\)[^\\\s]+/gi, replace: "$1[USER]" },
  { re: /\/(?:Users|home)\/[^/\s]+/g, replace: "/Users/[USER]" },
];

export function maskCukiiReportText(input: string): string {
  let output = input;
  for (const rule of SECRET_RULES)
    output = output.replace(rule.re, rule.replace);
  for (const rule of PERSONAL_DATA_RULES) {
    output = output.replace(rule.re, rule.replace);
  }
  return output;
}
