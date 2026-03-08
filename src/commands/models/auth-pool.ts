import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatRemainingShort } from "../../agents/auth-health.js";
import { ensureAuthProfileStore, listProfilesForProvider, setAuthProfileOrder } from "../../agents/auth-profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store.js";
import type { AuthProfileCredential, OAuthCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { logConfigUpdated } from "../../config/logging.js";
import { CONFIG_PATH } from "../../config/paths.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { applyAuthProfileConfig } from "../onboard-auth.js";
import { isRemoteEnvironment } from "../oauth-env.js";
import { openUrl } from "../onboard-helpers.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "../openai-codex-model-default.js";
import { loginOpenAICodexOAuth } from "../openai-codex-oauth.js";
import { loadValidConfigOrThrow, resolveKnownAgentId, updateConfig } from "./shared.js";

const AUTH_POOL_FILENAME = "auth-pools.json";
const AUTH_POOL_VERSION = 1;
const CODEX_POOL_PROVIDER = "openai-codex";

type PoolStatusWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

type PoolStatus =
  | {
      ok: true;
      fetchedAt: number;
      plan?: string | null;
      windows: PoolStatusWindow[];
    }
  | {
      ok: false;
      fetchedAt: number;
      status?: number;
      error: string;
    };

type PoolEntry = {
  provider?: string;
  enabled?: boolean;
  label?: string;
  email?: string | null;
  planType?: string | null;
  accountId?: string | null;
  addedAt?: string;
  updatedAt?: string;
  lastStatus?: PoolStatus;
};

type ProviderPool = {
  mode: "auto" | "manual";
  activeProfileId?: string;
  entries: Record<string, PoolEntry>;
};

type AuthPools = {
  version: number;
  providers: Record<string, ProviderPool>;
};

type CodexCredentialMetadata = {
  accountId: string | null;
  email: string | null;
  planType: string | null;
  userId: string | null;
};

type PoolProviderTargetOpts = {
  provider?: string;
  agent?: string;
};

type PoolContext = {
  agentId: string;
  agentDir: string;
  provider: string;
  pools: AuthPools;
  providerPool: ProviderPool;
  store: ReturnType<typeof ensureAuthProfileStore>;
};

type PoolSavedProfile = {
  profileId: string;
  credential: OAuthCredential;
  metadata: CodexCredentialMetadata;
  labelOverride: string | null;
  action: "added" | "already" | "renamed";
  existingLabel: string;
  movedFromProfileId: string | null;
};

function resolveAuthPoolsPath(): string {
  return path.join(path.dirname(CONFIG_PATH), AUTH_POOL_FILENAME);
}

function normalizePoolProvider(rawProvider?: string): string {
  const provider = normalizeProviderId(rawProvider?.trim() || CODEX_POOL_PROVIDER);
  if (provider !== CODEX_POOL_PROVIDER) {
    throw new Error("Only --provider openai-codex is supported for auth pools right now.");
  }
  return provider;
}

function resolveTargetAgent(cfg: Awaited<ReturnType<typeof loadValidConfigOrThrow>>, raw?: string) {
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: raw }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir };
}

