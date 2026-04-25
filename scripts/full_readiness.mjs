import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = process.cwd();
const botRoot = path.join(repoRoot, "optimized-jupiter-bot");
const npmCmd = process.platform === "win32" ? "npm" : "npm";

function toPlatformPath(inputPath) {
  if (process.platform !== "win32") return inputPath;
  const match = inputPath.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (!match) return inputPath;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

const steps = [
  { label: "Build public site", cmd: npmCmd, args: ["run", "build"], cwd: repoRoot },
  { label: "Check public endpoints", cmd: npmCmd, args: ["run", "monitor:public"], cwd: repoRoot },
  { label: "Compile trading stack", cmd: npmCmd, args: ["run", "compile:runtime"], cwd: botRoot },
  { label: "Run trading tests", cmd: npmCmd, args: ["test"], cwd: botRoot },
  { label: "Run smoke test", cmd: npmCmd, args: ["run", "sniper:smoke"], cwd: botRoot },
];

for (const step of steps) {
  console.log(`\n=== ${step.label} ===`);
  const win32 = process.platform === "win32";
  const result = win32
    ? spawnSync(
        "cmd.exe",
        ["/d", "/s", "/c", [step.cmd, ...step.args].join(" ")],
        {
          cwd: toPlatformPath(step.cwd),
          stdio: "inherit",
          shell: false,
        },
      )
    : spawnSync(step.cmd, step.args, {
        cwd: step.cwd,
        stdio: "inherit",
        shell: false,
      });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nPocketChange full readiness checks passed.");
