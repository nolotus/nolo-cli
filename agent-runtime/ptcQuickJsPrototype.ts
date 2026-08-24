import { newQuickJSWASMModule, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";

export interface PtcQuickJsPrototypeTools {
  execShell?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  agents?: {
    run?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  };
}

export interface PtcQuickJsPrototypeOptions {
  code: string;
  tools?: PtcQuickJsPrototypeTools;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  abortSignal?: AbortSignal;
}

export interface PtcQuickJsPrototypeResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  interrupted?: boolean;
  outOfMemory?: boolean;
}

/**
 * Helper to safely marshal any JSON-serializable host value into a QuickJS handle.
 */
function marshalJsonToQuickJs(vm: QuickJSContext, data: unknown): QuickJSHandle {
  const jsonStr = JSON.stringify(data ?? null);
  const strHandle = vm.newString(jsonStr);
  const jsonHandle = vm.getProp(vm.global, "JSON");
  const parseHandle = vm.getProp(jsonHandle, "parse");
  const res = vm.callFunction(parseHandle, jsonHandle, strHandle);
  strHandle.dispose();
  jsonHandle.dispose();
  parseHandle.dispose();
  return vm.unwrapResult(res);
}

/**
 * Feasibility prototype executor for PTC (Programmatic Tool Calling) in a QuickJS-WASM sandbox.
 *
 * NOTE: This is an isolated experimental spike prototype for evaluating
 * QuickJS-WASM isolation, asynchronous host bridging, concurrency, and security properties.
 * It does NOT connect to live turns or production model feeds.
 */
