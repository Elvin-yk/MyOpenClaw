import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH } from "../../config/paths.js";
import { normalizeProviderId } from "../model-selection.js";
import type { AuthProfileStore } from "./types.js";

export const AUTH_POOL_FILENAME = "auth-pools.json";
export const CODEX_POOL_PROVIDER = "openai-codex";

export type CodexPoolStatusWindow = {
  label?: string;
  usedPercent?: number;
  resetAt?: number;
};

export type CodexPoolStatusSnapshot = {
  ok?: boolean;
  windows?: CodexPoolStatusWindow[];
};

export type AuthPoolEntry = {
  enabled?: boolean;
  lastStatus?: CodexPoolStatusSnapshot;
};

export type ProviderAuthPool = {
  mode: "auto" | "manual";
  activeProfileId?: string;
  entries: Record<string, AuthPoolEntry>;
};

type AuthPoolsFile = {
  providers?: Record<string, ProviderAuthPool>;
};

function resolveAuthPoolPath(): string {
  return path.join(path.dirname(CONFIG_PATH), AUTH_POOL_FILENAME);
}

function loadAuthPoolsSync(): AuthPoolsFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveAuthPoolPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AuthPoolsFile;
  } catch {
    return null;
  }
}

function saveAuthPoolsSync(pools: AuthPoolsFile): void {
  fs.writeFileSync(resolveAuthPoolPath(), `${JSON.stringify(pools, null, 2)}\n`, "utf8");
}

function clampPoolPercent(value: unknown): number {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.min(100, num));
}

function resolveProviderPoolSync(provider: string): ProviderAuthPool | null {
  const pools = loadAuthPoolsSync();
  const providerPool = pools?.providers?.[provider];
  if (!providerPool || typeof providerPool !== "object" || Array.isArray(providerPool)) {
    return null;
  }
  const entries = providerPool.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return null;
  }
  return {
    mode: providerPool.mode === "manual" ? "manual" : "auto",
    activeProfileId:
      typeof providerPool.activeProfileId === "string" ? providerPool.activeProfileId : undefined,
    entries,
  };
}

function resolveWindowRemainingPercent(
  status: CodexPoolStatusSnapshot | undefined,
  preferredIndex: number,
  preferredLabels: string[],
): number {
  if (!status?.ok || !Array.isArray(status.windows)) {
    return -1;
  }
  const byLabel = status.windows.find((window) =>
    preferredLabels.includes(String(window?.label ?? "").toLowerCase()),
  );
  const selected = byLabel ?? status.windows[preferredIndex];
  if (!selected) {
    return -1;
  }
  return Math.max(0, Math.round(100 - clampPoolPercent(selected.usedPercent)));
}

function compareCodexPoolCandidates(
  a: string,
  b: string,
  providerPool: ProviderAuthPool,
  store: AuthProfileStore,
): number {
  const aEntry = providerPool.entries?.[a];
  const bEntry = providerPool.entries?.[b];
  const aStatus = aEntry?.lastStatus;
  const bStatus = bEntry?.lastStatus;

  const aPrimary = resolveWindowRemainingPercent(aStatus, 0, ["5h", "3h"]);
  const bPrimary = resolveWindowRemainingPercent(bStatus, 0, ["5h", "3h"]);
  if (aPrimary !== bPrimary) {
    return bPrimary - aPrimary;
  }

  const aSecondary = resolveWindowRemainingPercent(aStatus, 1, ["week", "day"]);
  const bSecondary = resolveWindowRemainingPercent(bStatus, 1, ["week", "day"]);
  if (aSecondary !== bSecondary) {
    return bSecondary - aSecondary;
  }

  return (store.usageStats?.[a]?.lastUsed ?? 0) - (store.usageStats?.[b]?.lastUsed ?? 0);
}

function isCodexPoolEntryQuotaExhausted(entry: AuthPoolEntry | undefined): boolean {
  const status = entry?.lastStatus;
  const shortRemaining = resolveWindowRemainingPercent(status, 0, ["5h", "3h"]);
  const longRemaining = resolveWindowRemainingPercent(status, 1, ["week", "day"]);
  return shortRemaining === 0 || longRemaining === 0;
}

export function orderProfilesByCodexPool(
  order: string[],
  store: AuthProfileStore,
): string[] | null {
  const providerPool = resolveProviderPoolSync(CODEX_POOL_PROVIDER);
  if (!providerPool) {
    return null;
  }

  const tracked: string[] = [];
  const untracked: string[] = [];
  const disabled: string[] = [];

  for (const profileId of order) {
    const entry = providerPool.entries?.[profileId];
    if (!entry) {
      untracked.push(profileId);
      continue;
    }
    if (entry.enabled === false) {
      disabled.push(profileId);
      continue;
    }
    if (isCodexPoolEntryQuotaExhausted(entry)) {
      continue;
    }
    tracked.push(profileId);
  }

  if (tracked.length === 0) {
    return null;
  }

  const sortedTracked = tracked.toSorted((a, b) =>
    compareCodexPoolCandidates(a, b, providerPool, store),
  );
  if (
    providerPool.mode === "auto" &&
    providerPool.activeProfileId &&
    sortedTracked.includes(providerPool.activeProfileId)
  ) {
    return [
      providerPool.activeProfileId,
      ...sortedTracked.filter((profileId) => profileId !== providerPool.activeProfileId),
      ...untracked,
      ...disabled,
    ];
  }
  if (
    providerPool.mode === "manual" &&
    providerPool.activeProfileId &&
    tracked.includes(providerPool.activeProfileId)
  ) {
    return [
      providerPool.activeProfileId,
      ...sortedTracked.filter((profileId) => profileId !== providerPool.activeProfileId),
      ...untracked,
      ...disabled,
    ];
  }
  return [...sortedTracked, ...untracked, ...disabled];
}

export function syncProviderPoolActiveProfile(provider: string, profileId: string): void {
  try {
    const pools = loadAuthPoolsSync();
    if (!pools || typeof pools !== "object" || Array.isArray(pools)) {
      return;
    }
    const providerKey = normalizeProviderId(provider);
    const providerPool = pools.providers?.[providerKey];
    if (!providerPool || typeof providerPool !== "object" || Array.isArray(providerPool)) {
      return;
    }
    if (providerPool.mode !== "auto") {
      return;
    }
    const entry = providerPool.entries?.[profileId];
    if (!entry || entry.enabled === false) {
      return;
    }
    if (providerPool.activeProfileId === profileId) {
      return;
    }
    providerPool.activeProfileId = profileId;
    saveAuthPoolsSync(pools);
  } catch {
    // Best effort only. Never break request path on pool metadata sync failure.
  }
}
