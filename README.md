# boggle-studio-figma-plugin

> A monorepo for custom Figma plugins used by the **boggle-studio** service.
> Each plugin automates the synchronization between design assets and development-side config constants,
> eliminating manual handoff between design and engineering.
>
> boggle-studio 서비스에 필요한 맞춤형 피그마 플러그인들을 모아두고 관리하는 통합 레포지토리(Monorepo)입니다.
> 디자인 에셋과 개발용 config 상수를 자동화하여 싱크를 맞추는 것을 목적으로 합니다.

---

## Table of Contents

- [Plugins](#plugins)
  - [`boggle-asset-exporter` — Asset Exporter](#boggle-asset-exporter--asset-exporter)
- [Getting Started](#getting-started)
  - [1. Install dependencies](#1-install-dependencies)
  - [2. Build & watch](#2-build--watch)
  - [3. Import the plugin into Figma](#3-import-the-plugin-into-figma)
  - [4. Run the plugin](#4-run-the-plugin)
- [How to Add a New Plugin](#how-to-add-a-new-plugin)
- [Project Structure](#project-structure)
- [Tech Stack](#tech-stack)

---

## Plugins

### `boggle-asset-exporter` — Asset Exporter

Located at `src/boggle-asset-exporter/`

A Figma plugin that scans a top-level Section node containing `FRAME` and `BACKGROUND` sub-sections, then generates structured JSON config files and exports image assets — all bundled into a single zip file.

**What it produces:**

| Output | Description |
|---|---|
| `frame-options.json` | Per-slot relative coordinates (x, y, width, height) for each frame layout, derived from the `FRAME` section |
| `background-options.json` | Background/overlay image paths and sample thumbnail URLs for each frame × background combination, derived from the `BACKGROUND` section |
| `public/images/samples/` | 0.5× PNG thumbnails for each background (`bg-{id}.png`) |
| `public/images/backgrounds/` | 1× PNG background images per frame × background (`{frameId}-{id}.png`) |
| `public/images/overlays/` | 1× PNG overlay images per frame × background (`{frameId}-{id}.png`), when present |
| `project_assets.zip` | All of the above bundled into a single downloadable zip |

**Expected Figma layer structure:**

```
[Top-level Section]  ← select this before running
├── FRAME  (Section)
│   └── basic  (frameId group)
│       └── frame
│           ├── slot1
│           └── slot2
└── BACKGROUND  (Section)
    └── vangogh  (backgroundId group)
        ├── sample
        ├── basic  (frameId group)
        │   ├── background
        │   └── overlay  (optional)
        └── wide  (frameId group)
            └── ...
```

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Build & watch

```bash
npm run watch
```

This starts esbuild in watch mode. Any change to `src/**/*.ts` or `src/**/ui.html` is compiled automatically to `dist/`.

For a one-shot production build:

```bash
npm run build:prod
```

### 3. Import the plugin into Figma

1. Open the **Figma desktop app**.
2. Go to **Menu → Plugins → Development → Import plugin from manifest...**
3. Select the `manifest.json` file at the root of this repository.

The plugin will now appear under **Plugins → Development → Boggle Studio**.

### 4. Run the plugin

1. In your Figma file, select the **top-level Section** node that contains `FRAME` and `BACKGROUND` sub-sections.
2. Open the plugin via **Plugins → Development → Boggle Studio → Asset Exporter**,
   or use the shortcut `Cmd+Opt+P` (macOS) / `Ctrl+Alt+P` (Windows).
3. Click **Run** in the plugin panel.
4. Once processing completes, `project_assets.zip` will be downloaded automatically.

---

## How to Add a New Plugin

The build system auto-discovers plugins — any subdirectory under `src/` that contains a `code.ts` file is compiled as a separate entry point. **No build config changes are required.**

### Step-by-step

**1. Create a new plugin directory under `src/`**

```
src/
├── boggle-asset-exporter/   # existing
└── my-new-plugin/           # new
    ├── code.ts              # required — Figma sandbox (main thread) logic
    └── ui.html              # optional — plugin UI panel
```

**2. Write `code.ts` and (optionally) `ui.html`**

`code.ts` runs in the Figma sandbox (no DOM access). Communicate with the UI panel via `figma.ui.postMessage` / `figma.ui.onmessage`.

**3. Register the new command in `manifest.json`**

Add an entry to the `menu` array:

```json
{
  "menu": [
    {
      "name": "Asset Exporter",
      "command": "boggle-asset-exporter"
    },
    {
      "name": "My New Plugin",
      "command": "my-new-plugin"
    }
  ]
}
```

Update `main` and `ui` in `manifest.json` if you need to point to a different default entry, or handle command routing inside `code.ts` using `figma.command`.

**4. Restart watch mode**

```bash
npm run watch
```

The new plugin is picked up automatically and compiled to `dist/my-new-plugin/code.js`.

---

## Project Structure

```
boggle-studio-figma-plugin/
├── src/
│   └── boggle-asset-exporter/
│       ├── code.ts          # main thread logic
│       └── ui.html          # plugin UI
├── dist/                    # compiled output (git-ignored)
│   └── boggle-asset-exporter/
│       ├── code.js
│       └── ui.html
├── scripts/
│   └── build.js             # esbuild multi-entry build script
├── manifest.json            # Figma plugin manifest
├── package.json
└── tsconfig.json
```

---

## Tech Stack

| | |
|---|---|
| Build | [esbuild](https://esbuild.github.io/) via custom `scripts/build.js` |
| Language | TypeScript 5 |
| Figma API typings | `@figma/plugin-typings` |
| ZIP generation | [JSZip](https://stuk.github.io/jszip/) (runs in the UI iframe) |
