import type { CrawlCandidate, CrawlLog, CrawlSite, FloorPlanProperty } from "../types";

const DB_NAME = "floorplan-library-db";
const DB_VERSION = 1;

export const STORE_NAMES = {
  properties: "properties",
  sites: "sites",
  candidates: "candidates",
  logs: "logs"
} as const;

type StoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];

type StoreMap = {
  properties: FloorPlanProperty;
  sites: CrawlSite;
  candidates: CrawlCandidate;
  logs: CrawlLog;
};

let dbPromise: Promise<IDBDatabase> | undefined;

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        Object.values(STORE_NAMES).forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: "id" });
          }
        });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return dbPromise;
}

async function transaction(storeName: StoreName, mode: IDBTransactionMode) {
  const db = await openDatabase();
  return db.transaction(storeName, mode).objectStore(storeName);
}

export async function getAllItems<K extends keyof StoreMap>(storeName: K) {
  const store = await transaction(STORE_NAMES[storeName], "readonly");
  return requestToPromise<StoreMap[K][]>(store.getAll());
}

export async function putItem<K extends keyof StoreMap>(storeName: K, item: StoreMap[K]) {
  const store = await transaction(STORE_NAMES[storeName], "readwrite");
  await requestToPromise(store.put(item));
  return item;
}

export async function putMany<K extends keyof StoreMap>(storeName: K, items: StoreMap[K][]) {
  const store = await transaction(STORE_NAMES[storeName], "readwrite");
  await Promise.all(items.map((item) => requestToPromise(store.put(item))));
  return items;
}

export async function deleteItem<K extends keyof StoreMap>(storeName: K, id: string) {
  const store = await transaction(STORE_NAMES[storeName], "readwrite");
  await requestToPromise(store.delete(id));
}

export async function clearStore<K extends keyof StoreMap>(storeName: K) {
  const store = await transaction(STORE_NAMES[storeName], "readwrite");
  await requestToPromise(store.clear());
}
