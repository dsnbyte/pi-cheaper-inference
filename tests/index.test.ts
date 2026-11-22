import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cheaperInferenceExtension, { type CatalogModel } from "../extensions/index.ts";

interface RegisteredCommandMock {
  description?: string;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
  handler: (args: string, ctx: any) => Promise<void>;
}

function makeModel(id: string): CatalogModel {
  return {
    id,
    context_length: 128_000,
    max_output_tokens: 16_384,
    endpoint: "/v1/chat/completions",
    pricing: { input_per_million: "1.00", output_per_million: "2.00" },
  };
}

function createHarness(configPath: string, setModelResult = true) {
  const registeredProviders: Array<{ id: string; config: any }> = [];
  const commands = new Map<string, RegisteredCommandMock>();
  const setModelCalls: any[] = [];

  const pi = {
    registerProvider(id: string, config: any) {
      registeredProviders.push({ id, config });
    },
    registerCommand(name: string, options: RegisteredCommandMock) {
      commands.set(name, options);
    },
    async setModel(model: any) {
      setModelCalls.push(model);
      return setModelResult;
    },
  };

  cheaperInferenceExtension(pi as any, { configPath });

  const command = commands.get("cheaper-inference-models");
  assert.ok(command, "cheaper-inference-models command should be registered");

  return { registeredProviders, command, setModelCalls };
}

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function createMockTui() {
  let renderRequests = 0;
  return {
    terminal: { rows: 24, columns: 100 },
    requestRender() {
      renderRequests++;
    },
    getRenderRequests() {
      return renderRequests;
    },
  };
}

function createMockContext(
  customHandler?: (factory: any) => Promise<any>,
  registeredProviders?: Array<{ id: string; config: any }>,
) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    mode: customHandler ? "tui" : "print",
    hasUI: Boolean(customHandler),
    modelRegistry: {
      async getApiKeyForProvider() {
        return "ci_test_key";
      },
      find(provider: string, modelId: string) {
        if (!registeredProviders) return undefined;
        const latest = [...registeredProviders].reverse().find((p) => p.id === provider);
        const model = latest?.config?.models?.find((m: any) => m.id === modelId);
        return model ? { provider, ...model } : undefined;
      },
    },
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      custom(factory: any) {
        if (!customHandler) {
          throw new Error("custom UI called unexpectedly");
        }
        return customHandler(factory);
      },
    },
  };
  return { ctx, notifications };
}

