// Lexical risk classification of shell commands. A shell is opaque: this finds common dangerous shapes so a prompt can
// name them and so they are never covered by a grant. It is not a security boundary; variable expansion, eval and
// scripts defeat it. Commands that match nothing are still asked about in `manual` mode.

import { basename } from "node:path";
import { looksLikeSecretPath } from "./paths.ts";
import type { ShellRisk } from "./types.ts";

const NETWORK_COMMANDS = new Set([
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"socat",
	"ssh",
	"scp",
	"sftp",
	"rsync",
	"ftp",
	"telnet",
	"nslookup",
	"dig",
	"sendmail",
]);
const PRIVILEGE_COMMANDS = new Set(["sudo", "su", "doas", "pkexec", "setcap", "chroot"]);
const ALWAYS_DESTRUCTIVE_COMMANDS = new Set(["rm", "rmdir", "shred", "mkfs", "wipefs", "dd", "truncate"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "eval", "source", "."]);

/**
 * `printenv`, or a bare `env`/`export`/`declare`/`set` at the start of a command: all list environment variables.
 * Whitespace after the separator is horizontal only: a newline is a separator itself, and `\s*` made long runs of
 * them quadratic.
 */
const ENVIRONMENT_DUMP = /(?:^|[;&|(`\n]|\$\()[ \t]*(?:printenv\b|(?:env|export|declare|set)\s*(?:$|[|;&)`<>\n]|-p\b))/;

/** Tools whose listed subcommands send something out or change shared state. */
const PUBLISH_SUBCOMMANDS: Record<string, string[]> = {
	git: ["push"],
	npm: ["publish", "unpublish", "deprecate", "dist-tag", "access", "owner"],
	pnpm: ["publish"],
	yarn: ["publish", "npm"],
	bun: ["publish"],
	cargo: ["publish", "yank"],
	docker: ["push"],
	podman: ["push"],
	twine: ["upload"],
	gem: ["push"],
	gh: ["release", "pr", "issue", "repo", "workflow", "api", "gist"],
	glab: ["mr", "issue", "release", "api"],
	kubectl: ["apply", "delete", "create", "patch", "replace", "scale", "rollout", "exec"],
	helm: ["install", "upgrade", "uninstall", "rollback"],
	terraform: ["apply", "destroy"],
	pulumi: ["up", "destroy"],
	aws: ["s3", "ec2", "iam", "lambda", "cloudformation"],
	gcloud: ["deploy", "compute", "iam"],
	vercel: ["deploy"],
	netlify: ["deploy"],
	fly: ["deploy"],
	flyctl: ["deploy"],
	wrangler: ["deploy", "publish"],
};

/** Subcommands that reach the network without publishing. */
const NETWORK_SUBCOMMANDS: Record<string, string[]> = {
	git: ["clone", "fetch", "pull", "ls-remote", "remote"],
	npm: ["install", "i", "ci", "add", "update", "view", "info", "exec", "x"],
	pnpm: ["install", "i", "add", "update", "dlx"],
	yarn: ["install", "add", "upgrade"],
	bun: ["install", "i", "add", "update", "x"],
	pip: ["install", "download"],
	pip3: ["install", "download"],
	uv: ["pip", "add", "sync"],
	cargo: ["install", "fetch", "update"],
	go: ["get", "install"],
	gem: ["install"],
	apt: ["install", "update", "upgrade"],
	"apt-get": ["install", "update", "upgrade"],
	dnf: ["install", "update", "upgrade"],
	brew: ["install", "update", "upgrade"],
	docker: ["pull", "run", "build"],
};

/**
 * Words of `command` with quotes and backslashes removed, so `r"m" -rf` reads as `rm -rf`, split at whitespace and
 * shell operators. Substitutions `$(...)` and backticks split into words too, so their contents are inspected.
 */