export async function executePtcQuickJsPrototype(
  options: PtcQuickJsPrototypeOptions,
): Promise<PtcQuickJsPrototypeResult> {
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();

  if (options.memoryLimitBytes) {
    runtime.setMemoryLimit(options.memoryLimitBytes);
  } else {
    // Default 16MB sandbox memory limit for prototype
    runtime.setMemoryLimit(16 * 1024 * 1024);
  }

  const executionController = new AbortController();
  const onParentAbort = () => {
    executionController.abort(options.abortSignal?.reason);
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      executionController.abort(options.abortSignal.reason);
    } else {
      options.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }

  let wasInterrupted = false;
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = startTime + timeoutMs;

  runtime.setInterruptHandler(() => {
    if (executionController.signal.aborted || options.abortSignal?.aborted) {
      wasInterrupted = true;
      return true;
    }
    if (Date.now() > deadline) {
      wasInterrupted = true;
      executionController.abort(new Error("Execution timed out."));
      return true;
    }
    return false;
  });

  const vm = runtime.newContext();
  const activeHandles: QuickJSHandle[] = [];
  const activePromises = new Set<{ dispose: () => void }>();

  const trackHandle = (h: QuickJSHandle) => {
    activeHandles.push(h);
    return h;
  };

  try {
    // 1. Setup host tools bridge
    const toolsHandle = vm.newObject();

    if (options.tools?.execShell) {
      const execShellHost = options.tools.execShell;
      const execShellFn = vm.newFunction("execShell", (argHandle) => {
        const promiseObj = vm.newPromise();
        activePromises.add(promiseObj);
        const input = vm.dump(argHandle);

        execShellHost(input, { signal: executionController.signal })
          .then((res) => {
            if (vm.alive) {
              const val = marshalJsonToQuickJs(vm, res);
              promiseObj.resolve(val);
              val.dispose();
              runtime.executePendingJobs();
            }
          })
          .catch((err) => {
            if (vm.alive) {
              const errHandle = vm.newError(err?.message ?? String(err));
              promiseObj.reject(errHandle);
              errHandle.dispose();
              runtime.executePendingJobs();
            }
          })
          .finally(() => {
            activePromises.delete(promiseObj);
            try {
              promiseObj.dispose();
            } catch {}
          });

        return promiseObj.handle;
      });
      vm.setProp(toolsHandle, "execShell", execShellFn);
      execShellFn.dispose();
    }

    const agentsHandle = vm.newObject();
    if (options.tools?.agents?.run) {
      const agentsRunHost = options.tools.agents.run;
      const agentsRunFn = vm.newFunction("run", (argHandle) => {
        const promiseObj = vm.newPromise();
        activePromises.add(promiseObj);
        const input = vm.dump(argHandle);

        agentsRunHost(input, { signal: executionController.signal })
          .then((res) => {
            if (vm.alive) {
              const val = marshalJsonToQuickJs(vm, res);
              promiseObj.resolve(val);
              val.dispose();
              runtime.executePendingJobs();
            }
          })
          .catch((err) => {
            if (vm.alive) {
              const errHandle = vm.newError(err?.message ?? String(err));
              promiseObj.reject(errHandle);
              errHandle.dispose();
              runtime.executePendingJobs();
            }
          })
          .finally(() => {
            activePromises.delete(promiseObj);
            try {
              promiseObj.dispose();
            } catch {}
          });

        return promiseObj.handle;
      });
      vm.setProp(agentsHandle, "run", agentsRunFn);
      agentsRunFn.dispose();
    }
    vm.setProp(toolsHandle, "agents", agentsHandle);
    agentsHandle.dispose();

    vm.setProp(vm.global, "tools", toolsHandle);
    toolsHandle.dispose();

    // 2. Prepare program execution wrapper
    const wrapper = `
      ${options.code}
      ;(async () => {
        if (typeof main !== "function") {
          throw new Error("Entrypoint 'main(tools)' function not found.");
        }
        return await main(tools);
      })();
    `;

    const evalRes = vm.evalCode(wrapper);
    if (evalRes.error) {
      const errorDump = vm.dump(evalRes.error);
      evalRes.error.dispose();
      const errorMsg =
        typeof errorDump === "object" && errorDump !== null
          ? (errorDump as any).message || JSON.stringify(errorDump)
          : String(errorDump);
      const isOom = errorMsg.includes("out of memory");
      const isInterrupted = errorMsg.includes("interrupted") || wasInterrupted;
      return {
        ok: false,
        error: errorMsg,
        interrupted: isInterrupted,
        outOfMemory: isOom,
      };
    }

    const mainPromiseHandle = trackHandle(vm.unwrapResult(evalRes));

    // 3. Drive asynchronous event loop until completion or deadline/abort
    while (true) {
      if (options.abortSignal?.aborted || executionController.signal.aborted) {
        return { ok: false, error: "Execution aborted by AbortSignal.", interrupted: true };
      }
      if (Date.now() > deadline) {
        executionController.abort(new Error("Execution timed out."));
        return { ok: false, error: "Execution timed out.", interrupted: true };
      }

      runtime.executePendingJobs();
      const state = vm.getPromiseState(mainPromiseHandle);

      if (state.type === "fulfilled") {
        const val = vm.dump(state.value);
        state.value.dispose();
        return { ok: true, result: val };
      } else if (state.type === "rejected") {
        const err = vm.dump(state.error);
        state.error.dispose();
        const errorMsg =
          typeof err === "object" && err !== null
            ? (err as any).message || JSON.stringify(err)
            : String(err);
        const isOom = errorMsg.includes("out of memory");
        const isInterrupted = errorMsg.includes("interrupted") || wasInterrupted;
        return {
          ok: false,
          error: errorMsg,
          interrupted: isInterrupted,
          outOfMemory: isOom,
        };
      }

      await new Promise((r) => setTimeout(r, 10));
    }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    if (options.abortSignal) {
      options.abortSignal.removeEventListener("abort", onParentAbort);
    }
    try {
      executionController.abort(new Error("Sandbox context disposed."));
    } catch {}

    for (const p of activePromises) {
      try {
        p.dispose();
      } catch {}
    }
    activePromises.clear();

    for (const h of activeHandles) {
      try {
        if (h.alive) h.dispose();
      } catch {}
    }
    try {
      vm.dispose();
    } catch {}
    try {
      runtime.dispose();
    } catch {}
  }
}