describe("pi-cheaper-inference catalog caching", () => {
  let tempDir: string;
  let configPath: string;
  let cachePath: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-cheaper-inference-test-"));
    configPath = join(tempDir, "cheaper-inference.json");
    cachePath = join(tempDir, "cheaper-inference-cache.json");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("fetches once, caches locally, and reuses cache on reopen within 1 hour", async () => {
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [makeModel("model-a"), makeModel("model-b")] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { command } = createHarness(configPath);
    const first = createMockContext(async (factory) => {
      const tui = createMockTui();
      let result: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        result = r;
      });
      component.handleInput("\x1b"); // Escape
      return result;
    });

    await command.handler("", first.ctx);
    assert.equal(fetchCount, 1);

    const savedCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(savedCache.models.length, 2);
    assert.equal(typeof savedCache.fetchedAt, "number");

    // Reopen within the same session -> no fetch
    const second = createMockContext(async (factory) => {
      const tui = createMockTui();
      let result: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        result = r;
      });
      const rendered = component.render(100).join("\n");
      assert.match(rendered, /model-a/);
      assert.match(rendered, /ctrl\+r refresh/);
      component.handleInput("\x1b");
      return result;
    });
    await command.handler("", second.ctx);
    assert.equal(fetchCount, 1);

    // Reopen in a fresh extension instance (simulating Pi restart) -> loads from disk cache, no fetch
    const restarted = createHarness(configPath);
    const third = createMockContext(async (factory) => {
      const tui = createMockTui();
      let result: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        result = r;
      });
      component.handleInput("\x1b");
      return result;
    });
    await restarted.command.handler("", third.ctx);
    assert.equal(fetchCount, 1);
  });

  it("fetches again when the last fetch was at least one hour ago and updates cache", async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: oneHourAgo, models: [makeModel("stale-model")] }),
      "utf-8",
    );

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [makeModel("fresh-model")] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { command } = createHarness(configPath);
    const { ctx } = createMockContext(async (factory) => {
      const tui = createMockTui();
      let result: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        result = r;
      });
      const rendered = component.render(100).join("\n");
      assert.match(rendered, /fresh-model/);
      assert.doesNotMatch(rendered, /stale-model/);
      component.handleInput("\x1b");
      return result;
    });

    await command.handler("", ctx);
    assert.equal(fetchCount, 1);

    const updatedCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(updatedCache.models[0].id, "fresh-model");
    assert.ok(updatedCache.fetchedAt > oneHourAgo);
  });

  it("falls back to stale cache with a warning if refresh after 1 hour fails", async () => {
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: twoHoursAgo, models: [makeModel("cached-model")] }),
      "utf-8",
    );

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    const { command } = createHarness(configPath);
    const { ctx, notifications } = createMockContext();
    await command.handler("", ctx);

    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].type, "warning");
    assert.match(notifications[0].message, /using cached list/);
    assert.match(notifications[1].message, /Available in catalog: 1/);
  });

  it("supports manual refresh inside the menu with Ctrl+R and saves newly fetched models", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 60_000, models: [makeModel("alpha-model")] }),
      "utf-8",
    );

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [makeModel("beta-model")] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { command, registeredProviders } = createHarness(configPath);
    const { ctx } = createMockContext(async (factory) => {
      const tui = createMockTui();
      let doneResult: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        doneResult = r;
      });

      assert.match(component.render(100).join("\n"), /alpha-model/);
      assert.equal(fetchCount, 0);

      // Press Ctrl+R to manually refresh
      component.handleInput("\x12");
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(fetchCount, 1);
      const refreshedText = component.render(100).join("\n");
      assert.match(refreshedText, /beta-model/);
      assert.match(refreshedText, /Refreshed \(1 models\)/);

      // Toggle beta-model and save with Escape
      component.handleInput(" ");
      component.handleInput("\x1b");
      return doneResult;
    });

    await command.handler("", ctx);

    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(
      savedConfig.models.map((m: any) => m.id),
      ["beta-model"],
    );
    const latestProvider = registeredProviders[registeredProviders.length - 1];
    assert.deepEqual(
      latestProvider.config.models.map((m: any) => m.id),
      ["beta-model"],
    );

    const updatedCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(updatedCache.models[0].id, "beta-model");
  });

  it("supports /cheaper-inference-models refresh to bypass fresh cache", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 10_000, models: [makeModel("old-model")] }),
      "utf-8",
    );

    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ data: [makeModel("new-model-1"), makeModel("new-model-2")] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const { command } = createHarness(configPath);
    assert.deepEqual(
      command.getArgumentCompletions?.("ref")?.map((c) => c.value),
      ["refresh"],
    );

    const { ctx, notifications } = createMockContext();
    await command.handler("refresh", ctx);

    assert.equal(fetchCount, 1);
    assert.match(notifications[0].message, /Available in catalog: 2/);
    const updatedCache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.equal(updatedCache.models.length, 2);
  });

  it("aborts an in-flight manual refresh when closing the picker", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 10_000, models: [makeModel("alpha-model")] }),
      "utf-8",
    );

    let aborted = false;
    globalThis.fetch = ((_url: any, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const { command } = createHarness(configPath);
    const { ctx } = createMockContext(async (factory) => {
      const tui = createMockTui();
      let doneResult: Set<string> | undefined;
      const component = factory(tui, createMockTheme(), {}, (r: Set<string> | undefined) => {
        doneResult = r;
      });
      component.handleInput("\x12"); // Ctrl+R
      const rendersBeforeClose = tui.getRenderRequests();
      component.handleInput("\x1b"); // Escape while refresh in flight
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(aborted, true);
      assert.equal(tui.getRenderRequests(), rendersBeforeClose);
      return doneResult;
    });

    await command.handler("", ctx);
  });

  it("activates the highlighted model with Enter, sets it as active, saves, and closes", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 10_000, models: [makeModel("model-a"), makeModel("model-b")] }),
      "utf-8",
    );

    const { command, registeredProviders, setModelCalls } = createHarness(configPath);
    const { ctx, notifications } = createMockContext(async (factory) => {
      const tui = createMockTui();
      let doneResult: any;
      const component = factory(tui, createMockTheme(), {}, (r: any) => {
        doneResult = r;
      });

      const rendered = component.render(120).join("\n");
      assert.match(rendered, /space toggle/);
      assert.match(rendered, /enter use & close/);
      assert.match(rendered, /esc save & close/);

      // Toggle model-a with Space, move down to model-b, press Enter to use & close
      component.handleInput(" ");
      component.handleInput("\x1b[B"); // Down arrow
      component.handleInput("\r"); // Enter

      return doneResult;
    }, registeredProviders);

    await command.handler("", ctx);

    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(
      savedConfig.models.map((m: any) => m.id),
      ["model-a", "model-b"],
    );
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls[0].provider, "cheaper-inference");
    assert.equal(setModelCalls[0].id, "model-b");
    assert.match(notifications[0].message, /Active model set to model-b/);
  });

  it("keeps Escape saving without changing the active model", async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: Date.now() - 10_000, models: [makeModel("model-a")] }),
      "utf-8",
    );

    const { command, registeredProviders, setModelCalls } = createHarness(configPath);
    const { ctx, notifications } = createMockContext(async (factory) => {
      const tui = createMockTui();
      let doneResult: any;
      const component = factory(tui, createMockTheme(), {}, (r: any) => {
        doneResult = r;
      });
      component.handleInput(" ");
      component.handleInput("\x1b");
      return doneResult;
    }, registeredProviders);

    await command.handler("", ctx);

    const savedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.deepEqual(
      savedConfig.models.map((m: any) => m.id),
      ["model-a"],
    );
    assert.equal(setModelCalls.length, 0);
    assert.match(notifications[0].message, /1 Cheaper Inference model\(s\) available in \/model\./);
  });
});
