
import { ContentType, SpaceData } from "../../../app/types";
import { uploadFileAction } from "../../../database/actions/upload";
import { addContentAction } from "./addContentAction";
import { toast } from "../../../app/utils/toast";
import { resolveFileCategory } from "../../../app/utils/fileUtils";
import { ulid } from "../../../database/utils/ulid";
import { fileKey } from "../../../database/keys";
import { selectUserId } from "../../../auth/authSlice";
import { patch } from "../../../database/dbSlice";

interface UploadAndAddFileToSpacePayload {
    spaceId: string;
    file: File;
    categoryId?: string;
}

export const uploadAndAddFileToSpaceAction = async (
    payload: UploadAndAddFileToSpacePayload,
    thunkAPI: any
): Promise<{ spaceId: string; updatedSpaceData: SpaceData; contentKey: string; fileId: string }> => {
    const { spaceId, file, categoryId } = payload;
    const { dispatch, getState } = thunkAPI;

    // UserId retrieved from auth state
    const state = getState();
    const userId = selectUserId(state);

    if (!userId) {
        console.warn("[uploadAndAddFileToSpace] Warning: No userId found in state. Uploading as anonymous/unknown might cause issues.");
    }

    try {
        // 生成一个确保唯一的 Key (file-userId-ulid)
        const id = ulid();
        const dbKey = fileKey.single(userId || "unknown", id);
        const contentType = ContentType.FILE;
        const fileCategory = resolveFileCategory({
            mimeType: file.type,
            fileName: file.name,
        });

        // 执行上传；uploadFileAction 当前只接受 file/customKey/userId。
        const fileMetadata = await uploadFileAction(
            { file, customKey: dbKey, userId },
            thunkAPI
        );

        // 2. 添加到 Space Content
        if (!fileMetadata) {
            throw new Error("Upload failed, no metadata returned");
        }

        // 使用返回的 dbKey (file-userId-ulid) 作为 contentKey
        const contentKey = fileMetadata.dbKey || dbKey;
        const title = file.name;

        // addContentAction is a raw async function, NOT a Redux action creator.
        // It expects (payload, thunkAPI).
        const result = await addContentAction({
            spaceId,
            contentKey,
            title,
            type: contentType,
            fileCategory,
            mimeType: file.type || undefined,
            fileSize: Number.isFinite(file.size) ? file.size : undefined,
            originalName: file.name,
            categoryId,
        }, thunkAPI);

        await (dispatch as any)(
            patch({
                dbKey: contentKey,
                changes: {
                    title,
                    spaceId,
                    fileCategory,
                    mimeType: file.type || undefined,
                    fileSize: Number.isFinite(file.size) ? file.size : undefined,
                    originalName: file.name,
                },
            })
        ).unwrap();

        if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("nolo-user-data-updated"));
        }

        toast.success("文件上传成功");
        return { ...result, contentKey, fileId: fileMetadata.id };

    } catch (error: any) {
        console.error("Upload and add file error:", error);
        toast.error(error.message || "上传文件失败");
        throw error;
    }
};
