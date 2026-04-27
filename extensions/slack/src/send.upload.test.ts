import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSlackBlockTestMocks,
  resetSlackBlockTestAccountConfig,
  setSlackBlockTestAccountConfig,
} from "./blocks.test-helpers.js";

// --- Module mocks (must precede dynamic import) ---
installSlackBlockTestMocks();
const loadOutboundMediaFromUrlMock = vi.hoisted(() =>
  vi.fn(async (_mediaUrl: string, _options?: unknown) => ({
    buffer: Buffer.from("fake-image"),
    contentType: "image/png",
    kind: "image",
    fileName: "screenshot.png",
  })),
);
const fetchWithSsrFGuard = vi.fn(
  async (params: { url: string; init?: RequestInit }) =>
    ({
      response: await fetch(params.url, params.init),
      finalUrl: params.url,
      release: async () => {},
    }) as const,
);

vi.mock("../../../src/infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    fetchWithSsrFGuard(...(args as [params: { url: string; init?: RequestInit }])),
  withTrustedEnvProxyGuardedFetchMode: (params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  }),
}));

vi.mock("./runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-api.js")>("./runtime-api.js");
  const mockedLoadOutboundMediaFromUrl =
    loadOutboundMediaFromUrlMock as unknown as typeof actual.loadOutboundMediaFromUrl;
  return {
    ...actual,
    loadOutboundMediaFromUrl: (...args: Parameters<typeof actual.loadOutboundMediaFromUrl>) =>
      mockedLoadOutboundMediaFromUrl(...args),
  };
});

let sendMessageSlack: typeof import("./send.js").sendMessageSlack;
let clearSlackDmChannelCache: typeof import("./send.js").clearSlackDmChannelCache;
let clearSlackSendQueuesForTest: typeof import("./send.js").clearSlackSendQueuesForTest;
({ sendMessageSlack, clearSlackDmChannelCache, clearSlackSendQueuesForTest } =
  await import("./send.js"));
const SLACK_TEST_CFG = { channels: { slack: { botToken: "xoxb-test" } } };

type UploadTestClient = WebClient & {
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn> };
  files: {
    getUploadURLExternal: ReturnType<typeof vi.fn>;
    completeUploadExternal: ReturnType<typeof vi.fn>;
  };
};

function createUploadTestClient(): UploadTestClient {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D99RESOLVED" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
    files: {
      getUploadURLExternal: vi.fn(async () => ({
        ok: true,
        upload_url: "https://uploads.slack.test/upload",
        file_id: "F001",
      })),
      completeUploadExternal: vi.fn(async () => ({ ok: true })),
    },
  } as unknown as UploadTestClient;
}

