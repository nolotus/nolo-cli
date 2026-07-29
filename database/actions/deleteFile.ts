
import { removeAction } from "./remove";
import { fetchFromClientDb } from "./common";
import { deleteFileFromIndexedDb } from "../fileStorage";
import { logger } from "./common";

/**
 * Delete File Action:
 * 1. Retrieve metadata to get fileId (if different from dbKey, though usually dbKey maps to metadata which has the fileId)
 * 2. Delete blob from IndexedDB (using fileId from metadata)
 * 3. Call generic removeAction to delete metadata and notify servers
 */
export const deleteFileAction = async (
    dbKey: string,
    thunkApi: any
): Promise<void> => {
    const { db: clientDb } = thunkApi.extra;

    try {
        // 1. Get metadata to find the internal Blob ID (fileId)
        const metadata = await fetchFromClientDb(clientDb, dbKey);

        if (metadata && metadata.id) {
            // 2. Delete blob from IndexedDB
            try {
                await deleteFileFromIndexedDb(metadata.id);
                logger.debug({ fileId: metadata.id }, "Deleted file blob from IndexedDB");
            } catch (err) {
                logger.warn({ err, fileId: metadata.id }, "Failed to delete file blob from IndexedDB, proceeding to delete metadata");
            }
        }

        // 3. Delete metadata and sync delete to servers
        await removeAction(dbKey, thunkApi);

    } catch (error) {
        logger.error({ error, dbKey }, "Failed to delete file completely");
        throw error;
    }
}
