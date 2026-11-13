// Hard classes for `auto`: actions no grant, edit trust or rule may relax. Only "Allow once" from a user can let one run.
// Lexical and best effort, like shell.ts: a shell is opaque, so this names what it can see and the rest asks anyway.

import { basename } from "node:path";
import { classifyPath } from "./paths.ts";
import { parseCommands } from "./shell.ts";
import type { Action, ActionVerdict, ResolvedPath, ShellRisk } from "./types.ts";

/** Words that run the command after them, so `timeout 5 crontab -e` is `crontab`. */
const WRAPPERS = new Set([
	"env",
	"command",
	"exec",
	"nohup",
	"time",
	"nice",
	"xargs",
	"builtin",
	"setsid",
	"timeout",
	"eval",
	"stdbuf",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** Subcommands that change who may do what, or the credentials in use. */
const AUTH_SUBCOMMANDS: Record<string, string[]> = {
	gh: ["auth", "ssh-key", "gpg-key", "secret", "variable"],
	glab: ["auth", "ssh-key"],
	aws: ["iam", "sts", "configure", "sso"],
	gcloud: ["auth", "iam", "config"],
	az: ["login", "role", "ad"],
	docker: ["login"],
	npm: ["login", "adduser", "token"],
	git: ["credential"],
};
const AUTH_COMMANDS = new Set([
	"ssh-keygen",
	"ssh-add",
	"passwd",
	"chpasswd",
	"usermod",
	"useradd",
	"visudo",
	"setfacl",
]);
const MESSAGE_COMMANDS = new Set(["mail", "mailx", "mutt", "msmtp", "swaks", "telegram-send"]);
const PERSISTENCE_COMMANDS = new Set(["crontab", "at", "batch", "launchctl", "chkconfig", "update-rc.d"]);
const SYSTEMCTL_PERSISTENT = new Set(["enable", "start", "restart", "mask", "link", "edit", "daemon-reload"]);
/** `git config` forms that only read. Any other form can name a program git later runs (`core.fsmonitor`, `diff.external`). */
const GIT_CONFIG_READ_FLAGS = new Set([
	"--get",
	"--get-all",
	"--get-regexp",
	"--list",
	"-l",
	"--show-origin",
	"--show-scope",
]);

/** Paths that make something run later, or let someone in: shell startup files, scheduled jobs, service units, keys. */
const PERSISTENT_PATH =
	/(?:^|\/)(?:\.bashrc|\.bash_profile|\.bash_login|\.bash_logout|\.profile|\.zshrc|\.zprofile|\.zshenv|\.zlogin|\.xinitrc|\.xprofile|authorized_keys|crontab)$|^\/etc\/|^\/var\/spool\/cron|\/Library\/Launch(?:Agents|Daemons)\/|\/\.config\/systemd\/|\/\.config\/autostart\//;

/** Commands whose arguments name files they change: which arguments. */
const WRITE_COMMANDS: Record<string, "all" | "last" | "after-first" | "tee"> = {
	mv: "all",
	touch: "all",
	mkdir: "all",
	truncate: "all",
	tee: "tee",
	cp: "last",
	install: "last",
	ln: "last",
	chmod: "after-first",
	chown: "after-first",
	chgrp: "after-first",
};

const RISK_NAMES: Partial<Record<ShellRisk, string>> = {
	network: "network",
	publish: "publish or deploy",
	destructive: "destructive change",
	secrets: "secrets",
	elevation: "privilege escalation",
};

/** Words of the simple commands in `command` that run something, each starting at the command word. Looks inside `sh -c`. */
function commandLines(command: string, depth = 0): string[][] {
	const lines: string[][] = [];
	for (const words of parseCommands(command)) {
		let i = 0;
		while (
			i < words.length &&
			(/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) ||
				WRAPPERS.has(basename(words[i])) ||
				words[i].startsWith("-") ||
				/^[\d.]+[smhd]?$/.test(words[i]))
		)
			i++;
		const line = words.slice(i);
		if (line.length === 0) continue;
		lines.push(line);
		const flag = line.findIndex((word, at) => at > 0 && /^-[a-z]*c$/.test(word));
		if (SHELLS.has(basename(line[0])) && flag !== -1 && line[flag + 1] !== undefined && depth < 3)
			lines.push(...commandLines(line[flag + 1], depth + 1));
	}
	return lines;
}

/** A class `auto` never relaxes that the lexical shell classifier does not name, or undefined. */
export function autoShellClass(command: string): string | undefined {
	for (const line of commandLines(command)) {
		const name = basename(line[0]);
		const subs = line.slice(1, 8).filter((word) => !word.startsWith("-"));
		if (AUTH_COMMANDS.has(name) || AUTH_SUBCOMMANDS[name]?.includes(subs[0] ?? ""))
			return "auth or permission change";
		if (
			name === "git" &&
			line.slice(1, 8).includes("config") &&
			!line.some((word) => GIT_CONFIG_READ_FLAGS.has(word))
		)
			return "git configuration (it can name programs git runs)";
		if (MESSAGE_COMMANDS.has(name)) return "external message";
		if (PERSISTENCE_COMMANDS.has(name) || (name === "systemctl" && SYSTEMCTL_PERSISTENT.has(subs[0] ?? "")))
			return "persistence";
	}
	return undefined;
}

/** What a shell line writes, as far as a lexical read can tell: write actions, and why any target is unknown. */
export function derivedWrites(command: string, cwd: string): { writes: Action[]; undetermined: string[] } {
	const writes: Action[] = [];
	const undetermined: string[] = [];
	const lines = commandLines(command);
	// After a directory change, a relative target is relative to somewhere this read does not know.
	const changesDirectory = lines.some((line) => ["cd", "pushd", "popd"].includes(line[0]));
	const target = (word: string): void => {
		if (word === "/dev/null" || word.startsWith("&")) return;
		const relative = !word.startsWith("/") && !word.startsWith("~");
		if (/[$`*?[{]/.test(word) || (changesDirectory && relative)) {
			undetermined.push(`write target ${JSON.stringify(word)} cannot be determined`);
			return;
		}
		const path = classifyPath(word, cwd);
		if (path === undefined) undetermined.push(`write target ${JSON.stringify(word)} cannot be resolved`);
		else writes.push({ kind: "write", path });
	};

	for (const line of lines) {
		// Redirections: `> f`, `>>f`, `2> f`, `&>f`. A bare `2>` before `&1` has no target and is skipped.
		line.forEach((word, at) => {
			const match = /^\d*(?:>>?\|?|<>)(.*)$/.exec(word);
			if (!match) return;
			const named = match[1] !== "" ? match[1] : line[at + 1];
			if (named !== undefined) target(named);
		});

		const name = basename(line[0]);
		const operands = line.slice(1).filter((word) => !word.startsWith("-") && !/^\d*>/.test(word));
		const kind = WRITE_COMMANDS[name];
		if (kind === "all" || kind === "tee") {
			for (const word of operands) target(word);
		} else if (kind === "last") {
			const dir = line.indexOf("-t");
			const dest = dir !== -1 ? line[dir + 1] : operands[operands.length - 1];
			if (dest !== undefined) target(dest);
		} else if (kind === "after-first") {
			for (const word of operands.slice(1)) target(word);
		} else if (name === "sed" && line.some((word) => /^-[a-zA-Z]*i/.test(word) || word === "--in-place")) {
			// With -e or -f the script is not a positional, otherwise the first positional is the script.
			const scriptGiven = line.some((word) => /^-[a-zA-Z]*[ef]/.test(word) || word === "--expression");
			for (const word of scriptGiven ? operands : operands.slice(1)) target(word);
		} else if (name === "dd") {
			for (const word of line) if (word.startsWith("of=")) target(word.slice(3));
		}
	}
	return { writes, undetermined };
}

function persistent(path: ResolvedPath): boolean {
	return PERSISTENT_PATH.test(path.real);
}

/** The hard class of `action`, or undefined when it is not one. */
export function hardClass(action: Action): string | undefined {
	switch (action.kind) {
		case "read":
			return action.path.secret ? "credentials" : undefined;
		case "write":
			if (action.path.secret) return "credentials";
			if (action.path.runsCode) return "a file that runs code or chooses what runs";
			return persistent(action.path) ? "persistence" : undefined;
		case "exec": {
			// The more specific name first: `aws iam` is an auth change before it is a publish.
			const specific = autoShellClass(action.command);
			if (specific !== undefined) return specific;
			for (const risk of action.risks) {
				const name = RISK_NAMES[risk];
				if (name !== undefined) return name;
			}
			return undefined;
		}
		case "undetermined":
			return "write target not determined";
		case "extension":
		case "unsupported":
			return undefined;
	}
}

/** Write actions and undetermined targets that the exec actions among `actions` imply. Only `auto` adds them. */
export function impliedActions(actions: Action[], cwd: string): Action[] {
	const implied: Action[] = [];
	for (const action of actions) {
		if (action.kind !== "exec") continue;
		const { writes, undetermined } = derivedWrites(action.command, cwd);
		implied.push(...writes, ...undetermined.map((reason): Action => ({ kind: "undetermined", reason })));
	}
	return implied;
}

/**
 * The verdict `auto` gives an action. A deny stays a deny. A hard class asks and is never covered by a grant, so only
 * an answer from the user lets it run. A shell command offers no grant at all, hard class or not.
 */
export function autoVerdict(action: Action, base: ActionVerdict): ActionVerdict {
	if (base.decision === "deny") return base;
	const hard = hardClass(action);
	if (hard !== undefined) return { decision: "ask", reason: `${hard}; ${base.reason}` };
	if (action.kind === "exec") return { decision: base.decision, reason: base.reason };
	return base;
}
