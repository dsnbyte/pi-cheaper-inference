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

export interface CheaperInferenceOptions {
  configPath?: string;
}

interface CheaperInferenceConfig {
  models: ProviderModelConfig[];
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

function loadConfig(configFile: string): CheaperInferenceConfig {
  try {
    if (!existsSync(configFile)) {
      return { models: [] };
    }
    const raw = JSON.parse(readFileSync(configFile, "utf-8")) as unknown;
    const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
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
  try {
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch {
    // Gracefully ignore write failures (e.g. read-only filesystem)
  }
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

class ModelPickerComponent implements Component {
  private catalog: CatalogModel[];
  private selected: Set<string>;
  private tui: TUI;
  private theme: Theme;
  private onDone: (result: Set<string> | undefined) => void;
  private cursorIndex = 0;
  private scrollTop = 0;
  private filterText = "";
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    catalog: CatalogModel[],
    selectedIds: Set<string>,
    tui: TUI,
    theme: Theme,
    onDone: (result: Set<string> | undefined) => void,
  ) {
    this.catalog = catalog;
    this.selected = new Set(selectedIds);
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
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
    const header =
      th.fg("muted", ` Cheaper Inference Models (`) +
      th.fg("accent", `${this.selected.size}`) +
      th.fg("muted", `/${this.catalog.length} selected)${filterInfo}`);
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
      formatKeyHint(th, "type", "to search"),
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
      this.onDone(new Set(this.selected));
      return;
    }

    if (matchesKey(data, "ctrl+c")) {
      this.onDone(undefined);
      return;
    }

    if (
      matchesKey(data, "space") ||
      data === " " ||
      matchesKey(data, "enter") ||
      data === "\r" ||
      data === "\n"
    ) {
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
  let savedConfig = loadConfig(configFile);

  function registerProvider(models: ProviderModelConfig[]): void {
    pi.registerProvider(PROVIDER_ID, {
      name: PROVIDER_NAME,
      baseUrl: BASE_URL,
      api: "openai-completions",
      apiKey: API_KEY_ENV,
      models,
    });
  }

  registerProvider(savedConfig.models);

  pi.registerCommand("cheaper-models", {
    description: "Choose which Cheaper Inference models appear in the model list",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
      if (!apiKey) {
        ctx.ui.notify(
          "No Cheaper Inference API key found. Run /login and choose Cheaper Inference, or set CHEAPER_INFERENCE_API_KEY.",
          "warning",
        );
        return;
      }

      let catalog: CatalogModel[];
      try {
        catalog = await fetchCatalog(apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to load Cheaper Inference models: ${message}`, "error");
        return;
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

      const nextSelected = await ctx.ui.custom<Set<string> | undefined>((tui, theme, _kb, done) => {
        return new ModelPickerComponent(catalog, selectedIds, tui, theme, done);
      });

      if (!nextSelected) {
        return;
      }

      const catalogById = new Map(catalog.map((m) => [m.id, m]));
      const previousById = new Map(savedConfig.models.map((m) => [m.id, m]));
      const nextModels: ProviderModelConfig[] = [];

      for (const id of Array.from(nextSelected).sort()) {
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
      ctx.ui.notify(`${nextModels.length} Cheaper Inference model(s) available in /model.`, "info");
    },
  });
}
