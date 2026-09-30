#!/usr/bin/env node
// 把本机维护副本（~/.pi/agent/extensions/<name>/）同步成本仓库里的扩展目录。
//
//   node sync.mjs          # 同步（默认）
//   node sync.mjs --check  # 只报差异，有漂移时退出码 1
//
// 排除项：tsconfig.json（本机绝对路径）、node_modules/、*.tgz、.npmrc、.git。
// 本仓库是「发布镜像」，维护副本永远是 ~/.pi/agent/extensions/ 下的那两个目录（pi 直接加载那里）。

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS = ["doubao-search", "video-read"];
const SOURCE_ROOT = process.env.PI_EXTENSIONS_DIR?.trim() || join(homedir(), ".pi", "agent", "extensions");

const EXCLUDED_FILES = new Set(["tsconfig.json", ".npmrc", ".DS_Store"]);
const EXCLUDED_DIRS = new Set(["node_modules", ".git"]);
const EXCLUDED_SUFFIXES = [".tgz", ".log"];

const checkOnly = process.argv.includes("--check");

async function listFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...(await listFiles(root, rel)));
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      if (EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

const hashOf = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

async function mapFiles(root) {
  const map = new Map();
  for (const rel of await listFiles(root)) map.set(rel, await hashOf(join(root, rel)));
  return map;
}

const toPosix = (rel) => rel.split("\\").join("/");

let drift = 0;
let copied = 0;
const summary = [];

for (const name of EXTENSIONS) {
  const from = join(SOURCE_ROOT, name);
  const to = join(REPO_DIR, name);
  if (!existsSync(from)) {
    console.error(`✖ 找不到维护副本：${from}`);
    process.exitCode = 1;
    continue;
  }

  const source = await mapFiles(from);
  const dest = existsSync(to) ? await mapFiles(to) : new Map();

  const added = [...source.keys()].filter((rel) => !dest.has(rel));
  const changed = [...source.keys()].filter((rel) => dest.has(rel) && dest.get(rel) !== source.get(rel));
  const removed = [...dest.keys()].filter((rel) => !source.has(rel));
  // 只在仓库侧额外存在的文件（.gitignore 等）不该被删，这里仅删除两个扩展目录内部的多余文件
  const total = added.length + changed.length + removed.length;

  if (checkOnly) {
    if (total > 0) {
      drift += total;
      console.log(`⚠ ${name}: 新增 ${added.length} / 变更 ${changed.length} / 仓库多余 ${removed.length}`);
      for (const rel of [...added, ...changed, ...removed].slice(0, 20)) console.log(`    ${toPosix(rel)}`);
    } else {
      console.log(`✔ ${name}: 与维护副本一致（${source.size} 个文件）`);
    }
    continue;
  }

  for (const rel of [...added, ...changed]) {
    const target = join(to, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(from, rel)));
    copied++;
  }
  for (const rel of removed) await rm(join(to, rel));
  summary.push(`${name}: 复制 ${added.length + changed.length} 个 / 删除 ${removed.length} 个 / 共 ${source.size} 个文件`);
}

if (checkOnly) {
  if (drift > 0) {
    console.log(`\n有漂移：${drift} 处。运行 node sync.mjs 同步。`);
    process.exitCode = 1;
  } else {
    console.log("\n无漂移。");
  }
} else {
  for (const line of summary) console.log(line);
  console.log(`\n同步完成，共写入 ${copied} 个文件。下一步：git add <显式路径> && git commit`);
}
