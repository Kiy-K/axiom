import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyShellCommand } from "../src/core/permissions/shell.ts";
import { isReadonlyShell } from "../src/core/permissions/shell-grammar.ts";

// P6 S3, `readonly-shell`. Expectations come from the contract's grammar section, not from the implementation.
describe("readonly-shell grammar", () => {
	let root: string;
	let outside: string;
	const env = { PATH: "/usr/bin:/bin" };
	const allowed = (line: string, environment: NodeJS.ProcessEnv = env) => isReadonlyShell(line, root, environment);

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grammar-"));
		outside = mkdtempSync(join(tmpdir(), "grammar-outside-"));
		mkdirSync(join(root, "sub"));
		mkdirSync(join(root, ".git"));
		for (const name of ["a.txt", "b.txt", "sub/c.txt", ".env", ".git/config"]) writeFileSync(join(root, name), "x\n");
		writeFileSync(join(outside, "o.txt"), "x\n");
		symlinkSync(join(outside, "o.txt"), join(root, "link-out"));
		symlinkSync(join(root, ".env"), join(root, "link-env"));
		symlinkSync(join(root, "a.txt"), join(root, "link-in"));
		execFileSync("mkfifo", [join(root, "fifo")]);
		// A link to an outside directory, a same-named decoy in the workspace, and a second name for an outside file.
		mkdirSync(join(outside, "d"));
		writeFileSync(join(outside, "README.md"), "outside\n");
		writeFileSync(join(root, "README.md"), "decoy\n");
		symlinkSync(join(outside, "d"), join(root, "lnkdir"));
		linkSync(join(outside, "o.txt"), join(root, "hard.txt"));
		// Names the checker reads differently from the shell: a leading `@`, and a file named like a flag value.
		symlinkSync(join(outside, "o.txt"), join(root, "@a.txt"));
		symlinkSync(join(outside, "o.txt"), join(root, "5"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("allows the table's commands, flags and chains", () => {
		for (const line of [
			"pwd",
			"ls",
			"ls -aF",
			"ls -a -t sub",
			"ls -1 a.txt sub",
			"wc -l a.txt",
			"head a.txt",
			"head -n 5 a.txt",
			"tail -c 10 sub/c.txt link-in",
			"ls | wc -l",
			"ls | head -n 3",
			"pwd && ls || ls ; wc a.txt",
			"  ls \t -a  ",
		])
			expect(allowed(line), line).toBe(true);
	});

	it("asks for everything outside the grammar", () => {
		for (const line of [
			"",
			" ",
			"cat a.txt",
			"git status",
			"git diff",
			"ls -l",
			"ls -R",
			"tail -f a.txt",
			"tail -F a.txt",
			"tail --follow a.txt",
			"tail -n5 a.txt", // glued value
			"tail -5 a.txt",
			"tail +5 a.txt",
			"head -n x a.txt",
			"head -n a.txt", // no numeric value
			"head -n 5 -- a.txt",
			"head -- a.txt",
			"head -",
			"head a.txt -",
			"head", // stdin hang
			"wc -l && head a.txt", // `&&` is not a pipe: stdin is the terminal
			"tail -n 3",
			"ls;ls", // separator glued to a word
			"ls &",
			"ls &&",
			"&& ls",
			"ls | | wc -l",
			"ls > f",
			"ls >f",
			"ls 2>&1",
			"ls < a.txt",
			"ls $HOME",
			"ls ~",
			"ls `pwd`",
			"ls $(pwd)",
			'ls "a b"',
			"ls 'a'",
			"ls *",
			"ls a.t?t",
			"ls {a.txt,b.txt}",
			"ls [a]*",
			"ls\na.txt",
			"ls\ra.txt",
			"ls\u00a0a.txt", // no-break space
			"ls\u2003a.txt",
			"FOO=bar ls",
			"export PATH=/tmp:$PATH",
			"=ls",
			"./ls",
			"/bin/ls",
			"/tmp/x/ls",
			"ls ../outside",
			"ls /etc",
			"pwd a.txt",
			"pwd -P",
			"find . -exec sh -c x \\;",
			"rg --pre=sh x",
			"sed -i s/a/b/ a.txt",
			"echo hi",
			"ls | sh",
			"ls | xargs rm",
		])
			expect(allowed(line), JSON.stringify(line)).toBe(false);
	});

	it("checks file arguments on the real filesystem", () => {
		for (const line of [
			"ls link-out", // symlink to an outside file
			"head link-out",
			"ls link-env", // symlink to credentials
			"head .env",
			"ls .env",
			"head .git/config", // protected: can hold a token in a remote URL
			"ls .git",
			"head fifo", // a FIFO would hang head
			"wc -c fifo",
			"head sub", // a directory
			"wc -l sub",
			"head missing.txt",
			"ls ../",
			`ls ${outside}`,
			`head ${join(outside, "o.txt")}`,
		])
			expect(allowed(line), line).toBe(false);
		// The shell follows a link before it applies `..`; classifyPath folds `..` first, so any `..` word asks.
		for (const line of [
			"ls lnkdir/..",
			"head lnkdir/../README.md",
			"wc -c lnkdir/../README.md",
			"ls sub/..",
			"head sub/../a.txt",
			"ls ..",
		])
			expect(allowed(line), line).toBe(false);
		expect(allowed("head ./a.txt")).toBe(true);
		// normalizePath strips a leading `@` and a `file:` prefix before classifyPath resolves; the shell does not.
		for (const line of [
			"head @a.txt",
			"ls @a.txt",
			`head file://${join(root, "a.txt")}`,
			"ls file:x",
			"head a.txt:b",
		])
			expect(allowed(line), line).toBe(false);
		// A flag after a file: POSIXLY_CORRECT and BSD head read `-n 5` as the files `-n` and `5` (here a link outside).
		for (const line of ["head a.txt -n 5", "tail a.txt -c 3", "wc a.txt -l", "head -n 5 a.txt -c 2"])
			expect(allowed(line), line).toBe(false);
		expect(allowed("head -n 5 a.txt")).toBe(true);
		expect(allowed("head hard.txt")).toBe(false); // a second name for an outside file
		// Every file argument of every command in a chain is checked, not only the first.
		expect(allowed("ls a.txt && ls .env")).toBe(false);
		expect(allowed("head a.txt | wc -l && head link-out")).toBe(false);
		// ls only prints names, so it accepts a directory and a path that does not exist (it just errors).
		expect(allowed("ls sub missing.txt")).toBe(true);
	});

	it("is off when PATH could let a workspace file stand in for the command", () => {
		for (const path of ["", "/usr/bin::/bin", ".", "bin", `/usr/bin:${root}`, `${join(root, "sub")}:/bin`, ":/bin"])
			expect(allowed("ls", { PATH: path }), JSON.stringify(path)).toBe(false);
		expect(allowed("ls", {})).toBe(false);
		expect(allowed("ls", { Path: "/usr/bin" })).toBe(false); // only the exact key `PATH` counts
		expect(allowed("ls", { path: "/usr/bin", PATH: `.:/usr/bin` })).toBe(false);
	});

	it("is off when the environment changes how bash runs an allowed command", () => {
		expect(allowed("ls", { PATH: "/usr/bin" })).toBe(true);
		for (const key of ["BASH_ENV", "ENV", "POSIXLY_CORRECT", "BASH_FUNC_ls%%"])
			expect(allowed("ls", { PATH: "/usr/bin", [key]: "x" }), key).toBe(false);
	});

	// An oracle written separately from the implementation: canonical lines are generated from the spec, then some are
	// corrupted with a token the spec rejects. `allow` must hold iff the line still matches the spec's regex.
	it("allows exactly the lines an independent grammar regex describes", () => {
		const FILE = "(?:a\\.txt|b\\.txt|sub/c\\.txt)";
		const lsSeg = `ls(?: -[aA1FtSr]+| ${FILE}| sub)*`;
		const filesSeg = (name: string, flags: string, files: "+" | "*") => `${name}(?: ${flags})*(?: ${FILE})${files}`;
		const strict = [
			"pwd",
			lsSeg,
			filesSeg("wc", "-[lwcm]+", "+"),
			filesSeg("head", "-[nc] [0-9]+", "+"),
			filesSeg("tail", "-[nc] [0-9]+", "+"),
		].join("|");
		const piped = [
			"pwd",
			lsSeg,
			filesSeg("wc", "-[lwcm]+", "*"),
			filesSeg("head", "-[nc] [0-9]+", "*"),
			filesSeg("tail", "-[nc] [0-9]+", "*"),
		].join("|");
		const oracle = new RegExp(`^(?:${strict})(?: (?:&&|\\|\\||;) (?:${strict})| \\| (?:${piped}))*$`);

		let seed = 7;
		const random = (n: number) => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed % n;
		};
		const pick = <T>(items: T[]) => items[random(items.length)];
		const files = ["a.txt", "b.txt", "sub/c.txt"];
		const segment = (): string => {
			switch (random(5)) {
				case 0:
					return "pwd";
				case 1:
					return [
						"ls",
						...(random(2) ? [pick(["-a", "-A", "-1tr", "-S"])] : []),
						...(random(2) ? [pick(files)] : []),
					].join(" ");
				case 2:
					return [
						"wc",
						...(random(2) ? [pick(["-l", "-wc", "-m"])] : []),
						...(random(4) ? [pick(files)] : []),
					].join(" ");
				default:
					return [
						pick(["head", "tail"]),
						...(random(2) ? [pick(["-n", "-c"]), String(random(100))] : []),
						...(random(4) ? [pick(files)] : []),
					].join(" ");
			}
		};
		const junk = [
			"$x",
			">",
			"-n5",
			"--",
			"-",
			"'a'",
			"*",
			"~",
			"-R",
			"+3",
			"=a",
			"&",
			"ls;ls",
			"-f",
			"../a.txt",
			".env",
		];
		let accepted = 0;
		for (let i = 0; i < 600; i++) {
			const parts = [segment()];
			for (let n = random(4); n > 0; n--) parts.push(pick(["&&", "||", ";", "|"]), segment());
			const words = parts.join(" ").split(" ");
			if (random(2)) words.splice(random(words.length + 1), 0, pick(junk));
			const line = words.join(" ");
			const expected = oracle.test(line);
			expect(allowed(line), line).toBe(expected);
			if (expected) {
				accepted++;
				// Whatever the grammar allows, the lexical classifier names no risk in it.
				expect(
					classifyShellCommand(line).filter((risk) => risk !== "opaque"),
					line,
				).toEqual([]);
			}
		}
		expect(accepted).toBeGreaterThan(100);
	});
});
