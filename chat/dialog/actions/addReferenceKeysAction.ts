// packages/chat/dialog/actions/addReferenceKeysAction.ts

import { createAsyncThunk } from "@reduxjs/toolkit";
import type { RootState } from "../../../app/store";
import { selectById, patch } from "../../../database/dbSlice";
import { DialogConfig } from "../../../app/types";

/**
 * 从消息内容中提取引用的 keys (pageKey / dialogKey)
 */
const extractReferenceKeys = (content: any): string[] => {
    const keys = new Set<string>();

    if (Array.isArray(content)) {
        for (const part of content) {
            if (part && typeof part === "object") {
                if (part.pageKey) keys.add(part.pageKey);
                if (part.dialogKey) keys.add(part.dialogKey);
            }
        }
    } else if (content && typeof content === "object") {
        if (content.pageKey) keys.add(content.pageKey);
        if (content.dialogKey) keys.add(content.dialogKey);
    }

    return Array.from(keys);
};

export const addReferenceKeysAction = createAsyncThunk(
    "dialog/addReferenceKeys",
    async (
        args: { content: any; dialogKey: string },
        { getState, dispatch }
    ) => {
        const { content, dialogKey } = args;
        const newKeys = extractReferenceKeys(content);

        if (newKeys.length === 0) return;

        const state = getState() as RootState;
        const dialogConfig = selectById(state, dialogKey) as DialogConfig | undefined;

        if (!dialogConfig) return;

        const existingKeys = new Set(dialogConfig.referenceKeys || []);
        const keysToAdd = newKeys.filter(k => !existingKeys.has(k));

        if (keysToAdd.length === 0) return;

        // 追加新 keys 到 dialog
        const updatedKeys = [...Array.from(existingKeys), ...keysToAdd];

        await dispatch(
            patch({
                dbKey: dialogKey,
                changes: {
                    referenceKeys: updatedKeys,
                },
            })
        );
    }
);
