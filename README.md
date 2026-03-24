# postcss-mixin-nav

A VS Code / Cursor extension that adds **Go to Definition**, **Find References**, and **Hover** for [`postcss-mixins`](https://github.com/postcss/postcss-mixins) — the `@define-mixin` / `@mixin` syntax.

## Features

| Gesture | What happens |
|---|---|
| **F12** (Go to Definition) on `@mixin name` | Jumps to the `@define-mixin name` block anywhere in the workspace |
| **Shift+F12** (Find All References) on `@define-mixin name` | Lists every `@mixin name` call in the workspace |
| **Hover** on `@mixin name` | Shows the first ~10 lines of the mixin body inline |
| **Command palette** → `PostCSS: Rebuild Mixin Index` | Forces a fresh workspace-wide scan |

Works in `.css`, `.pcss`, and `.postcss` files. The file glob is configurable.

Supports:
- Mixins without parameters: `@mixin widgetBox`
- Mixins with parameters: `@mixin button $color, $size`

## Usage

### Option A — run without installing (dev host)

```bash
# Open the extension folder in Cursor / VS Code
code /path/to/postcss-mixin-nav

# Press F5 → "Run Extension"
# A new Extension Development Host window opens with the extension active
```

Open any CSS file in that window and press **F12** on an `@mixin` line.

### Option B — install as a local VSIX (permanent)

```bash
cd postcss-mixin-nav
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
# → postcss-mixin-nav-0.1.0.vsix
```

In Cursor / VS Code: **Extensions panel → ⋯ menu → Install from VSIX…** → pick the `.vsix` file.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `postcssMixinNav.fileGlob` | `**/*.{css,pcss,postcss}` | Glob pattern for files to scan for `@define-mixin` |

Example (`settings.json`):

```json
{
  "postcssMixinNav.fileGlob": "**/*.{css,pcss,postcss,module.css}"
}
```

## How it works

On first use the extension scans the workspace for all `@define-mixin` declarations and builds an in-memory index. The index is updated automatically when files are created, changed, or deleted. Mixin name resolution is by **exact name only** — parameter lists are not part of the lookup key (same as how `postcss-mixins` resolves names).

## Development

```bash
npm install       # install dev dependencies
npm run compile   # compile TypeScript → out/
npm run watch     # compile in watch mode
# then press F5 in VS Code / Cursor to launch Extension Development Host
```