describe("sendMessageSlack file upload with user IDs", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    fetchWithSsrFGuard.mockClear();
    loadOutboundMediaFromUrlMock.mockClear();
    clearSlackDmChannelCache();
    clearSlackSendQueuesForTest();
    resetSlackBlockTestAccountConfig();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSlackBlockTestAccountConfig();
    vi.restoreAllMocks();
  });

  it("resolves bare user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    // Bare user ID — parseSlackTarget classifies this as kind="channel"
    await sendMessageSlack("U2ZH3MFSR", "screenshot", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    // Should call conversations.open to resolve user ID → DM channel
    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U2ZH3MFSR",
    });

    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D99RESOLVED",
        files: [expect.objectContaining({ id: "F001", title: "screenshot.png" })],
      }),
    );
  });

  it("resolves prefixed user ID to DM channel before completing upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "image", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/photo.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "UABC123",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("caches DM channel resolution per account", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(1);
    expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "D99RESOLVED",
        text: "second",
      }),
    );
  });

  it("serializes concurrent sends to the same Slack target", async () => {
    const client = createUploadTestClient();
    let resolveFirst!: () => void;
    client.chat.postMessage.mockImplementation(async (payload: { text?: string }) => {
      if (payload.text === "first") {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { ts: "1.000" };
      }
      return { ts: "2.000" };
    });

    const first = sendMessageSlack("channel:C123CHAN", "first", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await vi.waitFor(() => expect(client.chat.postMessage).toHaveBeenCalledTimes(1));

    const second = sendMessageSlack("channel:C123CHAN", "second", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await Promise.resolve();

    expect(client.chat.postMessage).toHaveBeenCalledTimes(1);
    resolveFirst();

    await expect(first).resolves.toEqual({ channelId: "C123CHAN", messageId: "1.000" });
    await expect(second).resolves.toEqual({ channelId: "C123CHAN", messageId: "2.000" });
    expect(client.chat.postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "second" }),
    );
  });

  it("scopes DM channel resolution cache by token identity", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("user:UABC123", "first", {
      token: "xoxb-test-a",
      cfg: SLACK_TEST_CFG,
      client,
    });
    await sendMessageSlack("user:UABC123", "second", {
      token: "xoxb-test-b",
      cfg: SLACK_TEST_CFG,
      client,
    });

    expect(client.conversations.open).toHaveBeenCalledTimes(2);
  });

  it("sends file directly to channel without conversations.open", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "chart", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/chart.png",
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "C123CHAN" }),
    );
  });

  it("resolves mention-style user ID before file upload", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("<@U777TEST>", "report", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/report.png",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({
      users: "U777TEST",
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: "D99RESOLVED" }),
    );
  });

  it("uploads bytes to the presigned URL and completes with thread+caption", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      threadTs: "171.222",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: Buffer.from("fake-image").length,
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://uploads.slack.test/upload",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://uploads.slack.test/upload",
        mode: "trusted_env_proxy",
        auditContext: "slack-upload-file",
      }),
    );
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123CHAN",
        initial_comment: "caption",
        thread_ts: "171.222",
      }),
    );
  });

  it("uses explicit upload filename and title overrides when provided", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
      uploadTitle: "Custom Title",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "Custom Title" })],
      }),
    );
  });

  it("uses uploadFileName as the title fallback when uploadTitle is omitted", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "caption", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/threaded.png",
      uploadFileName: "custom-name.bin",
    });

    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "custom-name.bin",
      length: Buffer.from("fake-image").length,
    });
    expect(client.files.completeUploadExternal).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.objectContaining({ id: "F001", title: "custom-name.bin" })],
      }),
    );
  });

  it("forwards optimizeImages: false and uploads original bytes + MIME when mediaOptimize is disabled", async () => {
    const client = createUploadTestClient();
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngBytes = Buffer.concat([pngSignature, Buffer.from("original-png-payload")]);
    loadOutboundMediaFromUrlMock.mockResolvedValueOnce({
      buffer: pngBytes,
      contentType: "image/png",
      kind: "image",
      fileName: "screenshot.png",
    });
    setSlackBlockTestAccountConfig({ mediaOptimize: false });

    await sendMessageSlack("channel:C123CHAN", "preserve", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    expect(loadOutboundMediaFromUrlMock).toHaveBeenCalledWith(
      "/tmp/screenshot.png",
      expect.objectContaining({ optimizeImages: false }),
    );
    expect(client.files.getUploadURLExternal).toHaveBeenCalledWith({
      filename: "screenshot.png",
      length: pngBytes.length,
    });
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(fetchCall?.[0]).toBe("https://uploads.slack.test/upload");
    const init = fetchCall?.[1] as RequestInit & {
      body: Uint8Array;
      headers: Record<string, string>;
    };
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "image/png" });
    expect(Buffer.from(init.body)).toEqual(pngBytes);
  });

  it("does not forward optimizeImages when mediaOptimize is unset, preserving default optimize behavior", async () => {
    const client = createUploadTestClient();

    await sendMessageSlack("channel:C123CHAN", "default", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    const opts = loadOutboundMediaFromUrlMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("optimizeImages");
  });

  it("does not forward optimizeImages when mediaOptimize is explicitly true (default behavior)", async () => {
    const client = createUploadTestClient();
    setSlackBlockTestAccountConfig({ mediaOptimize: true });

    await sendMessageSlack("channel:C123CHAN", "explicit-true", {
      token: "xoxb-test",
      cfg: SLACK_TEST_CFG,
      client,
      mediaUrl: "/tmp/screenshot.png",
    });

    const opts = loadOutboundMediaFromUrlMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("optimizeImages");
  });
});
