import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const DEFINE_RE = /^\s*@define-mixin\s+([\w-]+)/;
const USE_RE_G = /@mixin\s+([\w-]+)/g;

// ---------------------------------------------------------------------------
// Semantic token legend — "type" maps to whatever the active theme uses for
// class / interface / type names (same as TS component names).
// ---------------------------------------------------------------------------

const TOKEN_TYPES = ['type'];
const TOKEN_MODIFIERS: string[] = [];
const LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);
const TYPE_IDX = 0; // index of 'type' in TOKEN_TYPES

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

type MixinLocation = { file: string; line: number };
type Index = Map<string, MixinLocation[]>;

let cachedIndex: Index | undefined;
let indexPromise: Promise<Index> | undefined;

async function buildIndex(glob: string): Promise<Index> {
  const index: Index = new Map();
  const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**');
  for (const uri of uris) {
    addFileToIndex(index, uri.fsPath);
  }
  return index;
}

function addFileToIndex(index: Index, filePath: string): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = DEFINE_RE.exec(lines[i]);
    if (m) {
      const name = m[1];
      const existing = index.get(name) ?? [];
      existing.push({ file: filePath, line: i });
      index.set(name, existing);
    }
  }
}

function removeFileFromIndex(index: Index, filePath: string): void {
  for (const [name, locs] of index) {
    const filtered = locs.filter((l) => l.file !== filePath);
    if (filtered.length === 0) {
      index.delete(name);
    } else {
      index.set(name, filtered);
    }
  }
}

function getGlob(): string {
  return (
    vscode.workspace.getConfiguration('postcssMixinNav').get<string>('fileGlob') ??
    '**/*.{css,pcss,postcss}'
  );
}

async function getIndex(): Promise<Index> {
  if (cachedIndex) return cachedIndex;
  if (!indexPromise) {
    indexPromise = buildIndex(getGlob()).then((idx) => {
      cachedIndex = idx;
      indexPromise = undefined;
      return idx;
    });
  }
  return indexPromise;
}

// ---------------------------------------------------------------------------
// Caret position: which @mixin name is under the pointer
// ---------------------------------------------------------------------------

type MixinHit = { name: string; range: vscode.Range };

function mixinHitAt(document: vscode.TextDocument, position: vscode.Position): MixinHit | undefined {
  const lineText = document.lineAt(position.line).text;
  if (!lineText.includes('@mixin') || lineText.includes('@define-mixin')) return undefined;

  const re = /@mixin\s+([\w-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lineText)) !== null) {
    const name = m[1];
    const nameStart = m.index + m[0].indexOf(name);
    const nameEnd = nameStart + name.length;
    const col = position.character;
    if (col >= m.index && col <= nameEnd) {
      return {
        name,
        range: new vscode.Range(
          new vscode.Position(position.line, nameStart),
          new vscode.Position(position.line, nameEnd)
        ),
      };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extract the full mixin body by tracking braces
// ---------------------------------------------------------------------------

function extractMixinBody(lines: string[], startLine: number): string {
  let depth = 0;
  let started = false;
  const result: string[] = [];

  for (let i = startLine; i < lines.length; i++) {
    result.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) break;
  }
  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Semantic tokens — colors mixin names with the theme's "type" colour
// (same shade used for TS class / interface / component names)
// ---------------------------------------------------------------------------

class MixinSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(LEGEND);

    for (let i = 0; i < document.lineCount; i++) {
      const lineText = document.lineAt(i).text;

      // @define-mixin <name>
      const defMatch = DEFINE_RE.exec(lineText);
      if (defMatch) {
        const name = defMatch[1];
        const nameStart = defMatch[0].length - name.length + (defMatch.index ?? 0);
        builder.push(i, nameStart, name.length, TYPE_IDX, 0);
      }

      // @mixin <name> (one or more per line, though usually one)
      if (lineText.includes('@mixin') && !lineText.includes('@define-mixin')) {
        const re = /@mixin\s+([\w-]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lineText)) !== null) {
          const name = m[1];
          const nameStart = m.index + m[0].indexOf(name);
          builder.push(i, nameStart, name.length, TYPE_IDX, 0);
        }
      }
    }

    return builder.build();
  }
}

