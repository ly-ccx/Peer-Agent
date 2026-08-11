import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const notesDir = path.join(root, "release-notes");
const docsDir = path.join(root, "docs");
const outputPath = path.join(docsDir, "changelog.html");
const dataDir = path.join(docsDir, "changelog-data");
const manifestPath = path.join(dataDir, "manifest.json");
const embeddedDataPattern = /\n\s*var ENTRIES = \[[\s\S]*?\];\n/;
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
  let subsection = null;
  let itemTarget = null;
  let itemIndex = -1;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "---" || localeMarker.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      section = { key: classify(heading[1], lang), title: heading[1], items: [], subsections: [] };
      sections.push(section);
      subsection = null;
      itemTarget = null;
      itemIndex = -1;
      continue;
    }
    const subheading = line.match(/^###\s+(.+)$/);
    if (subheading && section) {
      subsection = { title: subheading[1], items: [] };
      section.subsections.push(subsection);
      itemTarget = null;
      itemIndex = -1;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && section) {
      itemTarget = subsection ? subsection.items : section.items;
      itemTarget.push(bullet[1]);
      itemIndex = itemTarget.length - 1;
      continue;
    }
    if (itemTarget && itemIndex >= 0) {
      itemTarget[itemIndex] += ` ${line}`;
    }
  }

  return sections
    .map((candidate) => {
      const subsections = candidate.subsections.filter((entry) => entry.items.length > 0);
      const result = { key: candidate.key, title: candidate.title, items: candidate.items };
      if (subsections.length > 0) result.subsections = subsections;
      return result;
    })
    .filter((candidate) => candidate.items.length > 0 || (candidate.subsections?.length ?? 0) > 0);
}

function parseVersion(filename) {
  const label = filename.slice(1, -3);
  const match = label.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) throw new Error(`Unsupported release note filename: ${filename}`);
  const prerelease = match[4] ?? "";
  const beta = prerelease.match(/^beta\.(\d+)$/);
  const channel = beta ? "beta" : "stable";
  return {
    version: `v${label}`,
    label,
    channel,
    file: `v${label}.json`,
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
  return entries;
}

function json(value) {
  return `${JSON.stringify(value)}\n`;
}

async function expectedOutputs(entries) {
  const versions = entries.map(({ sort: _sort, zh: _zh, en: _en, ...metadata }) => metadata);
  const stable = versions.filter((entry) => entry.channel === "stable");
  const beta = versions.filter((entry) => entry.channel === "beta");
  const manifest = {
    generatedAt: new Date(0).toISOString(),
    latest: { stable: stable[0]?.version ?? null, beta: beta[0]?.version ?? null },
    channels: { stable, beta },
  };
  const outputs = new Map([[manifestPath, json(manifest)]]);
  for (const { sort: _sort, file, ...entry } of entries) outputs.set(path.join(dataDir, file), json(entry));
  return outputs;
}

async function checkOutputs(outputs) {
  for (const [file, expected] of outputs) {
    let actual;
    try { actual = await readFile(file, "utf8"); } catch { throw new Error(`${path.relative(root, file)} is missing; run pnpm build:changelog`); }
    if (actual !== expected) throw new Error(`${path.relative(root, file)} is stale; run pnpm build:changelog`);
  }
  const actualFiles = (await readdir(dataDir)).filter((name) => name.endsWith(".json"));
  if (actualFiles.length !== outputs.size) throw new Error("changelog-data contains stale JSON files; run pnpm build:changelog");
  const html = await readFile(outputPath, "utf8");
  if (html.includes("var ENTRIES")) throw new Error("docs/changelog.html still embeds release bodies; run pnpm build:changelog");
}

const entries = await buildEntries();
const outputs = await expectedOutputs(entries);

if (process.argv.includes("--check")) {
  await checkOutputs(outputs);
  console.log(`changelog data is current (${entries.length} releases, ${outputs.size} JSON files)`);
} else {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await Promise.all([...outputs].map(([file, content]) => writeFile(file, content)));
  const html = await readFile(outputPath, "utf8");
  if (embeddedDataPattern.test(html)) await writeFile(outputPath, html.replace(embeddedDataPattern, "\n"));
  await checkOutputs(outputs);
  console.log(`generated manifest and ${entries.length} release files in docs/changelog-data`);
}
