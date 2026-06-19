import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runLocalAgentTurn } from "../agent-runtime/localLoop";
import { createCliLocalRuntimeAdapter } from "./localRuntimeAdapter";

describe("CLI local runtime dry run", () => {
  const DEFAULT_PRIVATE_LOCAL_TOOL_NAMES = [
    "listFiles",
    "readFile",
    "writeFile",
    "editFile",
    "globFiles",
    "searchFiles",
    "execShell",
    "listDialogs",
    "readDialog",
    "queryDialogsBySubjectRef",
    "listAgents",
    "readAgent",
    "listSpaces",
    "readSpace",
    "readDoc",
    "readSkillDoc",
    "listTables",
    "queryTableRows",
    "cliWhoami",
    "cliDoctor",
  ];

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
      const adapter = createCliLocalRuntimeAdapter({
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
            expect(body.tools.map((tool: any) => tool.function.name)).toEqual(DEFAULT_PRIVATE_LOCAL_TOOL_NAMES);
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
          expect(body.messages.at(-1)).toMatchObject({
            role: "tool",
            content: "wrote src/notification.css",
            tool_call_id: "call-1",
          });
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
