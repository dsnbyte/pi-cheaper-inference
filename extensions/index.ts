import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderModelConfig,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROVIDER_ID = "cheaper-inference";
const PROVIDER_NAME = "Cheaper Inference";
const BASE_URL = "https://api.cheaperinference.com/v1";
const API_KEY_ENV = "$CHEAPER_INFERENCE_API_KEY";
const DEFAULT_CONTEXT = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;

export interface CheaperInferenceOptions {
  configPath?: string;
}

interface CheaperInferenceConfig {
  models: ProviderModelConfig[];
}

interface CatalogCache {
  fetchedAt: number;
  models: CatalogModel[];
}

export interface CatalogModel {
  id: string;
  context_length?: number | null;
  max_output_tokens?: number | null;
  owned_by?: string;
  provider?: string | null;
  type?: string;
  endpoint?: string;
  supported_endpoints?: string[];
  capabilities?: {
    vision?: boolean;
    video?: boolean;
    reasoning?: boolean;
    streaming?: boolean;
    image_generation?: boolean;
    image_edit?: boolean;
  };
  is_free?: boolean;
  pricing?: {
    currency?: string;
    input_per_million?: string;
    output_per_million?: string;
    cache_read_input_per_million?: string;
    cache_write_input_per_million?: string;
    cache_read_per_million?: string;
    cache_write_per_million?: string;
    discount_percent?: string;
  };
}

function resolveConfigFile(options?: CheaperInferenceOptions): string {
  if (options?.configPath) {
    return options.configPath;
  }
  return join(getAgentDir(), "cheaper-inference.json");
}

function resolveCacheFile(configFile: string): string {
  return configFile.endsWith(".json")
    ? `${configFile.slice(0, -5)}-cache.json`
    : `${configFile}-cache.json`;
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function writeJsonFile(filePath: string, data: unknown): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
    // Gracefully ignore write failures (e.g. read-only filesystem)
  }
}

function loadConfig(configFile: string): CheaperInferenceConfig {
  try {
    const cfg = readJsonObject(configFile);
    if (!cfg) {
      return { models: [] };
    }
    const models = Array.isArray(cfg.models)
      ? cfg.models.filter(
          (m): m is ProviderModelConfig =>
            Boolean(m && typeof m === "object" && typeof (m as ProviderModelConfig).id === "string"),
        )
      : [];
    return { models };
  } catch {
    return { models: [] };
  }
}

function saveConfig(configFile: string, cfg: CheaperInferenceConfig): void {
  writeJsonFile(configFile, cfg);
}

function loadCatalogCache(cacheFile: string): CatalogCache | undefined {
  try {
    const obj = readJsonObject(cacheFile);
    if (!obj) {
      return undefined;
    }
    const fetchedAt = obj.fetchedAt;
    if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) {
      return undefined;
    }
    if (!Array.isArray(obj.models)) {
      return undefined;
    }
    const models = obj.models.filter(
      (m): m is CatalogModel =>
        Boolean(m && typeof m === "object" && typeof (m as CatalogModel).id === "string"),
    );
    return { fetchedAt, models };
  } catch {
    return undefined;
  }
}

function saveCatalogCache(cacheFile: string, cache: CatalogCache): void {
  writeJsonFile(cacheFile, cache);
}

function isCatalogCacheFresh(cache: CatalogCache | undefined, now = Date.now()): cache is CatalogCache {
  if (!cache) {
    return false;
  }
  const age = now - cache.fetchedAt;
  return age >= 0 && age < CATALOG_CACHE_TTL_MS;
}

