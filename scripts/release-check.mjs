import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = { ...process.env };

// npm exposes user config to lifecycle scripts as npm_config_* variables, then
// rejects allow-scripts when a nested command interprets it as project-scoped.
// Keep the user's install policy for the outer lifecycle and remove only that
// incompatible inherited representation from the verification subprocesses.
delete environment.npm_config_allow_scripts;
delete environment.NPM_CONFIG_ALLOW_SCRIPTS;

const checks = [
  ["run", "typecheck"],
  ["test"],
  ["run", "build"],
  ["audit", "--omit=dev", "--audit-level=moderate"],
  ["pack", "--dry-run"]
];

for (const args of checks) {
  const result = spawnSync(npmCommand, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
