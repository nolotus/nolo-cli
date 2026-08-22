// authToken 纯函数已下沉到 core/authToken（公开集消费方从 core 导入）。
// 本文件保留 re-export，私有侧 import 路径不变。
// TODO(open-source): 私有侧消费方迁移到 core/authToken 后可删除本文件。
export {
  buildPersistentAuthTokenPayload,
  parseToken,
  signToken,
  verifyToken,
} from "../core/authToken";