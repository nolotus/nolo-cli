// 文件路径: database/dbSlice.ts

import {
  asyncThunkCreator,
  buildCreateSlice,
  createEntityAdapter,
  type PayloadAction,
} from "@reduxjs/toolkit";
// Import actions
import { removeAction } from "./actions/remove";
import { readAction } from "./actions/read";
import { readAndWaitAction } from "./actions/readAndWait";
import { writeAction } from "./actions/write";
import { patchAction } from "./actions/patch";
import { purgeAction } from "./actions/purge";
import { upsertAction } from "./actions/upsert";
import { uploadFileAction } from "./actions/upload";
import { readFileContentAction } from "./actions/fileContent";
import { shareResourceAction } from "../share/action";

// Use dbKey as the entity's unique identifier
export const dbAdapter = createEntityAdapter<any, string>({
  selectId: (entity: any) => entity.dbKey as string,
});

// Selectors — inline type avoids circular RootState dependency
type DbRootState = { db: any };
export const {
  selectById,
  selectEntities,
  selectAll,
  selectIds,
  selectTotal,
} = dbAdapter.getSelectors((state: DbRootState) => state.db);

// Initial state
const initialState = dbAdapter.getInitialState({});

// Create slice with async thunks
const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

// Slice definition
const dbSlice = createSliceWithThunks({
  name: "db",
  initialState,
  reducers: (create) => ({
    // Async Thunks
    read: create.asyncThunk(readAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        if (action.payload && Object.keys(action.payload).length > 0) {
          dbAdapter.upsertOne(state, action.payload);
        }
      },
    }),
    readAndWait: create.asyncThunk(readAndWaitAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        if (action.payload && Object.keys(action.payload).length > 0) {
          dbAdapter.upsertOne(state, action.payload);
        }
      },
    }),
    remove: create.asyncThunk(removeAction, {
      fulfilled: (state, action: PayloadAction<{ dbKey?: string }>) => {
        const { dbKey } = action.payload;
        if (dbKey) dbAdapter.removeOne(state, dbKey);
      },
    }),
    purge: create.asyncThunk(purgeAction, {
      fulfilled: (state, action: PayloadAction<{ dbKey?: string }>) => {
        const { dbKey } = action.payload;
        if (dbKey) dbAdapter.removeOne(state, dbKey);
      },
    }),
    write: create.asyncThunk(writeAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        if (
          action.payload &&
          action.payload.dbKey &&
          Object.keys(action.payload).length > 0
        ) {
          dbAdapter.upsertOne(state, action.payload);
        }
      },
    }),
    patch: create.asyncThunk(patchAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        const { payload } = action;
        if (payload && payload.dbKey && Object.keys(payload).length > 0) {
          dbAdapter.upsertOne(state, payload);
        }
      },
    }),
    upsert: create.asyncThunk(upsertAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        if (
          action.payload &&
          action.payload.dbKey &&
          Object.keys(action.payload).length > 0
        ) {
          dbAdapter.upsertOne(state, action.payload);
        }
      },
    }),
    // 文件上传（avatar / Slate / Space 等统一走这里）
    upload: create.asyncThunk(uploadFileAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        const payload = action.payload;
        if (payload && payload.dbKey && Object.keys(payload).length > 0) {
          dbAdapter.upsertOne(state, payload);
        }
      },
    }),
    // 读取文件内容（优先本地 IndexedDB，无状态副作用）
    readFileContent: create.asyncThunk(readFileContentAction, {
      // fulfilled 时不修改 db state；由调用方通过 unwrap() 拿返回值使用
    }),
    share: create.asyncThunk(shareResourceAction, {
      fulfilled: (state, action: PayloadAction<any>) => {
        if (action.payload && action.payload.key) {
          // We might want to store the shared object in local DB state too?
          // writeAction already does it. This is just for return value.
          // Actually, writeAction is dispatched inside shareResourceAction.
          // Does writeAction update state? Yes.
          // So here we might not need to do anything extra to state, 
          // just define the thunk.
        }
      }
    }),
    // SSR 预取：服务端直接注入实体到 db slice，供首屏 hydrate 使用
    upsertSSREntity: create.reducer((state, action: PayloadAction<any>) => {
      if (action.payload && action.payload.dbKey) {
        dbAdapter.upsertOne(state, action.payload);
      }
    }),
    // Undo an in-memory optimistic entity without writing a tombstone or
    // scheduling remote deletion. Durable deletes must continue to use remove.
    removeCachedEntity: create.reducer((state, action: PayloadAction<string>) => {
      if (action.payload) dbAdapter.removeOne(state, action.payload);
    }),
  }),
});

// Export actions
export const {
  remove,
  purge,
  read,
  readAndWait,
  write,
  patch,
  upsert,
  upload,
  readFileContent,
  share,
  upsertSSREntity,
  removeCachedEntity,
} = dbSlice.actions;

// Export the reducer
export default dbSlice.reducer;
