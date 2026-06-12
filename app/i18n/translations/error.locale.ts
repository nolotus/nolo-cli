// translations/error.ts

import { Language } from "../../i18n/types";

export default {
  [Language.EN]: {
    translation: {
      // Authentication errors
      invalidCredentials: "Invalid username or password",
      userNotFound: "User not found",
      accountLocked: "Account has been locked",
      tooManyAttempts: "Too many login attempts, please try again later",
      sessionExpired: "Session expired, please login again",

      // Authorization errors
      notAuthorized: "Not authorized to perform this action",
      invalidToken: "Invalid or expired token",
      insufficientPermissions: "Insufficient permissions",

      // Validation errors
      required: "This field is required",
      invalidFormat: "Invalid format",
      validationError: "Validation failed",
      passwordTooWeak: "Password is too weak",
      usernameTaken: "Username is already taken",
      emailTaken: "Email is already taken",

      // Data errors
      dataExists: "Data with ID {{id}} already exists",
      dataNotFound: "User data was not found",
      duplicateEntry: "Duplicate entry not allowed",
      missingFields: "Required fields are missing",
      databaseError: "Database error occurred",
      invalidUserData: "Invalid user data",

      // File errors
      fileNotFound: "File not found",
      uploadFailed: "File upload failed",
      invalidFileType: "Invalid file type",
      fileTooLarge: "File is too large",

      // Network errors
      networkError: "Network error, please try again",
      serverError: "Server error occurred",
      operationFailed: "Operation failed",
      timeoutError: "Request timed out",
      connectionError: "Connection error",
      errors: {
        accountLocked: "Account has been locked",
        dataExists: "Data with ID {{id}} already exists",
        dataNotFound: "User data was not found",
        databaseError: "Database error occurred",
        internalServerError: "Internal server error",
        invalidUserData: "Invalid user data",
        ipQuotaExceeded: "Too many registrations from this network. Please try again later.",
        methodNotAllowed: "Method not allowed",
        missingFields: "Required fields are missing",
        requestBodyEmpty: "Request body is empty",
        secretKeyMissing: "Secret key is missing",
        tokenVerificationFailed: "Login verification failed",
        userNotFound: "User not found",
        wrongPassword: "Invalid username or password",
      },
    },
  },
  [Language.ZH_CN]: {
    translation: {
      // 认证错误
      invalidCredentials: "用户名或密码错误",
      userNotFound: "用户不存在",
      accountLocked: "账号已被锁定",
      tooManyAttempts: "登录尝试次数过多，请稍后再试",
      sessionExpired: "会话已过期，请重新登录",

      // 授权错误
      notAuthorized: "没有执行此操作的权限",
      invalidToken: "令牌无效或已过期",
      insufficientPermissions: "权限不足",

      // 验证错误
      required: "此项为必填项",
      invalidFormat: "格式无效",
      validationError: "验证失败",
      passwordTooWeak: "密码强度不足",
      usernameTaken: "用户名已被使用",
      emailTaken: "邮箱已被使用",

      // 数据错误
      dataExists: "ID为 {{id}} 的数据已存在",
      dataNotFound: "用户数据不存在",
      duplicateEntry: "不允许重复条目",
      missingFields: "缺少必填字段",
      databaseError: "数据库错误",
      invalidUserData: "用户数据无效",

      // 文件错误
      fileNotFound: "找不到文件",
      uploadFailed: "文件上传失败",
      invalidFileType: "文件类型无效",
      fileTooLarge: "文件太大",

      // 网络错误
      networkError: "网络错误，请重试",
      serverError: "服务器错误",
      operationFailed: "操作失败",
      timeoutError: "请求超时",
      connectionError: "连接错误",
      errors: {
        accountLocked: "账号已被锁定",
        dataExists: "ID为 {{id}} 的数据已存在",
        dataNotFound: "用户数据不存在",
        databaseError: "数据库错误",
        internalServerError: "内部服务器错误",
        invalidUserData: "用户数据无效",
        ipQuotaExceeded: "当前网络注册过于频繁，请稍后再试",
        methodNotAllowed: "请求方法不支持",
        missingFields: "缺少必填字段",
        requestBodyEmpty: "请求内容为空",
        secretKeyMissing: "缺少密钥",
        tokenVerificationFailed: "登录验证失败",
        userNotFound: "用户不存在",
        wrongPassword: "用户名或密码错误",
      },
    },
  },
  [Language.ZH_HANT]: {
    translation: {
      // 認證錯誤
      invalidCredentials: "用戶名或密碼錯誤",
      userNotFound: "用戶不存在",
      accountLocked: "賬號已被鎖定",
      tooManyAttempts: "登錄嘗試次數過多，請稍後再試",
      sessionExpired: "會話已過期，請重新登錄",

      // 授權錯誤
      notAuthorized: "沒有執行此操作的權限",
      invalidToken: "令牌無效或已過期",
      insufficientPermissions: "權限不足",

      // 驗證錯誤
      required: "此項為必填項",
      invalidFormat: "格式無效",
      validationError: "驗證失敗",
      passwordTooWeak: "密碼強度不足",
      usernameTaken: "用戶名已被使用",
      emailTaken: "郵箱已被使用",

      // 數據錯誤
      dataExists: "ID為 {{id}} 的數據已存在",
      dataNotFound: "用戶數據不存在",
      duplicateEntry: "不允許重複條目",
      missingFields: "缺少必填欄位",
      databaseError: "數據庫錯誤",
      invalidUserData: "用戶數據無效",

      // 文件錯誤
      fileNotFound: "找不到文件",
      uploadFailed: "文件上傳失敗",
      invalidFileType: "文件類型無效",
      fileTooLarge: "文件太大",

      // 網絡錯誤
      networkError: "網絡錯誤，請重試",
      serverError: "服務器錯誤",
      operationFailed: "操作失敗",
      timeoutError: "請求超時",
      connectionError: "連接錯誤",
      errors: {
        accountLocked: "賬號已被鎖定",
        dataExists: "ID為 {{id}} 的數據已存在",
        dataNotFound: "用戶數據不存在",
        databaseError: "數據庫錯誤",
        internalServerError: "內部服務器錯誤",
        invalidUserData: "用戶數據無效",
        ipQuotaExceeded: "當前網絡註冊過於頻繁，請稍後再試",
        methodNotAllowed: "請求方法不支持",
        missingFields: "缺少必填欄位",
        requestBodyEmpty: "請求內容為空",
        secretKeyMissing: "缺少密鑰",
        tokenVerificationFailed: "登錄驗證失敗",
        userNotFound: "用戶不存在",
        wrongPassword: "用戶名或密碼錯誤",
      },
    },
  },
  [Language.JA]: {
    translation: {
      // 認証エラー
      invalidCredentials: "ユーザー名またはパスワードが正しくありません",
      userNotFound: "ユーザーが見つかりません",
      accountLocked: "アカウントがロックされています",
      tooManyAttempts: "ログイン試行回数が多すぎます。後でお試しください",
      sessionExpired: "セッションが期限切れです。再度ログインしてください",

      // 認可エラー
      notAuthorized: "この操作を実行する権限がありません",
      invalidToken: "トークンが無効または期限切れです",
      insufficientPermissions: "権限が不足しています",

      // 検証エラー
      required: "この項目は必須です",
      invalidFormat: "形式が無効です",
      validationError: "検証に失敗しました",
      passwordTooWeak: "パスワードが脆弱です",
      usernameTaken: "このユーザー名は既に使用されています",
      emailTaken: "このメールアドレスは既に使用されています",

      // データエラー
      dataExists: "ID {{id}} のデータが既に存在します",
      dataNotFound: "ユーザーデータが見つかりません",
      duplicateEntry: "重複エントリーは許可されていません",
      missingFields: "必須フィールドが不足しています",
      databaseError: "データベースエラーが発生しました",
      invalidUserData: "ユーザーデータが無効です",

      // ファイルエラー
      fileNotFound: "ファイルが見つかりません",
      uploadFailed: "ファイルのアップロードに失敗しました",
      invalidFileType: "ファイル形式が無効です",
      fileTooLarge: "ファイルサイズが大きすぎます",

      // ネットワークエラー
      networkError: "ネットワークエラー、再試行してください",
      serverError: "サーバーエラーが発生しました",
      operationFailed: "操作に失敗しました",
      timeoutError: "リクエストがタイムアウトしました",
      connectionError: "接続エラー",
      errors: {
        accountLocked: "アカウントがロックされています",
        dataExists: "ID {{id}} のデータが既に存在します",
        dataNotFound: "ユーザーデータが見つかりません",
        databaseError: "データベースエラーが発生しました",
        internalServerError: "内部サーバーエラー",
        invalidUserData: "ユーザーデータが無効です",
        ipQuotaExceeded: "このネットワークからの登録が多すぎます。後でもう一度お試しください",
        methodNotAllowed: "メソッドは許可されていません",
        missingFields: "必須フィールドが不足しています",
        requestBodyEmpty: "リクエスト本文が空です",
        secretKeyMissing: "シークレットキーがありません",
        tokenVerificationFailed: "ログイン検証に失敗しました",
        userNotFound: "ユーザーが見つかりません",
        wrongPassword: "ユーザー名またはパスワードが正しくありません",
      },
    },
  },
};
