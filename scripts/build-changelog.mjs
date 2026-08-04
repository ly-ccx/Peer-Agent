import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const notesDir = path.join(root, "release-notes");
const outputPath = path.join(root, "docs", "changelog.html");
const dataPattern = /(\s*var ENTRIES = )\[[\s\S]*?\];\n(\s*var ui = )/;
const localeMarker = /^(?:<!--\s*)?locale:(zh-CN|en-US)(?:\s*-->)?$/;

const sectionKeys = {
  zh: [
    ["说明", "note"], ["概览", "note"], ["新功能", "added"], ["能力", "added"],
    ["优化", "improved"], ["体验", "improved"], ["修复", "fixed"],
    ["变更", "changed"], ["安装", "release"], ["发布", "release"],
    ["通道", "release"], ["已知", "known"], ["致谢", "other"],
  ],
  en: [
    ["overview", "note"], ["note", "note"], ["what's new", "added"], ["feature", "added"],
    ["capability", "added"], ["improvement", "improved"], ["fix", "fixed"],
    ["reliability", "fixed"], ["change", "changed"], ["install", "release"],
    ["release", "release"], ["channel", "release"], ["known", "known"], ["thank", "other"],
  ],
};

function classify(title, lang) {
  const normalized = title.toLowerCase();
  return sectionKeys[lang].find(([needle]) => normalized.includes(needle))?.[1] ?? "other";
}

function parseLocale(markdown, marker, lang) {
  const markerPattern = new RegExp(`^(?:<!--\\s*)?locale:${marker}(?:\\s*-->)?\\s*$`, "m");
  const match = markerPattern.exec(markdown);
  if (!match) return [];
  const rest = markdown.slice(match.index + match[0].length);
  const nextLocale = rest.search(/^(?:<!--\s*)?locale:(?:zh-CN|en-US)(?:\s*-->)?\s*$/m);
  const body = nextLocale < 0 ? rest : rest.slice(0, nextLocale);
  const sections = [];
  let section = null;
  let subsection = "";
  let item = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "---" || localeMarker.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      section = { key: classify(heading[1], lang), title: heading[1], items: [] };
      sections.push(section);
      subsection = "";
      item = null;
      continue;
    }
    const subheading = line.match(/^###\s+(.+)$/);
    if (subheading) {
      subsection = subheading[1];
      item = null;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && section) {
      item = `${subsection ? `**${subsection}** — ` : ""}${bullet[1]}`;
      section.items.push(item);
      continue;
    }
    if (item && section) {
      section.items[section.items.length - 1] += ` ${line}`;
      item = section.items[section.items.length - 1];
    }
  }
  return sections.filter((candidate) => candidate.items.length > 0);
}

function parseVersion(filename) {
  const label = filename.slice(1, -3);
  const match = label.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Unsupported release note filename: ${filename}`);
  const prerelease = match[4] ?? "";
  const beta = prerelease.match(/^beta\.(\d+)$/);
  return {
    version: `v${label}`,
    label,
    n: beta ? Number(beta[1]) : 0,
    sort: [Number(match[1]), Number(match[2]), Number(match[3]), prerelease ? 0 : 1, beta ? Number(beta[1]) : 0, prerelease],
  };
}

function compareVersions(a, b) {
  for (let index = 0; index < 5; index += 1) {
    if (a.sort[index] !== b.sort[index]) return b.sort[index] - a.sort[index];
  }
  return String(b.sort[5]).localeCompare(String(a.sort[5]), "en", { numeric: true });
}

async function buildEntries() {
  const files = (await readdir(notesDir)).filter((name) => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.md$/.test(name));
  const entries = await Promise.all(files.map(async (filename) => {
    const metadata = parseVersion(filename);
    const markdown = await readFile(path.join(notesDir, filename), "utf8");
    const zh = parseLocale(markdown, "zh-CN", "zh");
    const en = parseLocale(markdown, "en-US", "en");
    if (!zh.length || !en.length) throw new Error(`${filename} must contain non-empty zh-CN and en-US sections`);
    return { ...metadata, zh, en };
  }));
  entries.sort(compareVersions);
  return entries.map(({ sort: _sort, ...entry }) => entry);
}

const entries = await buildEntries();
const html = await readFile(outputPath, "utf8");
if (!dataPattern.test(html)) throw new Error("Could not locate the ENTRIES data block in docs/changelog.html");
const generated = html.replace(dataPattern, `$1${JSON.stringify(entries)};\n$2`);

if (process.argv.includes("--check")) {
  if (generated !== html) {
    console.error("docs/changelog.html is stale; run pnpm build:changelog");
    process.exitCode = 1;
  } else {
    console.log(`changelog is current (${entries.length} releases)`);
  }
} else {
  await writeFile(outputPath, generated);
  console.log(`generated docs/changelog.html from ${entries.length} release notes`);
}
