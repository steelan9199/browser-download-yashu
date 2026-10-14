#!/usr/bin/env node
// push.js — 本技能自进化流程的落地点：门禁 → 提交 → 推送 → 打 tag
//
// 用法：
//   node push.js "<说明>"        正常自进化提交（门禁不过会拒绝推送）
//   node push.js --check         只跑门禁，不提交不推送
//   node push.js --force         门禁有红灯时强行提交（需显式给出，必须在汇报里说明原因）
//   node push.js --no-tag        提交推送但不打 tag（默认每次都打）
//
// 设计依据：references/自进化与维护.md §七 push / tag / 回滚纪律
//   1. 门禁前置：引用断链 / 负向声明 / 工具路径一致性 / 体量红线，任一红灯拒绝推送
//   2. 仓库根校验：C:/Users/... 与 D:/CToD/... 是同一目录的两个视图，必须 realpath 归一后比对
//   3. origin 校验：只允许推本技能自己的仓库
//   4. tag 是回滚的唯一落点，tag 名带 SKILL.md 的 version，便于 `git checkout <tag> -- .` 回滚
//
// 退出码：0 成功 · 1 失败 · 2 门禁红灯（未 --force） · 3 仓库校验失败

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname);

// 本技能唯一允许的远端
const EXPECTED_ORIGIN = "git@github.com:steelan9199/browser-download-yashu.git";

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const CHECK_ONLY = argv.includes("--check");
const NO_TAG = argv.includes("--no-tag");
const message =
  argv.filter((a) => !a.startsWith("--"))[0] || `Update: ${new Date().toLocaleString("zh-CN")}`;

function die(code, msg) {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(code);
}

// 本机坑（2026-10-07 四组对照实测定位）：**只有 spawnSync 这一个 API 不可用**。
// 现象：spawnSync 对 git / cmd / pwsh / 甚至「不存在的可执行文件」一律返回 EBUSY；
//   同一进程内 `await execFile(...)` 正常。
// 排除过的原因（都实测否掉了，不要再往这些方向猜）：
//   ✗ 不是 git 的问题     —— 不存在的可执行文件也报同样的 EBUSY
//   ✗ 不是 PATH / shell:true / cwd / 绝对路径问题 —— 全部试过，一律无效
//   ✗ 不是 WorkBuddy 沙箱 —— dangerouslyDisableSandbox=true 与独立 PowerShell 进程里同样失败
//   ✗ 不是某个 node 构建的 bug —— v22.13.1 与 v22.22.2 两个独立二进制表现完全一致
//   ✗ 不是 Windows 限制 git/pwsh/node —— 在 pwsh 里直接敲 git 完全正常
//   ✓ 结论：**本机 git / pwsh / node 全部正常，只有 spawnSync 这一个同步入口被拦**。
//     注意区分：你在 pwsh 里敲 git 是「PowerShell→git」，不经 node，所以正常；
//     这里是「node→spawnSync→git」，卡在 node 自己的同步 API 上。
// 对策：全部 git 调用改用异步 execFile，脚本即可自行驱动 git，无需手工兜底。

const SPAWN_BROKEN = Symbol("spawn-broken");

/** 异步版 runGit：成功返回 stdout，失败抛错。 */
function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "EBUSY" || err.code === "EAGAIN") return reject(SPAWN_BROKEN);
          return reject(new Error(stderr?.trim() || err.message || `git ${args.join(" ")} failed`));
        }
        resolve(stdout || "");
      });
  });
}

/** 异步 tag 查询：tag 不存在返回 false，不抛错。 */
function tagExists(tagName) {
  return new Promise((resolve) => {
    execFile("git", ["-C", SKILL_DIR, "rev-parse", "--verify", `refs/tags/${tagName}`],
      { encoding: "utf8", timeout: 20000 },
      (err) => resolve(!err));
  });
}

