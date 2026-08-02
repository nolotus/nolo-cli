// @ts-nocheck — incomplete db/fetch stubs for dry-run local runtime paths.
import { describe, expect, test } from "bun:test";
import { DEFAULT_LOCAL_TOOLS } from "../agent-runtime/localToolPolicy";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runLocalAgentTurn } from "../agent-runtime/localLoop";
import { createCliLocalRuntimeAdapter } from "./localRuntimeAdapter";

/** Test-only loose deps for incomplete fetch/db stubs. */
function createAdapter(deps: any) {
  return createCliLocalRuntimeAdapter(deps);
}

describe("CLI local runtime dry run", () => {

  test("lets a declared workspace file tool write a file and save the tool trace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "nolo-local-runtime-dry-run-"));
    try {
      const records = new Map<string, any>([
        ["agent-user-1-frontend", {
          dbKey: "agent-user-1-frontend",
          id: "frontend",
          name: "Frontend Implementer",
          prompt: "Use workspace file tools to edit files.",
          model: "qwen-coder",
          tools: [
            { type: "function", function: { name: "writeFile" } },
          ],
        }],
      ]);
      const batchOps: any[] = [];
      let completeCount = 0;
      const adapter = createAdapter({
        env: {
          NOLO_LOCAL_USER_ID: "user-1",
          NOLO_LOCAL_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1",
        },
        db: {
          get: async (key) => {
            if (!records.has(key)) throw new Error(`not found: ${key}`);
            return records.get(key);
          },
          put: async (key, value) => {
            records.set(key, value);
          },
          batch: async (ops) => {
            batchOps.push(...ops);
            for (const op of ops) {
              if (op.type === "put") records.set(op.key, op.value);
            }
          },
          iterator: () => (async function* () {})(),
        },
        cwd: workspaceRoot,
        now: () => 1710000000000,
        createId: () => "dialog-dry-run",
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          completeCount += 1;
          if (completeCount === 1) {
            const sentToolNames: string[] = body.tools.map((tool: any) => tool.function.name);
            // Assert the surface contains what a local agent must have, rather
            // than pinning an exact ordered list: the old transcribed list went
            // stale the moment startAgentRun/controlAgentRun were added, and a
            // list that breaks on every new tool stops being read.
            expect(sentToolNames).toContain("ui_ask_choice");
            for (const name of DEFAULT_LOCAL_TOOLS) {
              expect(sentToolNames).toContain(name);
            }
            // Relaxing the exact-list assertion above lost the guard against
            // the surface silently growing, so keep an explicit deny side:
            // tools retired for being unsafe must never come back by default.
            for (const retired of ["gitCommit", "gitAdd", "commitWorkspace", "createAgent"]) {
              expect(sentToolNames).not.toContain(retired);
            }
            return Response.json({
              model: "qwen-coder",
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "writeFile",
                      arguments: JSON.stringify({
                        path: "src/notification.css",
                        content: ".notification { border-radius: 8px; }\n",
                      }),
                    },
                  }],
                },
              }],
            });
          }
          const toolMessage = body.messages.at(-1);
          expect(toolMessage).toMatchObject({
            role: "tool",
            tool_call_id: "call-1",
          });
          // projectToolContentForProvider appends a diagnostic and a
          // [tool metadata] block, so match the leading result text instead of
          // the whole string — otherwise this breaks on projection changes that
          // have nothing to do with the write this test is guarding.
          expect(String(toolMessage.content)).toStartWith(
            "wrote src/notification.css",
          );
          return Response.json({
            model: "qwen-coder",
            choices: [{ message: { content: "updated" } }],
          });
        },
      });

      const result = await runLocalAgentTurn({
        adapter,
        agentRef: "frontend",
        input: "fix notification UI",
      });

      expect(result).toMatchObject({
        dialogId: "dialog-dry-run",
        content: "updated",
        toolCallCount: 1,
      });
      expect(readFileSync(join(workspaceRoot, "src/notification.css"), "utf8")).toBe(
        ".notification { border-radius: 8px; }\n"
      );
      expect(batchOps.map((op) => op.key)).toEqual([
        "dialog-user-1-dialog-dry-run",
        "dialog-dialog-dry-run-msg-1710000000000-001",
        "dialog-dialog-dry-run-msg-1710000000000-002",
        "dialog-dialog-dry-run-msg-1710000000000-003",
        "dialog-dialog-dry-run-msg-1710000000000-004",
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
