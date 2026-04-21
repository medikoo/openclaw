"use strict";

const log = require("log"),
  path = require("path"),
  spawn = require("child-process-ext/spawn");

const cwd = path.dirname(__dirname);

const runCommand = async (name, args) => {
  log.notice(name, args.join(" "));
  return spawn(name, args, {
    stdio: "inherit",
    cwd,
  });
};

module.exports = async (tagName) => {
  await runCommand("git", ["fetch", "upstream", "main"]);
  await runCommand("git", ["fetch", "upstream", "--tags"]);
  await runCommand("git", ["checkout", tagName]);
  await runCommand("git", ["rebase", "hacks"]);

  const latestSha = (
    await spawn("git", ["rev-parse", "HEAD"], {
      cwd,
    })
  ).stdoutBuffer
    .toString()
    .trim();

  await runCommand("git", ["checkout", "hacks"]);
  await runCommand("git", ["reset", "--hard", latestSha]);
  await runCommand("git", ["tag", `${tagName}-hacks`]);
  await runCommand("git", ["push", "--force"]);
  await runCommand("git", ["push", "--tags"]);

  await runCommand("pnpm", ["install"]);
  await runCommand("pnpm", ["ui:build"]);
  await runCommand("pnpm", ["build"]);
};
