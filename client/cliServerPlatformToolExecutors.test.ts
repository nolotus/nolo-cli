import { describe, expect, it } from "bun:test";
import { buildServerPlatformToolExecutors } from "./cliServerPlatformToolExecutors";
import { classifyFetchWebpageUrl } from "./fetchWebpageContent";
import {
  FETCH_WEBPAGE_MAX_CONTENT_LENGTH,
  FETCH_WEBPAGE_PREVIEW_LENGTH,
  cleanHtmlForAI,
  shapeFetchWebpageContent,
} from "../core/fetchWebpageShaping";
import type { CliFetchImpl } from "../cliFetch";

const ENV = {
  NOLO_SERVER_URL: "https://nolo.test",
  AUTH_TOKEN: "test-token",
};

function buildFetchRecorder(handlers: {
  local?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  bridge?: (url: string, init?: RequestInit) => Promise<Response> | Response;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: CliFetchImpl = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://nolo.test/")) {
      if (!handlers.bridge) {
        throw new Error(`unexpected bridge call: ${url}`);
      }
      return handlers.bridge(url, init);
    }
    if (!handlers.local) {
      throw new Error(`unexpected local call: ${url}`);
    }
    return handlers.local(url, init);
  };
  return { fetchImpl, calls };
}

async function runFetchWebpage(
  url: string,
  fetchImpl: CliFetchImpl,
) {
  const executors = buildServerPlatformToolExecutors({ env: ENV, fetchImpl });
  return executors.fetchWebpage({
    arguments: JSON.stringify({ url }),
  });
}

describe("classifyFetchWebpageUrl", () => {
  it("routes loopback and private hosts to local", () => {
    expect(classifyFetchWebpageUrl("http://127.0.0.1:13882/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://localhost:3000/x").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://192.168.1.5/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://10.0.0.8/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://172.16.0.1/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://169.254.1.1/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://[::1]/").kind).toBe("local");
    expect(classifyFetchWebpageUrl("http://0.0.0.0:80/").kind).toBe("local");
  });

  it("routes public http(s) to remote bridge", () => {
    expect(classifyFetchWebpageUrl("https://example.com/").kind).toBe("remote");
    expect(classifyFetchWebpageUrl("http://example.com/path").kind).toBe("remote");
  });

  it("rejects non-http(s) protocols", () => {
    const rejected = classifyFetchWebpageUrl("file:///etc/passwd");
    expect(rejected).toEqual({
      kind: "reject",
      error: "仅支持 HTTP/HTTPS 协议",
    });
  });
});

describe("fetchWebpage routing in buildServerPlatformToolExecutors", () => {
  it("fetches http://127.0.0.1:13882/ in-process and does not bridge", async () => {
    const { fetchImpl, calls } = buildFetchRecorder({
      local: () =>
        new Response("<html><body>hello local</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    const result = await runFetchWebpage("http://127.0.0.1:13882/", fetchImpl);

    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:13882/"]);
    expect(calls.some((c) => c.url.includes("/api/fetch-webpage"))).toBe(false);
    expect(result.metadata).toMatchObject({
      serverPlatformTool: true,
      webTool: "fetchWebpage",
      url: "http://127.0.0.1:13882/",
      localFetch: true,
    });
    const body = JSON.parse(result.content);
    expect(body.fullContent).toContain("hello local");
    expect(body).toHaveProperty("preview");
    expect(body).toHaveProperty("contentType");
    expect(body).toHaveProperty("markdownTokens");
  });

  it("fetches http://localhost:3000/x in-process", async () => {
    const { fetchImpl, calls } = buildFetchRecorder({
      local: () =>
        new Response("# local md", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
    });

    const result = await runFetchWebpage("http://localhost:3000/x", fetchImpl);
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:3000/x"]);
    expect(JSON.parse(result.content).fullContent).toBe("# local md");
  });

  it("fetches http://192.168.1.5/ in-process", async () => {
    const { fetchImpl, calls } = buildFetchRecorder({
      local: () =>
        new Response("<p>lan</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    await runFetchWebpage("http://192.168.1.5/", fetchImpl);
    expect(calls.map((c) => c.url)).toEqual(["http://192.168.1.5/"]);
    expect(calls.some((c) => c.url.includes("/api/fetch-webpage"))).toBe(false);
  });

  it("still bridges https://example.com/ to the server", async () => {
    const bridgeBody = {
      preview: "public preview",
      fullContent: "public full",
      contentType: "text/html",
      markdownTokens: null,
    };
    const { fetchImpl, calls } = buildFetchRecorder({
      bridge: (url, init) => {
        expect(url).toBe("https://nolo.test/api/fetch-webpage");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          url: "https://example.com/",
        });
        return new Response(JSON.stringify(bridgeBody), { status: 200 });
      },
    });

    const result = await runFetchWebpage("https://example.com/", fetchImpl);
    expect(calls.map((c) => c.url)).toEqual([
      "https://nolo.test/api/fetch-webpage",
    ]);
    expect(result.metadata?.localFetch).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual(bridgeBody);
  });

  it("rejects file:///etc/passwd without fetching", async () => {
    const { fetchImpl, calls } = buildFetchRecorder({});
    await expect(runFetchWebpage("file:///etc/passwd", fetchImpl)).rejects.toThrow(
      "仅支持 HTTP/HTTPS 协议",
    );
    expect(calls).toEqual([]);
  });

  it("keeps local result shape aligned with the server bridge payload", async () => {
    const html = [
      "<html><head><style>body{color:red}</style><script>alert(1)</script></head>",
      "<body><h1>Title</h1><p>Hello   world</p></body></html>",
    ].join("");
    const longTail = "x".repeat(FETCH_WEBPAGE_MAX_CONTENT_LENGTH + 50);
    const page = `${html}${longTail}`;

    const { fetchImpl } = buildFetchRecorder({
      local: () =>
        new Response(page, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "x-markdown-tokens": "42",
          },
        }),
    });

    const result = await runFetchWebpage("http://127.0.0.1:9/", fetchImpl);
    const body = JSON.parse(result.content);
    const expected = shapeFetchWebpageContent({
      content: page,
      contentType: "text/html; charset=utf-8",
      markdownTokens: "42",
    });

    expect(Object.keys(body).sort()).toEqual(
      ["contentType", "fullContent", "markdownTokens", "preview"].sort(),
    );
    expect(body).toEqual(expected);
    expect(body.preview.endsWith("...（预览内容已截断）")).toBe(true);
    expect(body.fullContent.endsWith("...（完整内容已截断）")).toBe(true);
    expect(body.preview.length).toBe(
      FETCH_WEBPAGE_PREVIEW_LENGTH + "...（预览内容已截断）".length,
    );
    expect(cleanHtmlForAI("<script>x</script><p>y</p>")).toBe("y");
  });
});
