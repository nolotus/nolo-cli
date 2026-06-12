// 文件路径: database/fileStorage.ts

/**
 * 浏览器端文件存储（IndexedDB）
 *
 * 设计：
 * - 库名: "nolo-file-storage"
 * - 表名: "files"
 * - 主键: "id" (即 fileId / BlobId)
 *
 * 存储内容:
 * {
 *   id: string;         // fileId
 *   blob: Blob;         // 文件数据
 *   size: number;
 *   type: string;       // MIME
 *   createdAt: string;  // ISO 时间
 * }
 */

const DB_NAME = "nolo-file-storage";
const STORE_NAME = "files";
const DB_VERSION = 1;

export interface StoredFileRecord {
    id: string;
    blob: Blob;
    size: number;
    type: string;
    createdAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

const openFileDb = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;

    if (typeof indexedDB === "undefined") {
        console.warn(
            "[fileStorage] indexedDB is not available in this environment. File caching is disabled."
        );
        dbPromise = Promise.reject(
            new Error("indexedDB is not available in this environment")
        );
        return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error("[fileStorage] Failed to open IndexedDB:", request.error);
            reject(request.error);
        };

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, {
                    keyPath: "id",
                });
                store.createIndex("createdAt", "createdAt", { unique: false });
            }
        };

        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => {
                db.close();
                console.warn(
                    "[fileStorage] IndexedDB version change detected, closing old connection."
                );
            };
            resolve(db);
        };
    });

    return dbPromise;
};

/**
 * 将文件 (File/Blob) 存入 IndexedDB
 * - key = fileId
 */
export const saveFileToIndexedDb = async (
    fileId: string,
    file: File | Blob
): Promise<void> => {
    try {
        const db = await openFileDb();
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);

        const blob = file instanceof Blob ? file : new Blob([file]);

        const record: StoredFileRecord = {
            id: fileId,
            blob,
            size: blob.size,
            type: blob.type || "application/octet-stream",
            createdAt: new Date().toISOString(),
        };

        const request = store.put(record);

        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                console.debug(
                    "[fileStorage] Saved file to IndexedDB:",
                    fileId,
                    "size=",
                    record.size,
                    "type=",
                    record.type
                );
                resolve();
            };
            request.onerror = () => {
                console.error(
                    "[fileStorage] Failed to save file to IndexedDB:",
                    fileId,
                    request.error
                );
                reject(request.error);
            };
        });

        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch (err) {
        console.warn(
            "[fileStorage] saveFileToIndexedDb error (non-fatal, caching disabled for this file):",
            err
        );
    }
};

/**
 * 从 IndexedDB 中读取文件
 * - key = fileId
 */
export const loadFileFromIndexedDb = async (
    fileId: string
): Promise<StoredFileRecord | null> => {
    try {
        const db = await openFileDb();
        const tx = db.transaction(STORE_NAME, "readonly");
        const store = tx.objectStore(STORE_NAME);

        const request = store.get(fileId);

        const record = await new Promise<StoredFileRecord | null>(
            (resolve, reject) => {
                request.onsuccess = () => {
                    const result = request.result as StoredFileRecord | undefined;
                    if (result) {
                        console.debug(
                            "[fileStorage] Loaded file from IndexedDB:",
                            fileId,
                            "size=",
                            result.size,
                            "type=",
                            result.type
                        );
                    } else {
                        console.debug(
                            "[fileStorage] No local file found in IndexedDB for id:",
                            fileId
                        );
                    }
                    resolve(result ?? null);
                };
                request.onerror = () => {
                    console.error(
                        "[fileStorage] Failed to load file from IndexedDB:",
                        fileId,
                        request.error
                    );
                    reject(request.error);
                };
            }
        );

        return record ?? null;
    } catch (err) {
        console.warn(
            "[fileStorage] loadFileFromIndexedDb error, treat as cache miss:",
            err
        );
        return null;
    }
};

/**
 * 从 IndexedDB 中删除文件
 * - key = fileId
 */
export const deleteFileFromIndexedDb = async (fileId: string): Promise<void> => {
    try {
        const db = await openFileDb();
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);

        const request = store.delete(fileId);

        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                console.debug("[fileStorage] Deleted file from IndexedDB:", fileId);
                resolve();
            };
            request.onerror = () => {
                console.error(
                    "[fileStorage] Failed to delete file from IndexedDB:",
                    fileId,
                    request.error
                );
                reject(request.error);
            };
        });

        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } catch (err) {
        console.warn("[fileStorage] deleteFileFromIndexedDb error:", err);
    }
};