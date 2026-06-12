// 文件路径: packages/ai/tools/checkEnvTool.ts
// 用于在本地环境执行“生效前检查”（当前最小实现：build）

import { callToolApi } from "./toolApiClient";

export type CheckEnvArgs = {
    check?: "build" | "context";
    key?: string;
};

export const checkEnvFunctionSchema = {
    name: "checkEnv",
    description: [
        "执行环境检查并返回结构化结果。",
        "check='context' 可查看当前平台、工作目录与可用 shell；check='build' 可快速验证是否可编译。",
        "key 可检查某个本地工具，例如 key='gemini' 会探测本机 Gemini CLI 与 npm 最新版本。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            check: {
                type: "string",
                enum: ["build", "context"],
                description: "检查项：context 返回当前运行环境；build 执行构建检查。",
            },
            key: {
                type: "string",
                enum: ["gemini", "node", "npm", "bun", "python", "git", "shell"],
                description: "可选：探测某个本地工具，不执行 build。常用值如 gemini、node、npm、bun、python、git、shell。",
            },
        },
    },
};

const formatProbeOutput = (probe: any): string => {
    const status = probe?.ok ? "OK" : "FAIL";
    const lines = [`- [${status}] ${probe?.label ?? "probe"}`];
    const stdout = typeof probe?.stdout === "string" ? probe.stdout.trim() : "";
    const stderr = typeof probe?.stderr === "string" ? probe.stderr.trim() : "";
    const error = typeof probe?.error === "string" ? probe.error.trim() : "";
    if (stdout) lines.push(`  stdout: ${stdout}`);
    if (stderr) lines.push(`  stderr: ${stderr}`);
    if (error) lines.push(`  error: ${error}`);
    return lines.join("\n");
};

export async function checkEnvFunc(
    args: CheckEnvArgs,
    thunkApi: any,
    context?: { agentKey?: string }
): Promise<{ rawData: any; displayData: string }> {
    const key = typeof args?.key === "string" ? args.key.trim().toLowerCase() : "";
    const check = args?.check === "context" ? "context" : "build";
    const payload = key ? { key } : { check };

    const result = await callToolApi<any>(
        thunkApi,
        "/api/check-env",
        payload,
        {
            withAuth: true,
            agentKey: context?.agentKey,
        }
    );

    const ok = !!result?.ok;
    const exitCode = typeof result?.exitCode === "number" ? result.exitCode : -1;

    if (result?.check === "tool") {
        const probes = Array.isArray(result?.probes) ? result.probes : [];
        return {
            rawData: result,
            displayData: [
                `本地工具检查: ${result?.key ?? key}`,
                ...probes.map(formatProbeOutput),
            ].join("\n"),
        };
    }

    if (check === "context") {
        const displayParts = [
            `平台: ${result?.platform ?? "unknown"}`,
            `cwd: ${result?.cwd ?? "unknown"}`,
            `defaultShell: ${result?.defaultShell ?? "unknown"}`,
            `bash: ${result?.shells?.bash ? "yes" : "no"}`,
            `powershell: ${result?.shells?.powershell ? "yes" : "no"}`,
            `pwsh: ${result?.shells?.pwsh ? "yes" : "no"}`,
        ];

        return {
            rawData: result,
            displayData: `🧭 当前环境\n${displayParts.join("\n")}`,
        };
    }

    return {
        rawData: result,
        displayData: ok
            ? `✅ 环境检查通过: ${check}`
            : `❌ 环境检查失败: ${check} (exitCode=${exitCode})`,
    };
}
