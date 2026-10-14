#!/usr/bin/env node
// skill_audit.js — 自进化门禁 / 上下文成本审计器（browser-download-yashu）
//
// 为什么存在：本技能是「活文档」，每次自进化都要往 references/ 里加知识、删错误。
// 如果没有测量，加知识就没有上限，文档很快膨胀到读不动、检索不到、命中率崩掉。
// 本脚本把《references/自进化与维护.md》里的规则变成四道可执行的闸：
//
//   1. 引用断链       —— SKILL.md / references 里提到的文件是否真实存在
//   2. 负向声明       —— 全库有无「已废弃 / 勿再使用 / 已推翻 / 曾要求」类痕迹
//   3. 工具路径一致性 —— 全库出现的工具路径必须命中权威前缀表
//   4. 体量红线       —— 所有 markdown 文档（SKILL.md 与每篇 references/*.md）是否超线
//
// 用法：
//   node scripts/skill_audit.js            摘要（默认）
//   node scripts/skill_audit.js --top      附体量 TOP 8 与断链明细
//   node scripts/skill_audit.js --json     机器可读
//   node scripts/skill_audit.js --save     记一条历史，作为下次对比基准
//
// 退出码：0 全过 · 1 有红灯（push.js 会据此拒绝推送）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(__dirname, "..");

// ── 红线（与《自进化与维护.md》§九 必须同步改）────────────────────────
// 所有文档统一 10000 字符红线（SKILL.md 与 references/*.md 同限）。
// 超了就拆分，不上调阈值——见《自进化与维护.md》§九 体量红线。
const BUDGET = {
  docChars: 10000, // SKILL.md 与每篇 references/*.md 的字符数上限
};

// 「整篇读」阈值：超过此值，SKILL.md 路由表应标注「先 Grep 局部读」。
// 必须小于 docChars，否则永远不会触发。
const GREP_FIRST_CHARS = 8000;

// ── 闸 3 的权威路径表（与 SKILL.md「环境前提」的本机固定事实必须同步改）──
// 每条：key 命中的行若含盘符路径，则必须同时命中 must，否则红灯。
// 这是本技能最贵的一类错误——路径散落在文档与各脚本里，一处改了别处没改
// ⇒ 静默用错工具或直接跑不起来，报错还常指向别处。
const TOOL_PATH_RULES = [
  { name: "yt-dlp", key: /yt-dlp/i, must: /D:[\\/]software[\\/]yt-dlp_win[\\/]/i },
  { name: "ffmpeg", key: /(ffmpeg|ffprobe)(\.exe)?/i, must: /ffmpeg-2024-09-26-git-f43916e217-full_build[\\/]bin/i },
  { name: "Edge", key: /msedge(\.exe)?/i, must: /Microsoft[\\/]Edge[\\/]Application/i },
  { name: "node", key: /node/i, must: /\.workbuddy[\\/]binaries[\\/]node[\\/]/i },
  { name: "pwsh", key: /pwsh(\.exe)?/i, must: /D:[\\/]software[\\/]PowerShell[\\/]7[\\/]/i },
];
// 行内是否出现 Windows 盘符路径（反斜杠或正斜杠均可）。
// ⚠️ 必须排除 URL 里的 `https://` —— 其中的 `s:/` 会被误认成盘符路径（实测误报过）。
const DRIVE_PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:(?![\\/]{2})[\\/]/;

// ── 负向声明词表（《自进化与维护.md》§三）──────────────────────────────
// 本文件必须引述这些词形才能说明禁令 ⇒ 自身豁免
const NEGATIVE_WORDS = ["已废弃", "勿再使用", "已推翻", "曾要求", "已失效", "不再支持"];
const NEGATIVE_EXEMPT = new Set(["自进化与维护.md", "skill_audit.js"]);

const HISTORY_FILE = path.join(__dirname, ".skill-audit-history.jsonl");

function readText(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

// 扫整个技能目录，不只 references/ 与 scripts/——否则根目录下的文件会成为盲区。
function allFiles() {
  const SKIP_DIRS = new Set([
    ".git", "node_modules", "__pycache__", "_backup", "_edgeprofile",
    "bili_download", "douyin_download", "_download", "_probe", "media",
  ]);
  const exts = /\.(md|ps1|mjs|js)$/;
  const files = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (exts.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(SKILL_DIR);
  return files.filter((f) => fs.existsSync(f));
}

const rel = (p) => path.relative(SKILL_DIR, p).split(path.sep).join("/");

// ── 闸 1：引用断链 ──────────────────────────────────────────────────
// 只认技能内相对路径 references/... 与 scripts/...（含中文文件名）。
const REF_RE = /(?:references|scripts)\/[A-Za-z0-9_\u4e00-\u9fff\-/]+\.(?:md|ps1|mjs|js)/g;

function checkBrokenRefs(files) {
  const broken = new Map();
  for (const d of files) {
    if (!d.endsWith(".md")) continue;
    for (const m of readText(d).matchAll(REF_RE)) {
      const target = m[0];
      if (!fs.existsSync(path.join(SKILL_DIR, target))) {
        if (!broken.has(target)) broken.set(target, new Set());
        broken.get(target).add(rel(d));
      }
    }
  }
  return broken;
}

// ── 闸 2：负向声明 ──────────────────────────────────────────────────
function checkNegative(files) {
  const hits = [];
  for (const d of files) {
    if (NEGATIVE_EXEMPT.has(path.basename(d))) continue;
    readText(d)
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const w of NEGATIVE_WORDS) {
          if (line.includes(w)) {
            hits.push({ file: rel(d), line: i + 1, word: w, text: line.trim().slice(0, 70) });
          }
        }
      });
  }
  return hits;
}