function tokenize(command: string): string[] {
	return command
		.replace(/["'\\]/g, "")
		.split(/[\s;&|()`<>{}]+/)
		.filter((token) => token.length > 0);
}

/** Git options that take the next word as their value. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** How far after a command name its subcommand is looked for. */
const SUBCOMMAND_WINDOW = 24;

/**
 * The words after `index` that are not options, in order. For git an option's value is skipped too, so the first
 * is its subcommand. Other tools take option values we cannot tell apart (`kubectl -n prod delete`), so callers
 * look at the first few.
 */
function positionalWords(tokens: string[], index: number): string[] {
	const isGit = basename(tokens[index]) === "git";
	const words: string[] = [];
	for (let i = index + 1; i < Math.min(tokens.length, index + SUBCOMMAND_WINDOW); i++) {
		if (isGit && GIT_OPTIONS_WITH_VALUE.has(tokens[i])) i++;
		else if (!tokens[i].startsWith("-")) words.push(tokens[i]);
	}
	return words;
}

function nextSubcommand(tokens: string[], index: number): string | undefined {
	return positionalWords(tokens, index)[0];
}

/** True when one of the first words after `index` is in `subcommands` (only the first for git). */
function hasSubcommand(tokens: string[], index: number, subcommands: string[] | undefined): boolean {
	if (subcommands === undefined) return false;
	const words = positionalWords(tokens, index).slice(0, basename(tokens[index]) === "git" ? 1 : 3);
	return words.some((word) => subcommands.includes(word));
}

/** Commands that run the command that follows them, so `env sudo id` is still `sudo`. */
const WRAPPER_COMMANDS = new Set([
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
]);

/** Shell syntax words that precede a command: `if true; then sudo id; fi`, `! sudo id`, `{ sudo id; }`. */
const KEYWORDS = new Set(["!", "if", "then", "else", "elif", "do", "while", "until"]);

/** The words of each simple command in `command`. Quotes group a word and are removed; operators end a command. */
function parseCommands(command: string): string[][] {
	const commands: string[][] = [[]];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const endWord = () => {
		if (inWord) commands[commands.length - 1].push(word);
		word = "";
		inWord = false;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else word += char;
		} else if (char === "'" || char === '"') {
			quote = char;
			inWord = true;
		} else if (char === "\\") {
			word += command[++i] ?? "";
			inWord = true;
		} else if (";&|()`\n{}".includes(char)) {
			endWord();
			if (commands[commands.length - 1].length > 0) commands.push([]);
		} else if (/\s/.test(char)) {
			endWord();
		} else {
			word += char;
			inWord = true;
		}
	}
	endWord();
	return commands;
}

/** True when `sudo` and its kind are run: first word of a command, after a keyword or wrapper, or as a `-c` script. */
function runsPrivilegeCommand(command: string): boolean {
	return parseCommands(command).some((words) => {
		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			// Assignments, options and durations (`timeout 5`) before the command word.
			if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word.startsWith("-") || /^[\d.]+[smhd]?$/.test(word)) continue;
			const name = basename(word);
			// `command -v sudo` looks the command up; it does not run it.
			if (name === "command" && /^-[vV]$/.test(words[i + 1] ?? "")) return false;
			if (WRAPPER_COMMANDS.has(name) || KEYWORDS.has(name)) continue;
			if (SHELL_INTERPRETERS.has(name)) {
				// `bash --login -c "sudo id"`: the script is a command line of its own.
				const flag = words.findIndex((other, at) => at > i && /^-[a-z]*c$/.test(other));
				return flag !== -1 && words[flag + 1] !== undefined && runsPrivilegeCommand(words[flag + 1]);
			}
			return PRIVILEGE_COMMANDS.has(name);
		}
		return false;
	});
}

function hasArgument(tokens: string[], index: number, pattern: RegExp): boolean {
	return tokens.slice(index + 1, index + 8).some((token) => pattern.test(token));
}

function isDestructive(name: string, tokens: string[], index: number): boolean {
	if (ALWAYS_DESTRUCTIVE_COMMANDS.has(name)) return true;
	switch (name) {
		case "git": {
			const sub = nextSubcommand(tokens, index);
			if (sub === "reset") return hasArgument(tokens, index, /^--hard$/);
			if (sub === "clean") return true;
			if (sub === "checkout" || sub === "restore") return hasArgument(tokens, index, /^(\.|--force|-f)$/);
			if (sub === "branch") return hasArgument(tokens, index, /^-[a-zA-Z]*D$|^--delete$/);
			if (sub === "stash") return hasArgument(tokens, index, /^(drop|clear)$/);
			if (sub === "push") return hasArgument(tokens, index, /^(--force|--force-with-lease|-f|--delete|-d)$|^\+/);
			return false;
		}
		case "chmod":
		case "chown":
		case "chgrp":
			return hasArgument(tokens, index, /^-[a-zA-Z]*R$|^--recursive$/);
		case "find":
			return hasArgument(tokens, index, /^(-delete|-exec|-execdir)$/);
		default:
			return false;
	}
}

/** Risks `command` appears to carry. Empty when it matches nothing known. */
export function classifyShellCommand(command: string): ShellRisk[] {
	const risks = new Set<ShellRisk>();
	if (command.includes("/dev/tcp/") || command.includes("/dev/udp/")) risks.add("network");
	if (ENVIRONMENT_DUMP.test(command)) risks.add("secrets");
	if (runsPrivilegeCommand(command)) risks.add("privilege");
	// The word elsewhere (`find -exec sudo ...`, `command -v sudo`) may or may not run it: ask, offer no grant.
	else if (parseCommands(command).some((words) => words.some((word) => PRIVILEGE_COMMANDS.has(basename(word)))))
		risks.add("elevation");

	const tokens = tokenize(command);
	tokens.forEach((token, index) => {
		const name = basename(token);
		if (NETWORK_COMMANDS.has(name)) risks.add("network");
		if (isDestructive(name, tokens, index)) risks.add("destructive");
		if (SHELL_INTERPRETERS.has(name)) risks.add("opaque");
		if (looksLikeSecretPath(token) || /^\/proc\/[^/]+\/environ$/.test(token)) risks.add("secrets");

		if (hasSubcommand(tokens, index, PUBLISH_SUBCOMMANDS[name])) risks.add("publish");
		if (hasSubcommand(tokens, index, NETWORK_SUBCOMMANDS[name])) risks.add("network");
	});
	return [...risks];
}
