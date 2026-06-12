// 文件路径: packages/ai/tools/devReloadUtils.ts
// Dev reload 抑制工具函数 - 用于自举编辑时延迟热更新

/**
 * 判断文件路径是否为项目源码（需要抑制 reload 的自举编辑）
 * @param filePath 文件路径
 * @returns 是否属于 packages/ 下的源码
 */
export function isSelfEditingPath(filePath: string): boolean {
    if (!filePath) return false;
    return filePath.replace(/\\/g, "/").startsWith("packages/");
}

/**
 * 如果是自举编辑（改项目源码），增加 reload 抑制计数
 * 这样 dev server 的热更新会被延迟到回答结束后再执行
 * @param filePath 正在编辑的文件路径
 */
export function bumpDevReloadSuppressIfSelfEditing(filePath: string): void {
    if (typeof window === "undefined") return;
    if (!isSelfEditingPath(filePath)) return;

    const w = window as any;
    const cur = typeof w.__DEV_RELOAD_SUPPRESS_COUNT__ === "number" ? w.__DEV_RELOAD_SUPPRESS_COUNT__ : 0;
    w.__DEV_RELOAD_SUPPRESS_COUNT__ = cur + 1;
    w.__DEV_RELOAD_PENDING__ = false;

    console.log("[devReloadSuppress] 自举编辑，增加 reload 抑制计数：", w.__DEV_RELOAD_SUPPRESS_COUNT__, "filePath:", filePath);
}
