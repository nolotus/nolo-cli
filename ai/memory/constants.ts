/**
 * "记住"类显式记忆指令的共享常量。
 *
 * 两个不同用途：
 * - `EXPLICIT_REMEMBER_TRIGGERS`：用于**检测**用户是否在要求记住（capture.ts）
 *   更宽松——包含"记得""别忘了""别忘记"等口语化说法。
 * - `EXPLICIT_REMEMBER_PREFIXES`：用于**剥离前缀**（consolidate / overlay / runtime）
 *   更保守——只包含明确的"记住"祈使句前缀，避免误剥离。
 *
 * 两者共享前 4 项。如果新增前缀，先判断是"检测用"还是"剥离用"，
 * 加到对应的数组里——不要只改一处。
 */

/** 检测用：用户可能在要求记住的所有说法（capture.ts 专用）。 */
export const EXPLICIT_REMEMBER_TRIGGERS = [
  "记住",
  "你要记住",
  "请记住",
  "以后记住",
  "记得",
  "别忘了",
  "别忘记",
] as const;

/** 剥离用：normalizeDisplayContent / normalizeExplicitRememberContent 用来去掉前缀。 */
export const EXPLICIT_REMEMBER_PREFIXES = [
  "你要记住",
  "请记住",
  "以后记住",
  "记住",
] as const;

/** 剥离用正则——overlay.ts 和 runtime.ts 共享。 */
export const EXPLICIT_REMEMBER_PREFIX_REGEX =
  /^(你要记住|请记住|以后记住|记住)[，,。.\s:：]*/u;