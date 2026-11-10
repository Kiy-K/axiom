// Best-effort scrubbing of text that leaves the harness: audit entries, permission prompts, job diagnostics.

/** Names whose environment value is a credential. `AUTH` and `SESSION` are left out: they match ordinary names. */
const SENSITIVE_ENV_NAME =
	/(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|COOKIE)(?:_|$)|(?:KEY|TOKEN|SECRET|PASSWORD)$/i;
/** Shorter values are too likely to be ordinary words, and replacing them would mangle output. */
const MIN_ENV_SECRET_LENGTH = 8;

/**
 * Credential shapes. A pattern with a capture group keeps that group (a variable name, a URL user) and redacts the
 * rest of the match. Name parts are bounded so a long run of letters cannot make matching quadratic.
 */
const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
	/\bnpm_[A-Za-z0-9]{30,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	// Headers: the whole value, whatever scheme it uses (Bearer, Basic, token, a cookie).
	/(\b(?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*:\s*)[^\r\n"']+/gi,
	// user:password@host in URLs; the password may itself contain @ or /.
	/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s]+(?=@)/gi,
	// curl -u user:password, curl --user user:password, curl -uuser:password
	/(\bcurl\b[^\n|;&]{0,200}?\s(?:-u\s*|--user[=\s]))[^\s:]+:\S+/g,
	// --token abc, --password=abc, --api-key abc; whole words only, so --max-tokens is left alone.
	/(--(?:[a-z0-9]{1,20}-){0,3}(?:token|password|passwd|secret|api-?key)(?:-[a-z0-9]{1,20}){0,2}(?:=|\s+))[^\s-]\S*/gi,
	// NAME=value, NAME: value and "name": "value" where the name has a credential word (any case, snake or camel).
	// A bare `key` is not enough: it is too common (sort --key, primaryKey).
	/\b((?:[A-Za-z0-9]{1,20}[_-]){0,3}(?:[A-Za-z0-9]{0,20})(?:api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd|credentials?)(?:[_-][A-Za-z0-9]{1,20}){0,3}["']?\s*[=:]\s*)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;}\])]+)/gi,
	// UPPER_SNAKE names that end in _KEY, such as SSH_KEY or DEPLOY_KEY_FILE.
	/\b((?:[A-Z0-9]{1,20}_){1,4}KEY(?:_[A-Z0-9]{1,20}){0,2}["']?\s*[=:]\s*)(?!\[REDACTED\])(?:"[^"\n]*"|'[^'\n]*'|[^\s"',;}\])]+)/g,
];

const REDACTED = "[REDACTED]";

/** Escape sequences (CSI, OSC, DCS and two-byte forms) first, then any remaining C0/C1 control except tab, newline and carriage return. */
const ESCAPE_SEQUENCE =
	/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARACTER = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Characters that change how text looks without showing: zero-width, bidirectional override and isolate, line and
 * paragraph separators, byte order mark and tag characters. Legitimate in program output (emoji joiners, right to
 * left text), so only text a person must trust at a glance is stripped of them.
 */
const INVISIBLE_CHARACTER = /[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** Remove terminal control sequences so text cannot move the cursor, retitle the window or hide itself. */
export function stripControlSequences(text: string): string {
	return text.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTER, "");
}

/**
 * Replace known credential shapes and the values of sensitive-looking environment variables. Defense in
 * depth only: it cannot find secrets it has no pattern for, and it does not prevent access to them.
 */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
	let result = text;
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || value.length < MIN_ENV_SECRET_LENGTH || !SENSITIVE_ENV_NAME.test(name)) continue;
		result = result.split(value).join(REDACTED);
	}
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, (_match, prefix: unknown) =>
			typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return result;
}

/**
 * Text a person approves at a prompt: control sequences and invisible characters removed, whitespace collapsed to one
 * line, length bounded. Not redacted: redaction replaces spans, and a replaced span of a command can hide the code
 * the person is being asked to allow.
 */
export function sanitizeForPrompt(text: string, maxLength: number): string {
	const clean = stripControlSequences(text.slice(0, maxLength * 2))
		.replace(INVISIBLE_CHARACTER, "")
		.replace(/\s+/g, " ")
		.trim();
	if (clean.length <= maxLength && text.length <= maxLength * 2) return clean;
	const shown = Math.min(clean.length, maxLength);
	return `${clean.slice(0, shown)}... [truncated ${text.length - shown} chars]`;
}

/**
 * Control sequences and invisible characters stripped, secrets redacted and length bounded: safe to show in a prompt
 * or write to a log. Only the first `2 * maxLength` characters are scanned, so cost does not grow with the input.
 */
export function sanitizeForDisplay(text: string, maxLength: number, env: NodeJS.ProcessEnv = process.env): string {
	// Strip controls before redacting so an escape sequence inside a token cannot hide it from the patterns.
	const clean = redactSecrets(
		stripControlSequences(text.slice(0, maxLength * 2)).replace(INVISIBLE_CHARACTER, ""),
		env,
	);
	if (clean.length <= maxLength && text.length <= maxLength * 2) return clean;
	const shown = Math.min(clean.length, maxLength);
	return `${clean.slice(0, shown)}... [truncated ${text.length - shown} chars]`;
}
