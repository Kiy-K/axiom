import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Under `bun run`, npm_execpath names Bun, not npm, so fall back to the npm that ships beside node.
function npmCliPath() {
	const fromEnv = process.env.npm_execpath;
	if (fromEnv && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) return fromEnv;
	return join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	const npmCli = npmCliPath();
	if (!existsSync(npmCli)) throw new Error(`Cannot locate the npm CLI: ${npmCli}`);
	return execFileSync(process.execPath, [npmCli, ...args], options);
}
