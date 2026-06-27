import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonl(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeJsonl(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record));
  await writeFile(filePath, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

export async function upsertJsonlById(filePath, incomingRecords, mergeRecord = defaultMergeRecord) {
  const existing = await readJsonl(filePath);
  const byId = new Map();
  for (const record of existing) {
    if (!record?.id) continue;
    byId.set(record.id, record);
  }
  for (const incoming of incomingRecords) {
    if (!incoming?.id) continue;
    const current = byId.get(incoming.id);
    byId.set(incoming.id, current ? mergeRecord(current, incoming) : incoming);
  }
  const merged = [...byId.values()];
  await writeJsonl(filePath, merged);
  return { before: existing.length, after: merged.length, added: Math.max(0, merged.length - existing.length) };
}

export function defaultMergeRecord(current, incoming) {
  return {
    ...current,
    ...incoming,
    firstSeenAt: current.firstSeenAt || incoming.firstSeenAt,
    lastSeenAt: maxIso(current.lastSeenAt, incoming.lastSeenAt) || incoming.lastSeenAt || current.lastSeenAt
  };
}

export async function ensureJsonFile(filePath, defaultValue) {
  try {
    JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, "utf8");
  }
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return String(a) > String(b) ? a : b;
}
