# pi-cheaper-inference

A Pi extension that adds the Cheaper Inference provider with API key login and a curated model picker.

## Why pi-cheaper-inference?

Cheaper Inference exposes a large catalog of hundreds of models across multiple upstream providers. Loading every model automatically creates friction:

- **Cluttered Model Picker**: Hundreds of unused models make `/model` slow to scan and hard to navigate.
- **No Curated Workspace List**: Most workflows rely on a handful of preferred models rather than the entire marketplace.
- **Manual Configuration Drift**: Hand-editing `models.json` requires tracking context windows, pricing, and compatibility flags yourself.

`pi-cheaper-inference` solves this with an opt-in workflow:

- **Empty Until You Pick**: No models are added to Pi's `/model` list by default.
- **Curated `/cheaper-models` Menu**: Fetch the live catalog, search by model ID or provider, inspect pricing and capabilities, and toggle only the models you want.
- **Automatic Metadata Mapping**: Context windows, token pricing, vision/reasoning flags, and Claude prompt-cache compatibility are populated from the live catalog.

## Features

- **API Key Authentication**: Sign in via Pi's built-in `/login` command or `CHEAPER_INFERENCE_API_KEY`.
- **Interactive Model Picker**: Searchable TUI list with context size, `$in/$out` per 1M tokens, and `reasoning`/`vision` tags.
- **Local Catalog Caching**: Caches the fetched catalog in `~/.pi/agent/cheaper-inference-cache.json` for 1 hour so reopening `/cheaper-models` is instant, with manual refresh via `Ctrl+R` or `/cheaper-models refresh`.
- **Persistent Selection**: Saves your selected models locally in `~/.pi/agent/cheaper-inference.json` for offline startup without extra network calls.
- **Live Registration**: Updates Pi's `/model` list immediately after closing `/cheaper-models`.

## Installation

```bash
pi install npm:@dsnbyte/pi-cheaper-inference
```

### Try Without Installing

You can test the extension in a single Pi session without modifying your settings:

```bash
pi -e npm:@dsnbyte/pi-cheaper-inference
```

## Setup

1. Create an account and API key in the [Cheaper Inference dashboard](https://www.cheaperinference.com/docs) (requires a funded wallet).
2. Authenticate in Pi using either method:
   - Run `/login`, select **Cheaper Inference**, and paste your API key.
   - Or export the environment variable before launching Pi:

```bash
export CHEAPER_INFERENCE_API_KEY=ci_live_your_key
```

## Usage

Open the model selector inside an active Pi session:

```text
/cheaper-models
```

In the interactive picker:

- **Type** to filter models by ID, owner, or provider.
- **Up / Down / PgUp / PgDn / Home / End** to move through the list.
- **Space / Enter** to toggle whether a model is included.
- **Ctrl+R** (or **F5**) to manually refresh the model list from the provider.
- **Esc** to save your selection and update `/model`.

You can also run `/cheaper-models refresh` to force an immediate catalog refresh when opening the menu.

After selecting models, switch to any of them with `/model`.

## Configuration

Selected model snapshots are stored at `~/.pi/agent/cheaper-inference.json`:

```json
{
  "models": [
    {
      "type": "chat",
      "id": "claude-opus-4.6",
      "name": "claude-opus-4.6"
    }
  ]
}
```

For full provider documentation, see [cheaperinference.com/docs](https://www.cheaperinference.com/docs).

## License

MIT
