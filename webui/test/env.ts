// Pin git's global and system configuration for every test process. The bridge
// spawns git with the inherited environment, so this file is what keeps a
// developer's ~/.gitconfig (autocrlf, signing, hooks, default branch) out of the
// fixtures.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-webui-git-env-"));
const globalConfig = join(dir, "gitconfig");
writeFileSync(
  globalConfig,
  ["[init]", "\tdefaultBranch = main", "[core]", "\tautocrlf = false", "[commit]", "\tgpgsign = false", ""].join("\n"),
);
const systemConfig = join(dir, "gitconfig-system");
writeFileSync(systemConfig, "");

process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_SYSTEM = systemConfig;
process.env.GIT_AUTHOR_NAME = "Test";
process.env.GIT_AUTHOR_EMAIL = "test@example.com";
process.env.GIT_COMMITTER_NAME = "Test";
process.env.GIT_COMMITTER_EMAIL = "test@example.com";