// ── 闸 3：工具路径一致性 ────────────────────────────────────────────
// 逐行判断：行里既有工具关键词、又有盘符路径 ⇒ 该路径必须命中权威前缀，否则红灯。
// 这样既抓得住「路径写错」，又不会把普通示例路径（如 D:\ws\输出.mp4）误报。
function checkToolPaths(files) {
  const bad = [];
  for (const d of files) {
    // 本文件自身豁免：上面的规则表必须逐字写出正确路径才能比对。
    if (path.basename(d) === "skill_audit.js") continue;
    readText(d)
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (!DRIVE_PATH_RE.test(line)) return;
        for (const rule of TOOL_PATH_RULES) {
          if (rule.key.test(line) && !rule.must.test(line)) {
            bad.push({
              file: rel(d), line: i + 1, tool: rule.name,
              text: line.trim().slice(0, 90),
            });
          }
        }
      });
  }
  return bad;
}

// ── 闸 4：体量红线 ──────────────────────────────────────────────────
function checkSize(files) {
  const red = [];
  const rows = [];
  for (const d of files) {
    const text = readText(d);
    const r = rel(d);
    rows.push({ file: r, chars: text.length });

    // 所有 markdown 文档都受体量红线约束（含 SKILL.md、references/*.md，
    // 以及任何被 SKILL.md 引用的根目录 .md）——避免「放个大文件在根目录」成为盲区。
    const isDoc = r.endsWith(".md");
    if (isDoc && text.length > BUDGET.docChars) {
      red.push({
        what: r,
        detail: `${text.length} > ${BUDGET.docChars}字符 ⇒ 拆分，不要上调阈值`,
      });
    }
  }
  return { red, rows };
}

function main() {
  const argv = process.argv.slice(2);
  const files = allFiles();
  const red = [];

  const broken = checkBrokenRefs(files);
  if (broken.size) red.push("引用断链");

  const neg = checkNegative(files);
  if (neg.length) red.push("负向声明");

  const badPath = checkToolPaths(files);
  if (badPath.length) red.push("工具路径一致性");

  const { red: sizeRed, rows } = checkSize(files);
  red.push(...sizeRed.map((r) => r.what));

  const skillChars = rows.find((r) => r.file === "SKILL.md")?.chars ?? 0;

  console.log("\x1b[36m══ skill_audit：自进化门禁 ══\x1b[0m");
  console.log(`技能目录：${SKILL_DIR}`);
  console.log(
    `\n体量红线：每篇文档 ≤ ${BUDGET.docChars} 字符（超了拆分）` +
      `  ·  SKILL.md 现 ${skillChars}` +
      (argv.includes("--top") ? "\n单篇文档：" : ""),
  );
  for (const r of rows.filter((x) => x.file.startsWith("references/") && x.file.endsWith(".md"))) {
    const mark = r.chars > GREP_FIRST_CHARS ? "  ⚠️ 建议标注「先 Grep 局部读」" : "";
    console.log(`  ${String(r.chars).padStart(6)} 字符  ${r.file}${mark}`);
  }

  console.log(`\n[引用断链] ${broken.size ? `❌ ${broken.size} 处` : "✅ 无"}`);
  for (const [target, srcs] of broken) {
    console.log(`  ❌ ${[...srcs].join(", ")} 引用了不存在的 ${target}`);
  }

  console.log(`[负向声明] ${neg.length ? `❌ ${neg.length} 处` : "✅ 全库无痕迹"}`);
  for (const h of neg.slice(0, 15)) console.log(`  ❌ ${h.file}:${h.line}  [${h.word}] ${h.text}`);

  console.log(`[工具路径一致性] ${badPath.length ? `❌ ${badPath.length} 处` : "✅ 全部命中权威路径"}`);
  for (const h of badPath.slice(0, 15)) {
    console.log(`  ❌ ${h.file}:${h.line}  [${h.tool}] ${h.text}`);
  }

  console.log(`[体量红线] ${sizeRed.length ? `❌ ${sizeRed.length} 处` : "✅ 全部达标"}`);
  for (const r of sizeRed) console.log(`  ❌ ${r.what}  ${r.detail}`);

  if (argv.includes("--top")) {
    console.log("\n体量 TOP 8：");
    for (const r of [...rows].sort((a, b) => b.chars - a.chars).slice(0, 8)) {
      console.log(`  ${String(r.chars).padStart(6)}  ${r.file}`);
    }
  }

  if (argv.includes("--save")) {
    fs.appendFileSync(
      HISTORY_FILE,
      JSON.stringify({ ts: new Date().toISOString(), skillChars, docs: rows.length, red: red.length }) + "\n",
    );
    console.log(`\n已记历史 → scripts/${path.basename(HISTORY_FILE)}`);
  }

  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { ok: red.length === 0, red, broken: [...broken.keys()], negative: neg, badPath, sizeRed },
        null,
        2,
      ),
    );
  }

  if (red.length) {
    console.log(`\n\x1b[31m🚫 ${red.length} 项红灯，先修再提交（node push.js 会拒绝推送）\x1b[0m`);
    process.exit(1);
  }
  console.log("\n\x1b[32m✅ 全绿\x1b[0m");
  process.exit(0);
}

main();
