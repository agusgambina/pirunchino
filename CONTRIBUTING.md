# Contributing

Thanks for helping. Bug reports, title-cleanup cases and pull requests are all welcome.

## Setup

- Node.js 22.18 or newer (it runs the TypeScript files directly, so there's no build step and nothing to `npm install`)
- `yt-dlp` and `ffmpeg` to try real downloads (see the README)
- Optional: Ollama and a model, to try the local-model naming

## Tests

```sh
npm test
```

The tests don't need a network connection, yt-dlp, ffmpeg or Ollama. Ollama is replaced by a stub.

## Reporting a badly named song

Open an issue with:

- the YouTube title and channel
- the name you got and the name you expected
- whether the local model was on (and which model), or `--no-ai`

Name cleanup is in `lib/naming.ts` (rules) and `lib/local-naming.ts` (local model and its checks). A fix should come with a test in `lib/naming.test.ts` or `lib/local-naming.test.ts` using that title.

## Pull requests

- Keep the project free of npm dependencies unless there's a strong reason.
- Run `npm test` before opening the pull request.
- Don't commit audio files. `downloads/` is in `.gitignore` for that reason.
