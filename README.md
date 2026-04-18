# GPT-5.4 CUA Sample App

TypeScript sample app for browser-first and chat-first computer-use workflows with GPT-5.4. The repo includes:

- `apps/telegram-bot`: a Telegram-first chat interface for starting runs, tracking state, and relaying runner updates without keeping the web console open
- `apps/runner`: a Fastify runner that manages mutable workspaces, browser sessions, terminal/file/audio tools, SSE, and replay bundles
- `apps/demo-web`: the original Next.js console, kept as an optional UI rather than the default control surface
- `packages/*`: shared scenario, runtime, and contract packages that make it easy to add new labs later

The legacy Python sample does not ship in this release branch. Keep that history on a separate `v1` or `legacy` branch.

## What This Repo Demonstrates

- how to integrate the Responses API from one canonical place: `packages/runner-core/src/responses-loop.ts`
- how to switch between `code` mode and `native` computer mode against the same browser lab
- how to add a tool registry for terminal, filesystem, voice, desktop, clipboard, window-state, window listing, focus control, memory, and integration capabilities alongside browser control
- how to define scenario manifests, launch isolated run workspaces, and verify outcomes
- how to build an operator-facing console that supports chat-driven task submission and clear failure guidance
- how to route the same runner through Telegram chat when a lightweight control surface is preferable on low-RAM machines

## Prerequisites

- Node.js `22.20.0`
- pnpm `10.26.0`
- Playwright Chromium browser install

## First Run

```bash
git clone <repo-url>
cd openai-cua-sample-app
corepack enable
pnpm install
cp .env.example .env
```

Edit `.env` and set at least this environment variable:

```bash
OPENAI_API_KEY=your_key_here
```

The runner reads the repo-root `.env` automatically when you start it through the provided scripts. The web app uses its built-in defaults; if you need to override `NEXT_PUBLIC_*` settings, add them in `apps/demo-web/.env.local`.

If `pnpm install` prints an `Ignored build scripts` warning for optional packages such as `sharp` or `esbuild`, you can ignore it for local development in this repo. A clean clone still installs, builds, and starts successfully without approving those scripts.

Install the Playwright browser:

```bash
pnpm playwright:install
```

On Linux, install Playwright OS dependencies as well:

```bash
pnpm playwright:install:with-deps
```

If Playwright later reports missing system libraries, rerun the `with-deps` command above and follow any OS package prompts it prints.

Start the chat-first control loop locally:

```bash
pnpm dev
```

If `TELEGRAM_BOT_TOKEN` is present in `.env`, the Telegram bot will start automatically. Message the bot with normal task text to launch a run; `/scenarios`, `/capabilities`, and `/status` are optional shortcuts. The optional web console can still be started separately with `pnpm dev:web` if you want the browser UI, or you can set `ENABLE_WEB=true` before `pnpm dev` on a machine with enough RAM.

For a lighter local or server profile that skips the browser console completely, use:

```bash
pnpm dev:server
```

For built artifacts in a deployment environment, run:

```bash
pnpm build:server
pnpm start:server
```

## Server Deployment

Use this profile when you want the control loop off your low-RAM laptop and on a Linux server or VPS.

### Runtime split

- Server: `runner` + `telegram-bot`
- Local machine: only the desktop bridge you need for the machine being controlled
- Optional browser console: keep disabled unless you really need the web UI

### Minimal server setup

1. Provision a Linux machine with Node.js 22 and pnpm 10.
2. Copy the repo, create `.env`, and set:

```bash
OPENAI_API_KEY=your_key_here
HOST=0.0.0.0
PORT=4001
ENABLE_WEB=false
ENABLE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=your_new_token
TELEGRAM_BOT_USERNAME=your_bot_username
TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id
TELEGRAM_REQUIRE_ALLOWLIST=true
TELEGRAM_ALLOW_OPEN_ACCESS=false
TELEGRAM_RUNNER_BASE_URL=http://127.0.0.1:4001
```

3. Install and build:

```bash
pnpm install
pnpm build:server
```

4. Start the production profile:

```bash
pnpm start:server
```

### Local dev on a small laptop

If the browser console is too heavy, use the same server-first profile locally:

```bash
pnpm dev:server
```

That starts the runner and Telegram control bot without the Next.js console.

## Local Development

Run the services separately if you want independent logs:

```bash
pnpm dev:runner
pnpm dev:telegram
RUNNER_BASE_URL=http://127.0.0.1:4001 pnpm dev:web
```

Common checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Live smoke tests stay opt-in and secret-gated:

```bash
OPENAI_API_KEY=your_key_here pnpm test:live
```

## Execution Modes