// ---------------------------------------------------------------------------
// Definition provider  (F12 + Cmd+Click)
// ---------------------------------------------------------------------------

class MixinDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    const hit = mixinHitAt(document, position);
    if (!hit) return undefined;

    const index = await getIndex();
    const locs = index.get(hit.name);
    if (!locs?.length) return undefined;

    return locs.map(
      (loc) => new vscode.Location(vscode.Uri.file(loc.file), new vscode.Position(loc.line, 0))
    );
  }
}

// ---------------------------------------------------------------------------
// Reference provider  (Shift+F12 — @define-mixin → all uses)
// ---------------------------------------------------------------------------

class MixinReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    const lineText = document.lineAt(position.line).text;
    const defMatch = DEFINE_RE.exec(lineText);
    if (!defMatch) return undefined;

    const name = defMatch[1];
    const uris = await vscode.workspace.findFiles(getGlob(), '**/node_modules/**');
    const results: vscode.Location[] = [];

    for (const uri of uris) {
      let content: string;
      try {
        content = fs.readFileSync(uri.fsPath, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        USE_RE_G.lastIndex = 0;
        const m = USE_RE_G.exec(lines[i]);
        if (m && m[1] === name) {
          results.push(new vscode.Location(uri, new vscode.Position(i, 0)));
        }
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Hover provider — shows full mixin body (scrollable) anchored to name range
// ---------------------------------------------------------------------------

class MixinHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const hit = mixinHitAt(document, position);
    if (!hit) return undefined;

    const index = await getIndex();
    const locs = index.get(hit.name);
    if (!locs?.length) return undefined;

    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    md.supportHtml = false;

    let anyBlock = false;
    for (let i = 0; i < locs.length; i++) {
      const loc = locs[i];
      let content: string;
      try {
        content = fs.readFileSync(loc.file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      const body = extractMixinBody(lines, loc.line);
      const fileName = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        loc.file
      );

      if (i > 0 && anyBlock) {
        md.appendMarkdown('\n\n---\n\n');
      }
      md.appendMarkdown('`');
      md.appendText(fileName);
      md.appendMarkdown('`\n\n');
      md.appendCodeblock(body, 'css');
      anyBlock = true;
    }

    if (!anyBlock) return undefined;

    return new vscode.Hover(md, hit.range);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: 'css' },
    { language: 'postcss' },
    { language: 'scss' },
    { scheme: 'file', pattern: '**/*.css' },
    { scheme: 'file', pattern: '**/*.pcss' },
    { scheme: 'file', pattern: '**/*.postcss' },
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(selector, new MixinSemanticTokensProvider(), LEGEND),
    vscode.languages.registerDefinitionProvider(selector, new MixinDefinitionProvider()),
    vscode.languages.registerReferenceProvider(selector, new MixinReferenceProvider()),
    vscode.languages.registerHoverProvider(selector, new MixinHoverProvider())
  );

  // Eagerly build index
  getIndex();

  // Watch for file changes
  const watcher = vscode.workspace.createFileSystemWatcher(getGlob());
  watcher.onDidChange((uri) => { if (!cachedIndex) return; removeFileFromIndex(cachedIndex, uri.fsPath); addFileToIndex(cachedIndex, uri.fsPath); });
  watcher.onDidCreate((uri) => { if (!cachedIndex) return; addFileToIndex(cachedIndex, uri.fsPath); });
  watcher.onDidDelete((uri) => { if (!cachedIndex) return; removeFileFromIndex(cachedIndex, uri.fsPath); });
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('postcssMixinNav.rebuildIndex', () => {
      cachedIndex = undefined;
      getIndex().then(() => vscode.window.showInformationMessage('PostCSS Mixin Navigator: index rebuilt.'));
    })
  );
}

export function deactivate(): void {
  cachedIndex = undefined;
}
