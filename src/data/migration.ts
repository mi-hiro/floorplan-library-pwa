import type { CrawlCandidate, CrawlLog, CrawlSite, FloorPlanProperty } from "../types";
import { clearStore, DB_NAME, getAllItems, putMany } from "./db";

export const MIGRATION_APP_NAME = "floorplan-library-pwa";
export const MIGRATION_VERSION = 1;
export const APP_LOCAL_STORAGE_PREFIX = "floorplan-library:";

export type MigrationImportMode = "merge" | "replace";

export type MigrationStoreCounts = {
  properties: { count: number };
  sites: { count: number };
  candidates: { count: number };
  logs: { count: number };
};

export interface MigrationBackup {
  appName: typeof MIGRATION_APP_NAME;
  exportedAt: string;
  version: number;
  indexedDbName: typeof DB_NAME;
  stores: MigrationStoreCounts;
  properties: FloorPlanProperty[];
  sites: CrawlSite[];
  candidates: CrawlCandidate[];
  logs: CrawlLog[];
  localStorage: Record<string, string>;
}

export interface MigrationImportResult {
  mode: MigrationImportMode;
  counts: MigrationStoreCounts;
  localStorageCount: number;
}

function collectAppLocalStorage() {
  const values: Record<string, string> = {};
  if (typeof window === "undefined") return values;

  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key || !key.startsWith(APP_LOCAL_STORAGE_PREFIX)) continue;
    values[key] = window.localStorage.getItem(key) ?? "";
  }

  return values;
}

export function getMigrationCounts(backup: Pick<MigrationBackup, "properties" | "sites" | "candidates" | "logs">): MigrationStoreCounts {
  return {
    properties: { count: backup.properties.length },
    sites: { count: backup.sites.length },
    candidates: { count: backup.candidates.length },
    logs: { count: backup.logs.length }
  };
}

export async function createMigrationBackup(): Promise<MigrationBackup> {
  const [properties, sites, candidates, logs] = await Promise.all([
    getAllItems("properties"),
    getAllItems("sites"),
    getAllItems("candidates"),
    getAllItems("logs")
  ]);

  return {
    appName: MIGRATION_APP_NAME,
    exportedAt: new Date().toISOString(),
    version: MIGRATION_VERSION,
    indexedDbName: DB_NAME,
    stores: getMigrationCounts({ properties, sites, candidates, logs }),
    properties,
    sites,
    candidates,
    logs,
    localStorage: collectAppLocalStorage()
  };
}

function requireArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeLocalStorage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, entryValue]) => key.startsWith(APP_LOCAL_STORAGE_PREFIX) && typeof entryValue === "string")
      .map(([key, entryValue]) => [key, entryValue as string])
  );
}

export function normalizeMigrationBackup(value: unknown): MigrationBackup {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("移行JSONの形式が違います。");
  }

  const source = value as Partial<MigrationBackup>;
  if (source.appName !== MIGRATION_APP_NAME) {
    throw new Error("このアプリ用の移行JSONではありません。");
  }
  if (source.indexedDbName !== DB_NAME) {
    throw new Error("IndexedDB名が違う移行JSONです。");
  }

  const backup: MigrationBackup = {
    appName: MIGRATION_APP_NAME,
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : new Date().toISOString(),
    version: typeof source.version === "number" ? source.version : MIGRATION_VERSION,
    indexedDbName: DB_NAME,
    stores: {
      properties: { count: 0 },
      sites: { count: 0 },
      candidates: { count: 0 },
      logs: { count: 0 }
    },
    properties: requireArray<FloorPlanProperty>(source.properties),
    sites: requireArray<CrawlSite>(source.sites),
    candidates: requireArray<CrawlCandidate>(source.candidates),
    logs: requireArray<CrawlLog>(source.logs),
    localStorage: normalizeLocalStorage(source.localStorage)
  };

  return {
    ...backup,
    stores: getMigrationCounts(backup)
  };
}

async function putStoreItems(backup: MigrationBackup) {
  await Promise.all([
    putMany("properties", backup.properties),
    putMany("sites", backup.sites),
    putMany("candidates", backup.candidates),
    putMany("logs", backup.logs)
  ]);
}

function restoreAppLocalStorage(values: Record<string, string>, mode: MigrationImportMode) {
  if (typeof window === "undefined") return 0;

  if (mode === "replace") {
    const keysToRemove: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(APP_LOCAL_STORAGE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.localStorage.removeItem(key));
  }

  Object.entries(values).forEach(([key, value]) => {
    if (key.startsWith(APP_LOCAL_STORAGE_PREFIX)) {
      window.localStorage.setItem(key, value);
    }
  });

  return Object.keys(values).length;
}

export async function importMigrationBackup(rawBackup: unknown, mode: MigrationImportMode): Promise<MigrationImportResult> {
  const backup = normalizeMigrationBackup(rawBackup);

  if (mode === "replace") {
    await Promise.all([clearStore("properties"), clearStore("sites"), clearStore("candidates"), clearStore("logs")]);
  }

  await putStoreItems(backup);
  const localStorageCount = restoreAppLocalStorage(backup.localStorage, mode);

  return {
    mode,
    counts: getMigrationCounts(backup),
    localStorageCount
  };
}
