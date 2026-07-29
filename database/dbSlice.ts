// 文件路径: database/dbSlice.ts

import {
  asyncThunkCreator,
  buildCreateSlice,
  createEntityAdapter,
  type PayloadAction,
} from "@reduxjs/toolkit";
// Import actions
import { removeAction } from "./actions/remove";
import { readAndWaitAction } from "./actions/readAndWait";
import { writeAction } from "./actions/write";
import { patchAction } from "./actions/patch";
import { purgeAction } from "./actions/purge";
import { upsertAction } from "./actions/upsert";
import { uploadFileAction } from "./actions/upload";
import { readFileContentAction } from "./actions/fileContent";
import type { ShareActionConfig } from "../share/action";
// NOTE: readAction is intentionally NOT statically imported here — see read thunk.

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
    // 惰性加载 readAction：esbuild 把大型 read.ts 排到同 chunk 后部时，
    // `var readAction` 在 create.asyncThunk(readAction) 执行时仍是 undefined，
    // 之后所有 dispatch(read) 抛 "payloadCreator is not a function"。
    // 动态 import 在调用期解析，避开 TDZ/求值顺序问题（同下方 share）。
    read: create.asyncThunk(
      async (payload: any, thunkApi: any) => {
        const { readAction } = await import("./actions/read");
        return readAction(payload, thunkApi);
      },
      {
        fulfilled: (state, action: PayloadAction<any>) => {
          if (action.payload && Object.keys(action.payload).length > 0) {
            dbAdapter.upsertOne(state, action.payload);
          }
        },
      },
    ),
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
    // 惰性加载 shareResourceAction：静态 import 会形成
    // dbSlice -> share/action -> settings/settingSlice -> settingPersistence
    // -> settings/dbActionThunks -> database/dbActionThunks -> dbSlice 的循环依赖。
    // 分包后 chunk 求值顺序一旦从环内进入 dbSlice，上面的 `readAction` 等
    // `export const` 还处于未初始化状态，thunk 会以 undefined 作为 payloadCreator
    // 建成，之后 dispatch(read(...)) 抛 "payloadCreator is not a function"。
    // 这里改成动态 import，运行期才解析，彻底断开这条边。
    share: create.asyncThunk(
      async (config: ShareActionConfig, thunkApi: any) => {
        const { shareResourceAction } = await import("../share/action");
        return shareResourceAction(config, thunkApi);
      },
    ),
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