function decodeBase64UrlJson(raw: string | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const parts = String(token ?? "").split(".");
  return parts.length >= 2 ? decodeBase64UrlJson(parts[1]) : null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractCodexCredentialMetadata(credential: OAuthCredential): CodexCredentialMetadata {
  const payload = decodeJwtPayload(credential.access);
  const auth = asObject(payload?.["https://api.openai.com/auth"]);
  const profile = asObject(payload?.["https://api.openai.com/profile"]);
  return {
    accountId: asString(credential.accountId) ?? asString(auth?.chatgpt_account_id) ?? null,
    email: asString(profile?.email) ?? asString(credential.email) ?? null,
    planType: asString(auth?.chatgpt_plan_type) ?? null,
    userId: asString(auth?.chatgpt_user_id) ?? null,
  };
}

function inferPoolEntryLabel(params: {
  profileId: string;
  entry?: PoolEntry;
  label?: string;
  email?: string | null;
  planType?: string | null;
  accountId?: string | null;
}): string {
  const preferred = params.label?.trim() || params.entry?.label?.trim();
  if (preferred) {
    return preferred;
  }
  if (params.email && params.accountId) {
    return `${params.email}/workspace-${params.accountId.slice(0, 8)}`;
  }
  if (params.email && params.planType) {
    return `${params.email} (${params.planType})`;
  }
  if (params.email) {
    return params.email;
  }
  if (params.accountId) {
    return `workspace ${params.accountId.slice(0, 8)}`;
  }
  return params.profileId;
}

function inferGeneratedPoolEntryLabel(params: {
  profileId: string;
  email?: string | null;
  planType?: string | null;
  accountId?: string | null;
}): string {
  return inferPoolEntryLabel({
    profileId: params.profileId,
    entry: {},
    label: undefined,
    email: params.email,
    planType: params.planType,
    accountId: params.accountId,
  });
}

function composeWorkspaceLabel(params: {
  raw?: string;
  existing?: string;
  email?: string | null;
}): string | null {
  const raw = params.raw?.trim();
  const existing = params.existing?.trim() || "";
  if (!raw) {
    return existing || null;
  }
  const marker = "/workspace-";
  if (raw.includes(marker)) {
    return raw;
  }
  const markerIndex = existing.indexOf(marker);
  if (markerIndex >= 0) {
    return `${existing.slice(0, markerIndex + marker.length)}${raw}`;
  }
  const email = params.email?.trim();
  if (email) {
    return `${email}${marker}${raw}`;
  }
  return raw;
}

async function maybePromptForWorkspaceLabel(
  prompter: ReturnType<typeof createClackPrompter>,
  params: {
    profileId: string;
    entry?: PoolEntry;
    explicitLabel?: string;
    forcePrompt?: boolean;
    email?: string | null;
    planType?: string | null;
    accountId?: string | null;
  },
): Promise<string | null> {
  const existing = params.entry?.label?.trim() || "";
  const explicit = params.explicitLabel?.trim();
  if (explicit) {
    return composeWorkspaceLabel({
      raw: explicit,
      existing,
      email: params.email,
    });
  }

  const generated = inferGeneratedPoolEntryLabel(params);
  if (!params.forcePrompt && existing && existing !== generated) {
    return existing;
  }

  const suffix = params.accountId ? params.accountId.slice(0, 8) : params.profileId;
  const entered = await prompter.text({
    message: `Workspace name for ${params.email ?? "this account"} (${suffix})`,
    placeholder: existing
      ? `Name shown in browser (Enter keeps: ${existing})`
      : "Name shown in the browser workspace picker",
  });
  const trimmed = entered?.trim() || "";
  if (trimmed) {
    return composeWorkspaceLabel({
      raw: trimmed,
      existing,
      email: params.email,
    });
  }
  return existing || null;
}

async function loadAuthPools(): Promise<AuthPools> {
  try {
    const parsed = JSON.parse(await fs.readFile(resolveAuthPoolsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid auth pool file");
    }
    const providersRaw = asObject((parsed as Record<string, unknown>).providers);
    return {
      version: AUTH_POOL_VERSION,
      providers: (providersRaw as Record<string, ProviderPool>) ?? {},
    };
  } catch {
    return {
      version: AUTH_POOL_VERSION,
      providers: {},
    };
  }
}

async function saveAuthPools(pools: AuthPools): Promise<void> {
  const filePath = resolveAuthPoolsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(
    tmp,
    `${JSON.stringify(
      {
        version: AUTH_POOL_VERSION,
        providers: pools.providers ?? {},
      },
      null,
      2,
    )}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await fs.rename(tmp, filePath);
}

function ensureProviderPool(pools: AuthPools, provider: string): ProviderPool {
  pools.providers =
    pools.providers && typeof pools.providers === "object" && !Array.isArray(pools.providers)
      ? pools.providers
      : {};
  const existing = pools.providers[provider];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    existing.mode = existing.mode === "manual" ? "manual" : "auto";
    existing.entries =
      existing.entries && typeof existing.entries === "object" && !Array.isArray(existing.entries)
        ? existing.entries
        : {};
    return existing;
  }
  const created: ProviderPool = {
    mode: "auto",
    activeProfileId: undefined,
    entries: {},
  };
  pools.providers[provider] = created;
  return created;
}

function resolvePoolProfileIds(providerPool: ProviderPool): string[] {
  const base = Object.entries(providerPool.entries ?? {})
    .filter(([, entry]) => entry?.enabled !== false)
    .map(([profileId]) => profileId);
  if (
    providerPool.mode === "manual" &&
    providerPool.activeProfileId &&
    base.includes(providerPool.activeProfileId)
  ) {
    return [
      providerPool.activeProfileId,
      ...base.filter((profileId) => profileId !== providerPool.activeProfileId),
    ];
  }
  return base;
}

async function syncPoolOrder(
  agentDir: string,
  provider: string,
  providerPool: ProviderPool,
): Promise<void> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const available = new Set(listProfilesForProvider(store, provider));
  const order = resolvePoolProfileIds(providerPool).filter((profileId) => available.has(profileId));
  await setAuthProfileOrder({
    agentDir,
    provider,
    order: order.length > 0 ? order : null,
  });
}

async function persistPoolOAuthProfile(
  agentDir: string,
  profileId: string,
  credential: OAuthCredential,
): Promise<OAuthCredential> {
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      store.profiles = store.profiles ?? {};
      store.profiles[profileId] = credential;
      return true;
    },
  });
  const saved = updated?.profiles?.[profileId];
  if (!saved || saved.type !== "oauth") {
    throw new Error(`Failed to persist auth profile "${profileId}".`);
  }
  return saved as OAuthCredential;
}

function syncCodexPoolEntriesFromStore(params: {
  cfg: Awaited<ReturnType<typeof loadValidConfigOrThrow>>;
  store: ReturnType<typeof ensureAuthProfileStore>;
  providerPool: ProviderPool;
}): boolean {
  const { cfg, store, providerPool } = params;
  let mutated = false;
  const now = new Date().toISOString();
  const known = new Set(listProfilesForProvider(store, CODEX_POOL_PROVIDER));

  for (const [profileId] of Object.entries(providerPool.entries ?? {})) {
    if (!known.has(profileId)) {
      delete providerPool.entries[profileId];
      if (providerPool.activeProfileId === profileId) {
        providerPool.activeProfileId = undefined;
      }
      mutated = true;
    }
  }

  for (const profileId of known) {
    const credential = store.profiles[profileId];
    if (!credential || credential.type !== "oauth") {
      continue;
    }
    const existing = providerPool.entries[profileId] ?? {};
    const metadata = extractCodexCredentialMetadata(credential as OAuthCredential);
    const emailFromConfig = cfg.auth?.profiles?.[profileId]?.email?.trim();
    const next: PoolEntry = {
      ...existing,
      provider: CODEX_POOL_PROVIDER,
      enabled: existing.enabled !== false,
      accountId: metadata.accountId ?? existing.accountId ?? null,
      email: metadata.email ?? emailFromConfig ?? existing.email ?? null,
      planType: metadata.planType ?? existing.planType ?? null,
      label: inferPoolEntryLabel({
        profileId,
        entry: existing,
        email: metadata.email ?? emailFromConfig ?? existing.email ?? null,
        planType: metadata.planType ?? existing.planType ?? null,
        accountId: metadata.accountId ?? existing.accountId ?? null,
      }),
      addedAt: existing.addedAt ?? now,
      updatedAt: now,
    };
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      providerPool.entries[profileId] = next;
      mutated = true;
    }
  }
  return mutated;
}

function resolveExistingPoolProfileIdByAccount(
  store: ReturnType<typeof ensureAuthProfileStore>,
  providerPool: ProviderPool,
  accountId: string | null,
): string | null {
  if (!accountId) {
    return null;
  }
  for (const profileId of listProfilesForProvider(store, CODEX_POOL_PROVIDER)) {
    const credential = store.profiles[profileId];
    if (!credential) {
      continue;
    }
    if (credential.accountId?.trim() === accountId) {
      return profileId;
    }
    const entryAccountId = providerPool.entries?.[profileId]?.accountId?.trim();
    if (entryAccountId === accountId) {
      return profileId;
    }
  }
  return null;
}

function sanitizeProfileIdPart(raw: string): string {
  return (
    String(raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || crypto.randomUUID().slice(0, 8)
  );
}

function resolveGeneratedCodexPoolProfileId(accountId: string | null): string {
  return `openai-codex:pool:${sanitizeProfileIdPart(accountId ?? crypto.randomUUID().slice(0, 8))}`;
}

function clampPercent(value: unknown): number {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? "0"));
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.min(100, num));
}

function resolveSecondaryWindowLabel(windowHours: number): string {
  if (windowHours >= 24 * 6 && windowHours <= 24 * 8) {
    return "Week";
  }
  if (windowHours === 24) {
    return "Day";
  }
  return `${windowHours}h`;
}

async function fetchCodexPoolStatus(
  credential: AuthProfileCredential | undefined,
  timeoutMs: number,
): Promise<PoolStatus> {
  const fetchedAt = Date.now();
  if (!credential || credential.type !== "oauth" || !credential.access?.trim()) {
    return {
      ok: false,
      fetchedAt,
      error: "missing OAuth access token",
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.access}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
  if (credential.accountId?.trim()) {
    headers["ChatGPT-Account-Id"] = credential.accountId.trim();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        fetchedAt,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }
    const data = (await response.json()) as {
      plan_type?: string;
      credits?: { balance?: number | string };
      rate_limit?: {
        primary_window?: { limit_window_seconds?: number; used_percent?: number; reset_at?: number };
        secondary_window?: {
          limit_window_seconds?: number;
          used_percent?: number;
          reset_at?: number;
        };
      };
    };
    const windows: PoolStatusWindow[] = [];
    if (data.rate_limit?.primary_window) {
      const primary = data.rate_limit.primary_window;
      const windowHours = Math.round((primary.limit_window_seconds || 10_800) / 3600);
      windows.push({
        label: `${windowHours}h`,
        usedPercent: clampPercent(primary.used_percent || 0),
        resetAt: primary.reset_at ? primary.reset_at * 1000 : undefined,
      });
    }
    if (data.rate_limit?.secondary_window) {
      const secondary = data.rate_limit.secondary_window;
      const windowHours = Math.round((secondary.limit_window_seconds || 86_400) / 3600);
      windows.push({
        label: resolveSecondaryWindowLabel(windowHours),
        usedPercent: clampPercent(secondary.used_percent || 0),
        resetAt: secondary.reset_at ? secondary.reset_at * 1000 : undefined,
      });
    }

    let plan = data.plan_type;
    if (data.credits?.balance !== undefined && data.credits.balance !== null) {
      const balance =
        typeof data.credits.balance === "number"
          ? data.credits.balance
          : Number.parseFloat(String(data.credits.balance ?? "0")) || 0;
      plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
    }
    return {
      ok: true,
      fetchedAt,
      plan: plan ?? null,
      windows,
    };
  } catch (error) {
    return {
      ok: false,
      fetchedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeStatusWindow(window: PoolStatusWindow | undefined): string | null {
  if (!window) {
    return null;
  }
  const remaining = Math.max(0, Math.min(100, Math.round(100 - clampPercent(window.usedPercent))));
  const resetText = window.resetAt
    ? `, resets ${formatRemainingShort(window.resetAt - Date.now(), { underMinuteLabel: "soon" })}`
    : "";
  return `${window.label}: ${remaining}% left${resetText}`;
}

function describePoolStatus(entry: PoolEntry | undefined): string {
  const status = entry?.lastStatus;
  if (!status) {
    return "no cached quota snapshot";
  }
  if (!status.ok) {
    return `quota check failed: ${status.error ?? "unknown error"}`;
  }
  const windows = (status.windows ?? [])
    .map((window) => describeStatusWindow(window))
    .filter((window): window is string => Boolean(window));
  return windows.length > 0 ? windows.join(" | ") : "quota status available";
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function applyAuthProfileConfigWithEmail(
  cfg: Awaited<ReturnType<typeof loadValidConfigOrThrow>>,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
    email?: string;
  },
): Awaited<ReturnType<typeof loadValidConfigOrThrow>> {
  const next = applyAuthProfileConfig(cfg, {
    profileId: params.profileId,
    provider: params.provider,
    mode: params.mode,
  });
  if (!params.email?.trim()) {
    return next;
  }
  return {
    ...next,
    auth: {
      ...next.auth,
      profiles: {
        ...next.auth?.profiles,
        [params.profileId]: {
          ...next.auth?.profiles?.[params.profileId],
          email: params.email.trim(),
        },
      },
    },
  };
}

function removeAuthProfileConfigEntry(
  cfg: Awaited<ReturnType<typeof loadValidConfigOrThrow>>,
  profileId: string,
): Awaited<ReturnType<typeof loadValidConfigOrThrow>> {
  if (!cfg.auth?.profiles?.[profileId]) {
    return cfg;
  }
  const nextProfiles = { ...cfg.auth.profiles };
  delete nextProfiles[profileId];
  const nextAuth = {
    ...cfg.auth,
    ...(Object.keys(nextProfiles).length > 0 ? { profiles: nextProfiles } : { profiles: undefined }),
  };
  return {
    ...cfg,
    auth: nextAuth,
  };
}

async function resolveCodexPoolContext(opts: PoolProviderTargetOpts): Promise<PoolContext> {
  const provider = normalizePoolProvider(opts.provider);
  const cfg = await loadValidConfigOrThrow();
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const pools = await loadAuthPools();
  const providerPool = ensureProviderPool(pools, provider);

  if (syncCodexPoolEntriesFromStore({ cfg, store, providerPool })) {
    await saveAuthPools(pools);
    await syncPoolOrder(agentDir, provider, providerPool);
  }

  return {
    agentId,
    agentDir,
    provider,
    pools,
    providerPool,
    store: ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false }),
  };
}

export async function modelsAuthPoolAddCommand(
  opts: {
    provider?: string;
    profileId?: string;
    label?: string;
    activate?: boolean;
    setDefault?: boolean;
    timeout?: string;
  },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("models auth pool add requires an interactive TTY.");
  }

  const provider = normalizePoolProvider(opts.provider);
  const config = await loadValidConfigOrThrow();
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, defaultAgentId);
  const prompter = createClackPrompter();
  const timeoutMs = Number.parseInt(String(opts.timeout ?? "10000"), 10) || 10_000;

  const creds = await loginOpenAICodexOAuth({
    prompter,
    runtime,
    isRemote: isRemoteEnvironment(),
    openUrl: async (url) => {
      await openUrl(url);
    },
    localBrowserMessage: "Complete sign-in in browser…",
  });
  if (!creds) {
    throw new Error("OpenAI Codex OAuth did not return credentials.");
  }

  const oauthCredential: OAuthCredential = {
    type: "oauth",
    provider,
    ...creds,
  };

  const pools = await loadAuthPools();
  const providerPool = ensureProviderPool(pools, provider);
  const storeBefore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });

  const metadata = extractCodexCredentialMetadata(oauthCredential);
  const matchedExistingProfileId = resolveExistingPoolProfileIdByAccount(
    storeBefore,
    providerPool,
    metadata.accountId,
  );
  const generatedProfileId = resolveGeneratedCodexPoolProfileId(metadata.accountId);
  const requestedProfileId = opts.profileId?.trim();
  const shouldMigrateDefaultToPool =
    !requestedProfileId && matchedExistingProfileId === `${CODEX_POOL_PROVIDER}:default`;
  const targetProfileId =
    requestedProfileId ||
    (shouldMigrateDefaultToPool
      ? generatedProfileId
      : matchedExistingProfileId || generatedProfileId);
  const movedFromProfileId = shouldMigrateDefaultToPool ? matchedExistingProfileId : null;
  const existingEntry =
    providerPool.entries[targetProfileId] ??
    (movedFromProfileId ? providerPool.entries[movedFromProfileId] : undefined);
  const existingLabel = existingEntry?.label?.trim() || "";
  const hitExistingProfile = Boolean(
    existingEntry || storeBefore.profiles?.[targetProfileId] || matchedExistingProfileId,
  );
  const labelOverride = await maybePromptForWorkspaceLabel(prompter, {
    profileId: targetProfileId,
    entry: existingEntry,
    explicitLabel: opts.label,
    forcePrompt: hitExistingProfile,
    email: metadata.email,
    planType: metadata.planType,
    accountId: metadata.accountId,
  });

  const persistedCredential = await persistPoolOAuthProfile(agentDir, targetProfileId, oauthCredential);
  if (movedFromProfileId && movedFromProfileId !== targetProfileId) {
    await updateAuthProfileStoreWithLock({
      agentDir,
      updater: (store) => {
        let changed = false;
        if (store.profiles?.[movedFromProfileId]) {
          delete store.profiles[movedFromProfileId];
          changed = true;
        }
        if (store.usageStats?.[movedFromProfileId]) {
          delete store.usageStats[movedFromProfileId];
          if (Object.keys(store.usageStats).length === 0) {
            store.usageStats = undefined;
          }
          changed = true;
        }
        const providerKey = normalizeProviderId(provider);
        if (store.lastGood && providerKey in store.lastGood && store.lastGood[providerKey] === movedFromProfileId) {
          delete store.lastGood[providerKey];
          if (Object.keys(store.lastGood).length === 0) {
            store.lastGood = undefined;
          }
          changed = true;
        }
        return changed;
      },
    });
  }

  const nextLabel = labelOverride?.trim() || existingLabel;
  let action: "added" | "already" | "renamed" = "added";
  if (hitExistingProfile) {
    action = nextLabel && existingLabel === nextLabel ? "already" : "renamed";
  }
  const savedProfiles: PoolSavedProfile[] = [
    {
      profileId: targetProfileId,
      credential: persistedCredential,
      metadata,
      labelOverride,
      action,
      existingLabel,
      movedFromProfileId,
    },
  ];

  await updateConfig((cfg) => {
    let next = cfg;
    for (const profile of savedProfiles) {
      if (profile.movedFromProfileId && profile.movedFromProfileId !== profile.profileId) {
        next = removeAuthProfileConfigEntry(next, profile.movedFromProfileId);
      }
      next = applyAuthProfileConfigWithEmail(next, {
        profileId: profile.profileId,
        provider,
        mode: credentialMode(profile.credential),
        email: profile.metadata.email ?? undefined,
      });
    }
    if (opts.setDefault) {
      next = applyOpenAICodexModelDefault(next).next;
    }
    return next;
  });

  const refreshedStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  for (const profile of savedProfiles) {
    if (!refreshedStore.profiles?.[profile.profileId]) {
      throw new Error(`Auth profile "${profile.profileId}" was not found after persistence.`);
    }
  }
  syncCodexPoolEntriesFromStore({
    cfg: await loadValidConfigOrThrow(),
    store: refreshedStore,
    providerPool,
  });

  for (const profile of savedProfiles) {
    if (profile.movedFromProfileId && profile.movedFromProfileId !== profile.profileId) {
      delete providerPool.entries[profile.movedFromProfileId];
      if (providerPool.activeProfileId === profile.movedFromProfileId) {
        providerPool.activeProfileId = profile.profileId;
      }
    }

    const entry = providerPool.entries[profile.profileId] ?? {};
    entry.label = inferPoolEntryLabel({
      profileId: profile.profileId,
      entry,
      label: profile.labelOverride ?? undefined,
      email: profile.metadata.email,
      planType: profile.metadata.planType,
      accountId: profile.metadata.accountId,
    });
    entry.enabled = true;
    entry.accountId = profile.metadata.accountId ?? entry.accountId ?? null;
    entry.email = profile.metadata.email ?? entry.email ?? null;
    entry.planType = profile.metadata.planType ?? entry.planType ?? null;
    entry.addedAt = entry.addedAt ?? new Date().toISOString();
    entry.updatedAt = new Date().toISOString();
    entry.lastStatus = await fetchCodexPoolStatus(profile.credential, timeoutMs);
    providerPool.entries[profile.profileId] = entry;
  }

  if (!providerPool.activeProfileId) {
    providerPool.activeProfileId = savedProfiles[0].profileId;
  }
  if (opts.activate) {
    providerPool.mode = "manual";
    providerPool.activeProfileId = savedProfiles[0].profileId;
  }

  await saveAuthPools(pools);
  await syncPoolOrder(agentDir, provider, providerPool);

  logConfigUpdated(runtime);
  runtime.log(`Pool provider: ${provider}`);
  for (const profile of savedProfiles) {
    const entry = providerPool.entries[profile.profileId];
    if (profile.action === "renamed") {
      runtime.log(
        `Renamed profile: ${profile.profileId}${
          profile.existingLabel
            ? ` (${profile.existingLabel} -> ${entry?.label ?? profile.profileId})`
            : ` (${entry?.label ?? profile.profileId})`
        }`,
      );
    } else if (profile.action === "already") {
      runtime.log(
        `Profile already in pool: ${profile.profileId}${entry?.label ? ` (${entry.label})` : ""}`,
      );
    } else {
      runtime.log(`Added profile: ${profile.profileId}${entry?.label ? ` (${entry.label})` : ""}`);
    }
    runtime.log(`Quota: ${describePoolStatus(entry)}`);
  }

  if (opts.setDefault) {
    runtime.log(`Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`);
  } else {
    runtime.log(
      `Default model available: ${OPENAI_CODEX_DEFAULT_MODEL} (use --set-default to apply)`,
    );
  }
}

export async function modelsAuthPoolListCommand(
  opts: {
    provider?: string;
    agent?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider, providerPool } = await resolveCodexPoolContext(opts);
  const entries = Object.entries(providerPool.entries ?? {}).map(([profileId, entry]) => ({
    profileId,
    label: entry?.label ?? profileId,
    email: entry?.email ?? null,
    planType: entry?.planType ?? null,
    accountId: entry?.accountId ?? null,
    enabled: entry?.enabled !== false,
    active: providerPool.activeProfileId === profileId,
    lastStatus: entry?.lastStatus ?? null,
  }));

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          agentDir,
          provider,
          mode: providerPool.mode,
          activeProfileId: providerPool.activeProfileId ?? null,
          profiles: entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Mode: ${providerPool.mode}`);
  runtime.log(`Active: ${providerPool.activeProfileId ?? "(none)"}`);
  if (entries.length === 0) {
    runtime.log("Profiles: (none)");
    return;
  }
  for (const entry of entries) {
    runtime.log(
      `- ${entry.profileId}${entry.active ? " [active]" : ""}${entry.enabled ? "" : " [disabled]"}${
        entry.label && entry.label !== entry.profileId ? ` - ${entry.label}` : ""
      }`,
    );
  }
}

export async function modelsAuthPoolStatusCommand(
  opts: {
    provider?: string;
    agent?: string;
    profileId?: string;
    cached?: boolean;
    timeout?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider, store, pools, providerPool } = await resolveCodexPoolContext(opts);
  const requested = opts.profileId
    ? String(opts.profileId)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : resolvePoolProfileIds(providerPool);
  const targetProfileIds = requested.length > 0 ? requested : Object.keys(providerPool.entries ?? {});
  if (targetProfileIds.length === 0) {
    throw new Error(
      `No auth pool profiles found. Add one with \`${formatCliCommand("openclaw models auth pool add --provider openai-codex")}\`.`,
    );
  }

  const timeoutMs = Number.parseInt(String(opts.timeout ?? "10000"), 10) || 10_000;
  for (const profileId of targetProfileIds) {
    if (!providerPool.entries[profileId]) {
      throw new Error(`Auth pool profile "${profileId}" not found.`);
    }
    const credential = store.profiles[profileId];
    if (!credential) {
      throw new Error(`Auth profile "${profileId}" not found in ${agentDir}.`);
    }
    if (!opts.cached) {
      providerPool.entries[profileId].lastStatus = await fetchCodexPoolStatus(credential, timeoutMs);
      providerPool.entries[profileId].updatedAt = new Date().toISOString();
    }
  }

  if (!opts.cached) {
    await saveAuthPools(pools);
  }

  const statuses = targetProfileIds.map((profileId) => ({
    profileId,
    label: providerPool.entries[profileId]?.label ?? profileId,
    active: providerPool.activeProfileId === profileId,
    enabled: providerPool.entries[profileId]?.enabled !== false,
    email: providerPool.entries[profileId]?.email ?? null,
    planType: providerPool.entries[profileId]?.planType ?? null,
    accountId: providerPool.entries[profileId]?.accountId ?? null,
    status: providerPool.entries[profileId]?.lastStatus ?? null,
  }));

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          agentDir,
          provider,
          mode: providerPool.mode,
          activeProfileId: providerPool.activeProfileId ?? null,
          profiles: statuses,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Mode: ${providerPool.mode}`);
  runtime.log(`Active: ${providerPool.activeProfileId ?? "(none)"}`);
  for (const entry of statuses) {
    runtime.log(
      `- ${entry.profileId}${entry.active ? " [active]" : ""}${
        entry.label && entry.label !== entry.profileId ? ` - ${entry.label}` : ""
      }: ${describePoolStatus(providerPool.entries[entry.profileId])}`,
    );
  }
}

export async function modelsAuthPoolActivateCommand(
  opts: {
    provider?: string;
    agent?: string;
    profileId: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider, pools, providerPool } = await resolveCodexPoolContext(opts);
  const profileId = String(opts.profileId ?? "").trim();
  if (!profileId) {
    throw new Error("Missing profile id.");
  }
  if (!providerPool.entries[profileId]) {
    throw new Error(`Auth pool profile "${profileId}" not found.`);
  }
  providerPool.mode = "manual";
  providerPool.activeProfileId = profileId;
  await saveAuthPools(pools);
  await syncPoolOrder(agentDir, provider, providerPool);

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log("Mode: manual");
  runtime.log(`Active profile: ${profileId}`);
}

export async function modelsAuthPoolAutoCommand(
  opts: {
    provider?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider, pools, providerPool } = await resolveCodexPoolContext(opts);
  providerPool.mode = "auto";
  await saveAuthPools(pools);
  await syncPoolOrder(agentDir, provider, providerPool);

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log("Mode: auto");
}

export async function modelsAuthPoolRemoveCommand(
  opts: {
    provider?: string;
    agent?: string;
    profileId: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider, pools, providerPool } = await resolveCodexPoolContext(opts);
  const profileId = String(opts.profileId ?? "").trim();
  if (!profileId) {
    throw new Error("Missing profile id.");
  }
  if (!providerPool.entries[profileId]) {
    throw new Error(`Auth pool profile "${profileId}" not found.`);
  }

  delete providerPool.entries[profileId];
  if (providerPool.activeProfileId === profileId) {
    providerPool.activeProfileId = resolvePoolProfileIds(providerPool)[0];
  }

  await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (store) => {
      if (!store.profiles[profileId] && !store.usageStats?.[profileId]) {
        return false;
      }
      delete store.profiles[profileId];
      if (store.usageStats) {
        delete store.usageStats[profileId];
        if (Object.keys(store.usageStats).length === 0) {
          store.usageStats = undefined;
        }
      }
      const providerKey = normalizeProviderId(provider);
      if (store.lastGood && providerKey in store.lastGood && store.lastGood[providerKey] === profileId) {
        delete store.lastGood[providerKey];
      }
      if (store.lastGood && Object.keys(store.lastGood).length === 0) {
        store.lastGood = undefined;
      }
      return true;
    },
  });

  await updateConfig((cfg) => removeAuthProfileConfigEntry(cfg, profileId));
  await saveAuthPools(pools);
  await syncPoolOrder(agentDir, provider, providerPool);

  logConfigUpdated(runtime);
  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Removed profile: ${profileId}`);
}
