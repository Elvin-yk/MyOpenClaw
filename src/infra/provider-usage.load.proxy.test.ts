import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";

const { withTemporaryEnvProxyGlobalDispatcher } = vi.hoisted(() => ({
  withTemporaryEnvProxyGlobalDispatcher: vi.fn(async <T>(fn: () => Promise<T>) => await fn()),
}));

vi.mock("./net/undici-global-dispatcher.js", () => ({
  withTemporaryEnvProxyGlobalDispatcher,
}));

import { loadProviderUsageSummary } from "./provider-usage.load.js";

describe("loadProviderUsageSummary proxy integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps usage fetches with the temporary env proxy dispatcher", async () => {
    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("chatgpt.com/backend-api/wham/usage")) {
        return makeResponse(200, {
          rate_limit: {
            primary_window: {
              limit_window_seconds: 10_800,
              used_percent: 12,
              reset_at: 1_767_744_800,
            },
          },
        });
      }
      return makeResponse(404, "not found");
    });

    const summary = await loadProviderUsageSummary({
      now: Date.UTC(2026, 0, 7, 0, 0, 0),
      auth: [{ provider: "openai-codex", token: "token-1", accountId: "account-1" }],
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(withTemporaryEnvProxyGlobalDispatcher).toHaveBeenCalledOnce();
    expect(summary.providers).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        windows: [{ label: "3h", usedPercent: 12, resetAt: 1_767_744_800_000 }],
      }),
    ]);
  });
});