function parsePrice(value: string | undefined | null): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function toPiModel(m: CatalogModel): ProviderModelConfig {
  const reasoning = Boolean(m.capabilities?.reasoning);
  const vision = Boolean(m.capabilities?.vision);
  const contextWindow =
    typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : DEFAULT_CONTEXT;
  const rawMaxTokens =
    typeof m.max_output_tokens === "number" && m.max_output_tokens > 0
      ? m.max_output_tokens
      : DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(rawMaxTokens, contextWindow);

  const compat: Record<string, unknown> = {};
  if (reasoning) {
    compat.supportsReasoningEffort = true;
    compat.thinkingFormat = "openai";
  }
  if (m.id.startsWith("claude")) {
    compat.cacheControlFormat = "anthropic";
  }

  return {
    type: "chat",
    id: m.id,
    name: m.id,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: {
      input: parsePrice(m.pricing?.input_per_million),
      output: parsePrice(m.pricing?.output_per_million),
      cacheRead: parsePrice(m.pricing?.cache_read_input_per_million ?? m.pricing?.cache_read_per_million),
      cacheWrite: parsePrice(m.pricing?.cache_write_input_per_million ?? m.pricing?.cache_write_per_million),
    },
    contextWindow,
    maxTokens,
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
  };
}

async function fetchCatalog(apiKey: string, signal?: AbortSignal): Promise<CatalogModel[]> {
  const response = await fetch(`${BASE_URL}/models?type=text`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) {
        message = body.error.message;
      }
    } catch {
      // Fall back to HTTP status message
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as { data?: CatalogModel[] };
  const items = Array.isArray(payload?.data) ? payload.data : [];

  return items
    .filter(
      (m) =>
        Boolean(m?.id) &&
        (m.endpoint === "/v1/chat/completions" ||
          (Array.isArray(m.supported_endpoints) && m.supported_endpoints.includes("/v1/chat/completions"))),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function formatContext(tokens?: number | null): string {
  const ctx = typeof tokens === "number" && tokens > 0 ? tokens : DEFAULT_CONTEXT;
  if (ctx >= 1_000_000) {
    const m = ctx / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(ctx / 1000)}K`;
}

function formatPriceDollar(value: string | undefined): string {
  const n = parsePrice(value);
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${n.toFixed(2)}`;
}

function formatModelMeta(m: CatalogModel): string {
  const ctx = formatContext(m.context_length);
  const price = m.is_free
    ? "free"
    : `${formatPriceDollar(m.pricing?.input_per_million)}/${formatPriceDollar(m.pricing?.output_per_million)}`;
  const flags: string[] = [];
  if (m.capabilities?.reasoning) flags.push("reasoning");
  if (m.capabilities?.vision) flags.push("vision");
  const flagStr = flags.length > 0 ? ` · ${flags.join(", ")}` : "";
  return `${ctx} · ${price}${flagStr}`;
}

function formatKeyHint(th: Theme, key: string, desc: string): string {
  return th.fg("accent", key) + th.fg("dim", ` ${desc}`);
}

interface PickerResult {
  selected: Set<string>;
  activateModelId?: string;
}

class ModelPickerComponent implements Component {
  private catalog: CatalogModel[];
  private selected: Set<string>;
  private tui: TUI;
  private theme: Theme;
  private onDone: (result: PickerResult | undefined) => void;
  private onRefresh?: (signal: AbortSignal) => Promise<CatalogModel[]>;
  private cursorIndex = 0;
  private scrollTop = 0;
  private filterText = "";
  private isRefreshing = false;
  private statusMessage?: string;
  private refreshController?: AbortController;
  private closed = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    catalog: CatalogModel[],
    selectedIds: Set<string>,
    tui: TUI,
    theme: Theme,
    onDone: (result: PickerResult | undefined) => void,
    onRefresh?: (signal: AbortSignal) => Promise<CatalogModel[]>,
  ) {
    this.catalog = catalog;
    this.selected = new Set(selectedIds);
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.onRefresh = onRefresh;
  }

  private getFiltered(): CatalogModel[] {
    if (!this.filterText) return this.catalog;
    const kw = this.filterText.toLowerCase();
    return this.catalog.filter(
      (m) =>
        m.id.toLowerCase().includes(kw) ||
        (m.owned_by && m.owned_by.toLowerCase().includes(kw)) ||
        (m.provider && m.provider.toLowerCase().includes(kw)),
    );
  }

  private close(result: PickerResult | undefined): void {
    this.closed = true;
    this.refreshController?.abort();
    this.onDone(result);
  }

  private triggerRefresh(): void {
    if (this.isRefreshing || !this.onRefresh) {
      return;
    }

    this.isRefreshing = true;
    this.statusMessage = undefined;
    this.invalidate();
    this.tui.requestRender();

    const controller = new AbortController();
    this.refreshController = controller;

    void this.onRefresh(controller.signal)
      .then((models) => {
        if (this.closed || controller.signal.aborted) return;
        this.catalog = models;
        this.statusMessage = `Refreshed (${models.length} models)`;
      })
      .catch((err: unknown) => {
        if (this.closed || controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        this.statusMessage = `Refresh failed: ${message}`;
      })
      .finally(() => {
        if (this.refreshController === controller) {
          this.refreshController = undefined;
        }
        if (this.closed) return;
        this.isRefreshing = false;
        this.invalidate();
        this.tui.requestRender();
      });
  }

  dispose(): void {
    this.closed = true;
    this.refreshController?.abort();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const termRows = this.tui.terminal?.rows || process.stdout.rows || 24;
    const filtered = this.getFiltered();
    const lines: string[] = [];

    lines.push(th.fg("borderMuted", "─".repeat(width)));
    const filterInfo = this.filterText ? ` [Filter: "${this.filterText}"]` : "";
    const statusInfo = this.isRefreshing
      ? th.fg("accent", " · Refreshing...")
      : this.statusMessage
        ? th.fg(this.statusMessage.startsWith("Refresh failed:") ? "warning" : "dim", ` · ${this.statusMessage}`)
        : "";
    const header =
      th.fg("muted", ` Cheaper Inference Models (`) +
      th.fg("accent", `${this.selected.size}`) +
      th.fg("muted", `/${this.catalog.length} selected)${filterInfo}`) +
      statusInfo;
    lines.push(truncateToWidth(header, width - 2, ""));
    lines.push(th.fg("borderMuted", "─".repeat(width)));

    const maxVisibleRows = Math.max(6, Math.min(20, termRows - 8));

    if (filtered.length === 0) {
      const emptyMsg = this.filterText
        ? `  (No models matching "${this.filterText}")`
        : "  (No compatible models available)";
      lines.push(th.fg("dim", emptyMsg));
      for (let i = 1; i < maxVisibleRows; i++) {
        lines.push("");
      }
    } else {
      this.cursorIndex = Math.max(0, Math.min(filtered.length - 1, this.cursorIndex));
      if (this.cursorIndex < this.scrollTop) {
        this.scrollTop = this.cursorIndex;
      } else if (this.cursorIndex >= this.scrollTop + maxVisibleRows) {
        this.scrollTop = this.cursorIndex - maxVisibleRows + 1;
      }
      const maxScrollTop = Math.max(0, filtered.length - maxVisibleRows);
      if (this.scrollTop > maxScrollTop) {
        this.scrollTop = maxScrollTop;
      }

      const start = this.scrollTop;
      const end = Math.min(filtered.length, start + maxVisibleRows);

      for (let i = start; i < end; i++) {
        const model = filtered[i];
        const isCursor = i === this.cursorIndex;
        const isChecked = this.selected.has(model.id);

        const pointer = isCursor ? th.fg("accent", "▸ ") : "  ";
        const marker = isChecked ? th.fg("accent", "[x]") : th.fg("dim", "[ ]");
        const idText = isCursor ? th.bold(th.fg("accent", model.id)) : th.fg("muted", model.id);
        const metaText = th.fg("dim", `  ${formatModelMeta(model)}`);

        lines.push(truncateToWidth(`${pointer}${marker} ${idText}${metaText}`, width - 2));
      }

      for (let i = end - start; i < maxVisibleRows; i++) {
        lines.push("");
      }
    }

    lines.push(th.fg("borderMuted", "─".repeat(width)));
    const scrollPos = filtered.length > 0 ? ` (${this.cursorIndex + 1}/${filtered.length})` : "";
    const hints = [
      formatKeyHint(th, "↑↓", "move"),
      formatKeyHint(th, "space", "toggle"),
      formatKeyHint(th, "enter", "use & close"),
      formatKeyHint(th, "type", "to search"),
      formatKeyHint(th, "ctrl+r", this.isRefreshing ? "refreshing" : "refresh"),
      formatKeyHint(th, "esc", "save & close"),
    ].join(th.fg("dim", " · "));
    lines.push(truncateToWidth(`  ${hints}${th.fg("dim", scrollPos)}`, width - 2, ""));
    lines.push(th.fg("borderMuted", "─".repeat(width)));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  handleInput(data: string): void {
    const filtered = this.getFiltered();

    if (matchesKey(data, "escape")) {
      this.close({ selected: new Set(this.selected) });
      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.close(undefined);
      return;
    }

    if (matchesKey(data, "ctrl+r") || matchesKey(data, "f5")) {
      this.triggerRefresh();
      return;
    }

    this.statusMessage = undefined;

    if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
      const model = filtered[this.cursorIndex];
      if (model) {
        this.selected.add(model.id);
        this.close({ selected: new Set(this.selected), activateModelId: model.id });
      }
      return;
    }

    if (matchesKey(data, "space") || data === " ") {
      const model = filtered[this.cursorIndex];
      if (model) {
        if (this.selected.has(model.id)) {
          this.selected.delete(model.id);
        } else {
          this.selected.add(model.id);
        }
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "up")) {
      if (filtered.length > 0) {
        this.cursorIndex = Math.max(0, this.cursorIndex - 1);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "down")) {
      if (filtered.length > 0) {
        this.cursorIndex = Math.min(filtered.length - 1, this.cursorIndex + 1);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "pageUp")) {
      if (filtered.length > 0) {
        this.cursorIndex = Math.max(0, this.cursorIndex - 8);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "pageDown")) {
      if (filtered.length > 0) {
        this.cursorIndex = Math.min(filtered.length - 1, this.cursorIndex + 8);
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "home")) {
      this.cursorIndex = 0;
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.cursorIndex = Math.max(0, filtered.length - 1);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
      if (this.filterText.length > 0) {
        this.filterText = this.filterText.slice(0, -1);
        this.cursorIndex = 0;
        this.scrollTop = 0;
        this.invalidate();
        this.tui.requestRender();
      }
      return;
    }

    if (data.length === 1 && data > " " && data <= "~") {
      this.filterText += data;
      this.cursorIndex = 0;
      this.scrollTop = 0;
      this.invalidate();
      this.tui.requestRender();
    }
  }
}

export default function cheaperInferenceExtension(pi: ExtensionAPI, options?: CheaperInferenceOptions) {
  const configFile = resolveConfigFile(options);
  const cacheFile = resolveCacheFile(configFile);
  let savedConfig = loadConfig(configFile);
  let catalogCache = loadCatalogCache(cacheFile);

  function registerProvider(models: ProviderModelConfig[]): void {
    pi.registerProvider(PROVIDER_ID, {
      name: PROVIDER_NAME,
      baseUrl: BASE_URL,
      api: "openai-completions",
      apiKey: API_KEY_ENV,
      models,
    });
  }

  async function fetchAndCacheCatalog(apiKey: string, signal?: AbortSignal): Promise<CatalogModel[]> {
    const models = await fetchCatalog(apiKey, signal);
    catalogCache = { fetchedAt: Date.now(), models };
    saveCatalogCache(cacheFile, catalogCache);
    return models;
  }

  registerProvider(savedConfig.models);

  pi.registerCommand("cheaper-inference-models", {
    description: "Choose which Cheaper Inference models appear in the model list",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      if ("refresh".startsWith(normalized)) {
        return [{ value: "refresh", label: "refresh", description: "Fetch the latest model catalog from Cheaper Inference" }];
      }
      return null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) {
        ctx.ui.notify(
          "No Cheaper Inference API key found. Run /login and choose Cheaper Inference, or set CHEAPER_INFERENCE_API_KEY.",
          "warning",
        );
        return;
      }

      const forceRefresh = args.trim().toLowerCase() === "refresh";
      if (!isCatalogCacheFresh(catalogCache)) {
        catalogCache = loadCatalogCache(cacheFile);
      }

      let catalog: CatalogModel[];
      if (!forceRefresh && isCatalogCacheFresh(catalogCache)) {
        catalog = catalogCache.models;
      } else {
        try {
          catalog = await fetchAndCacheCatalog(apiKey);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!forceRefresh && catalogCache) {
            catalog = catalogCache.models;
            ctx.ui.notify(
              `Failed to refresh Cheaper Inference models (${message}); using cached list.`,
              "warning",
            );
          } else {
            ctx.ui.notify(`Failed to load Cheaper Inference models: ${message}`, "error");
            return;
          }
        }
      }

      const selectedIds = new Set(savedConfig.models.map((m) => m.id));

      if (ctx.mode !== "tui" || !ctx.hasUI) {
        const selectedList =
          selectedIds.size > 0
            ? Array.from(selectedIds).sort().join(", ")
            : "(none)";
        ctx.ui.notify(
          `Cheaper Inference selected models (${selectedIds.size}): ${selectedList}\nAvailable in catalog: ${catalog.length}`,
          "info",
        );
        return;
      }

      const pickerResult = await ctx.ui.custom<PickerResult | undefined>((tui, theme, _kb, done) => {
        return new ModelPickerComponent(catalog, selectedIds, tui, theme, done, async (signal) => {
          const refreshed = await fetchAndCacheCatalog(apiKey, signal);
          catalog = refreshed;
          return refreshed;
        });
      });

      if (!pickerResult) {
        return;
      }

      const catalogById = new Map(catalog.map((m) => [m.id, m]));
      const previousById = new Map(savedConfig.models.map((m) => [m.id, m]));
      const nextModels: ProviderModelConfig[] = [];

      for (const id of Array.from(pickerResult.selected).sort()) {
        const catalogModel = catalogById.get(id);
        if (catalogModel) {
          nextModels.push(toPiModel(catalogModel));
        } else {
          const existing = previousById.get(id);
          if (existing) {
            nextModels.push(existing);
          }
        }
      }

      savedConfig = { models: nextModels };
      saveConfig(configFile, savedConfig);
      registerProvider(nextModels);

      if (pickerResult.activateModelId) {
        const model = ctx.modelRegistry.find(PROVIDER_ID, pickerResult.activateModelId);
        if (model) {
          const success = await pi.setModel(model);
          if (success) {
            ctx.ui.notify(
              `Active model set to ${pickerResult.activateModelId} (${nextModels.length} Cheaper Inference model(s) in /model).`,
              "info",
            );
            return;
          }
          ctx.ui.notify(
            `Saved ${nextModels.length} Cheaper Inference model(s), but could not activate ${pickerResult.activateModelId}.`,
            "warning",
          );
          return;
        }
        ctx.ui.notify(
          `Saved ${nextModels.length} Cheaper Inference model(s), but ${pickerResult.activateModelId} was not found in model registry.`,
          "warning",
        );
        return;
      }

      ctx.ui.notify(`${nextModels.length} Cheaper Inference model(s) available in /model.`, "info");
    },
  });
}
