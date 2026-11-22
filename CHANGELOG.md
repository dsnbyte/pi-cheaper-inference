# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-11-22

### Added
- Cheaper Inference provider registration (`cheaper-inference`) using OpenAI-compatible Chat Completions (`https://api.cheaperinference.com/v1`).
- API key authentication via Pi's `/login` flow or the `CHEAPER_INFERENCE_API_KEY` environment variable.
- Interactive `/cheaper-models` TUI picker with live search, pricing per million tokens, context window, and capability indicators (`reasoning`, `vision`).
- Persistent model selection stored in `~/.pi/agent/cheaper-inference.json` so only user-selected models appear in `/model`.
- Non-TUI fallback output displaying selected models and catalog availability.