- `native`: exposes the Responses API computer tool directly. The model requests clicks, drags, typing, waits, and screenshots against the live browser session.
- `code`: exposes a persistent Playwright JavaScript REPL through `exec_js` plus workspace tools for terminal, files, voice, and desktop handoff. The model scripts the browser rather than emitting raw computer actions.

Both modes use the same scenario manifests and replay pipeline. `native` is the closest sample of the computer tool itself. `code` is the clearest sample of a browser REPL harness.

## Official Scenarios

- `kanban-reprioritize-sprint` (`kanban`): teaches stateful drag-and-drop verification against a target board state derived from the operator prompt
- `paint-draw-poster` (`paint`): teaches cursor control, drawing, and verifying saved canvas state against the live canvas
- `booking-complete-reservation` (`booking`): teaches multi-step browsing and form completion with verification against a local confirmation record
- `desktop-control-console` (`desktop`): a Telegram-friendly desktop operator scenario that emphasizes terminal work, desktop observation, and window control

More detail lives in [docs/scenarios.md](docs/scenarios.md).

## Repo Map

- `apps/demo-web`
  The operator console UI
- `apps/runner`
  The HTTP runner, SSE endpoints, and artifact serving layer
- `packages/replay-schema`
  Shared request, response, replay, and error contracts
- `packages/scenario-kit`
  Public scenario manifests and prompt defaults
- `packages/browser-runtime`
  Playwright session abstraction
- `packages/runner-core`
  Orchestration, Responses loop, scenario executors, and verification
- `labs`
  Static lab templates copied into run-scoped workspaces
- `docs`
  Architecture, scenarios, and contribution guidance

## Environment Variables

Runner:

- `OPENAI_API_KEY`
- `HOST` (default `127.0.0.1`)
- `PORT` (default `4001`)
- `CUA_DEFAULT_MODEL` (default `gpt-5.4`)
- `CUA_RESPONSES_MODE` (`auto`, `fallback`, or `live`)
- `CUA_ALLOW_DANGEROUS_COMMANDS` (`true` to lift the destructive-command guard on terminal tools)
- `CUA_ENABLE_DESKTOP_CONTROL` (`false` to disable the desktop launch primitives; defaults to enabled)

Web:

- `RUNNER_BASE_URL` (default `http://127.0.0.1:4001`)
- `NEXT_PUBLIC_CUA_DEFAULT_MODEL` (default `gpt-5.4`)
- `NEXT_PUBLIC_CUA_DEFAULT_MAX_RESPONSE_TURNS` (default `24`)

Telegram bot:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` (optional, used for a clickable `t.me` link in the chat)
- `TELEGRAM_ALLOWED_CHAT_IDS` (comma-separated allowlist; leave empty to allow all chats for local development)
- `TELEGRAM_RUNNER_BASE_URL` (default `http://127.0.0.1:4001`)
- `TELEGRAM_DEFAULT_SCENARIO_ID` (default `desktop-control-console`)
- `TELEGRAM_MODEL` (defaults to `CUA_DEFAULT_MODEL` or `gpt-5.4`)
- `TELEGRAM_BROWSER_MODE` (default `headless`)
- `TELEGRAM_MAX_RESPONSE_TURNS` (default `20`)
- `TELEGRAM_MAX_HISTORY_MESSAGES` (default `12`)
- `TELEGRAM_SEND_EVENT_SUMMARIES` (default `true`)
- `ENABLE_WEB` (default `false`; set `true` only on a machine that can afford the browser console)

See [.env.example](.env.example) for a minimal local template.

## Safety And Limitations

- Computer use remains high risk. Do not point this sample at authenticated, financial, medical, or otherwise high-stakes environments.
- The runner now ships workspace tools for terminal and file operations plus desktop launch/input/focus primitives, but computer use remains high risk. Do not point it at authenticated, financial, medical, or otherwise high-stakes environments.
- Pending computer-use safety acknowledgements are not implemented in this sample yet. Runs fail with the stable code `unsupported_safety_acknowledgement` when the API asks for one.
- The public scenarios are local labs designed for deterministic verification. They are not intended as proofs of general web autonomy.

## Release Validation Checklist

- clean clone on a fresh machine
- setup succeeds from this README alone
- `pnpm dev`
- one successful headless run
- one successful headful run
- one intentional failure that shows the new runner guidance cleanly

## Capability surface

The runner now exposes a wide tool surface through the same orchestration loop:

- Browser control
- Terminal execution
- Filesystem read/write/search
- Voice output
- Desktop launch, pointer, typing, clipboard, screen capture, window-state, window listing, focus control, and OS-native handoff primitives
- Chat memory and integration surfaces in the console and APIs

Terminal safety remains in place for clearly destructive commands. Set `CUA_ALLOW_DANGEROUS_COMMANDS=true` only when you understand the risk.
