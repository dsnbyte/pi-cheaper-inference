# pi-cheaper-inference

A Pi extension that adds the Cheaper Inference provider with API key login and a curated model picker.

[Cheaper Inference](https://www.cheaperinference.com/) is an inference API provider offering unified access to models from multiple upstream providers. `pi-cheaper-inference` integrates it into Pi so you can authenticate with your API key, choose the models you want with `/cheaper-inference-models`, and use them in Pi via `/model`.

## Features

- **API Key Authentication**: Sign in via `/login` or the `CHEAPER_INFERENCE_API_KEY` environment variable.
- **Interactive Model Picker**: Search and filter available models, inspect pricing and capabilities, and toggle the ones you want.
- **Persistent Selection**: Saves your chosen models across Pi sessions.
- **Live Registration**: Updates Pi's `/model` list as soon as you close `/cheaper-inference-models`.

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
/cheaper-inference-models
```

In the interactive picker:

- **Type** to filter models by ID, owner, or provider.
- **Up / Down / PgUp / PgDn / Home / End** to move through the list.
- **Space** to toggle whether a model is included.
- **Enter** to activate the highlighted model, set it as the active model, save, and close.
- **Ctrl+R** (or **F5**) to manually refresh the model list from the provider.
- **Esc** to save your selection and update `/model`.

You can also run `/cheaper-inference-models refresh` to force an immediate catalog refresh when opening the menu.

After selecting models, switch to any of them with `/model`.

## Configuration

Selected model snapshots are stored at `~/.pi/agent/cheaper-inference.json`:

```json
{
  "models": [
    {
      "type": "chat",
      "id": "gemini-4-neon",
      "name": "gemini-4-neon"
    }
  ]
}
```

For full provider documentation, see [cheaperinference.com/docs](https://www.cheaperinference.com/docs).

## License

MIT
