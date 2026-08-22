import { describe, expect, it } from "bun:test";
import { CLI_AUTO_ROUTE_AGENT_KEY } from "./autoModelRouter";
import { BUILTIN_NOLO_AGENT_KEY, isBuiltinPlatformAgentKey } from "../core/builtinAgents";

/**
 * 这个文件曾经有 4 个 test 反复断言「classifyCliAutoRoute 恒返回 flash」——
 * 那个函数忽略全部入参、恒定返回同一个值，调用方也只读 agentKey 一个字段。
 * 档位是历史形状，随模块一起删掉了，剩下的契约只有一条：路由目标是哪个 agent。
 */
describe("CLI auto-route target", () => {
  it("points at the builtin nolo agent", () => {
    // 与 web 首页默认档、TUI /switch 的 nolo 是同一个 agent；三端一致是
    // 这次统一的核心，指向一旦改回广场档，模型就会重新各漂各的。
    expect(CLI_AUTO_ROUTE_AGENT_KEY).toBe(BUILTIN_NOLO_AGENT_KEY);
  });

  it("is a platform builtin agent, so its model is catalog-owned", () => {
    // 只有 builtin 组的 key 才会被 applyBuiltinAgentRuntimeOverride 接管
    // provider/model；指向组外的 agent 会让 --auto-route 重新依赖数据库取值。
    expect(isBuiltinPlatformAgentKey(CLI_AUTO_ROUTE_AGENT_KEY)).toBe(true);
  });
});