/** 读取 SKILL.md frontmatter 的 version，用作 tag 前缀 */
function readSkillVersion() {
  try {
    const txt = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf-8");
    const m = txt.match(/^version:\s*(\S+)/m);
    return m ? m[1] : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ── 闸 0：确认脚本操作的确实是本技能仓库（不是别人的） ────────────────
async function verifyRepo() {
  const top = (await runGit(["-C", SKILL_DIR, "rev-parse", "--show-toplevel"])).trim();
  // ⚠️ 同一目录有 C:/Users/... 与 D:/CToD/... 两个视图，必须 realpath 归一后比
  const realTop = fs.realpathSync(top);
  const realSkill = fs.realpathSync(SKILL_DIR);
  const norm = (p) => process.platform === "win32" ? p.toLowerCase() : p;
  if (norm(realTop) !== norm(realSkill)) {
    die(3, `仓库根校验失败：\n  skill_dir  realpath = ${realSkill}\n  git toplevel realpath = ${realTop}\n  两者不是同一目录，拒绝操作。`);
  }
  const origin = (await runGit(["-C", SKILL_DIR, "remote", "get-url", "origin"])).trim();
  if (origin !== EXPECTED_ORIGIN) {
    die(3, `origin 校验失败：\n  期望 ${EXPECTED_ORIGIN}\n  实际 ${origin}\n  拒绝推送到非本技能仓库。`);
  }
  return { top: realTop, origin };
}

// ── 闸 1：自进化门禁（异步执行 node 自身；spawnSync 在本机不可用）──
function runAudit() {
  const script = path.join(SKILL_DIR, "scripts", "skill_audit.js");
  if (!fs.existsSync(script)) {
    console.log("\x1b[33m门禁脚本不存在，跳过（scripts/skill_audit.js）\x1b[0m");
    return Promise.resolve(0);
  }
  console.log("\x1b[36mRunning self-evolution gate (skill_audit.js)...\x1b[0m");
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { stdio: "inherit" }, (err) => resolve(err ? 1 : 0));
  });
}

/** tag 名：v<SKILL.md version>-<时间戳>，便于按版本回滚 */
async function generateTagName(version) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const base = `v${version}-${stamp}`;
  let name = base;
  let i = 1;
  while (await tagExists(name)) name = `${base}-${i++}`;
  return name;
}

async function createAndPushTag(version) {
  const tagName = await generateTagName(version);
  const tagMessage = `v${version} @ ${new Date().toLocaleString("zh-CN")}`;
  console.log(`\x1b[36mCreating tag: ${tagName}...\x1b[0m`);
  await runGit(["-C", SKILL_DIR, "tag", "-a", tagName, "-m", tagMessage]);
  await runGit(["-C", SKILL_DIR, "push", "origin", tagName]);
  console.log(`\x1b[32m✔ tag ${tagName} 已推送（回滚落点）\x1b[0m`);
  console.log(`\x1b[90m  回滚代码：git -C "${SKILL_DIR}" checkout ${tagName} -- .\x1b[0m`);
  return tagName;
}

/**
 * 主流程（全异步）。
 * git 调用全部经由 runGit → execFile。**不要改回 spawnSync**：
 * 本机 spawnSync 一律返回 EBUSY（对任何命令都失败），异步 execFile 正常。
 */
async function main() {
  // `--check` 只跑门禁，不碰 git
  if (CHECK_ONLY) {
    const code = await runAudit();
    console.log(code === 0 ? "\x1b[36m--check：门禁通过。\x1b[0m" : "\x1b[36m--check：门禁有红灯。\x1b[0m");
    process.exit(code);
  }

  // 阶段 0：闸门与仓库校验
  const repo = await verifyRepo();
  console.log(`\x1b[36m仓库：${SKILL_DIR}\x1b[0m`);
  console.log(`\x1b[90morigin：${repo.origin}\x1b[0m`);

  const auditCode = await runAudit();
  if (auditCode !== 0) {
    if (!FORCE) {
      die(2, `门禁未通过（退出码 ${auditCode}），已拒绝提交推送。\n  修完再推；确实需要强推用：node push.js --force "<说明>"`);
    }
    console.log("\x1b[33m⚠ --force：门禁有红灯仍继续提交。必须在汇报里说明原因。\x1b[0m");
  }

  // 阶段 2：提交推送
  const version = readSkillVersion();
  const status = await runGit(["-C", SKILL_DIR, "status", "--porcelain"]);
  if (!status.trim()) {
    console.log("\x1b[32m无改动，无需提交。\x1b[0m");
    process.exit(0);
  }
  await runGit(["-C", SKILL_DIR, "add", "-A"]);
  await runGit(["-C", SKILL_DIR, "commit", "-m", message]);
  await runGit(["-C", SKILL_DIR, "push"]);
  console.log("\x1b[32m✔ 已提交并推送。\x1b[0m");

  // 阶段 3：打回滚 tag
  if (NO_TAG) {
    console.log("\x1b[90m--no-tag：本次未打 tag。\x1b[0m");
  } else {
    await createAndPushTag(version);
  }
}

main().catch((e) => {
  if (e === SPAWN_BROKEN) {
    console.error(
      "\x1b[33m⚠ 连异步 execFile 也返回 EBUSY —— 本机进程创建被全面阻断。\x1b[0m\n" +
        "  请在 PowerShell 里手工执行：git add -A / git commit / git push",
    );
    process.exit(4);
  }
  die(1, `push 失败：${e.message}`);
});
