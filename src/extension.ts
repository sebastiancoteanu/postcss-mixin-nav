import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Matches: @define-mixin mixinName  or  @define-mixin mixinName $param1 {
const DEFINE_RE = /^\s*@define-mixin\s+([\w-]+)/;

// Matches: @mixin mixinName  or  @mixin mixinName arg1, arg2;
const USE_RE = /\bmixin\s+([\w-]+)/;

// ---------------------------------------------------------------------------
// Index: map of mixin-name -> array of { file, line }
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
// Resolve what mixin the cursor is on.
// Returns { name, range } if the cursor is on a @mixin call, else undefined.
// ---------------------------------------------------------------------------

type MixinHit = { name: string; range: vscode.Range };

function mixinHitAt(
  document: vscode.TextDocument,
  position: vscode.Position
): MixinHit | undefined {
  const lineText = document.lineAt(position.line).text;

  // Only look at lines that are @mixin calls (not @define-mixin)
  if (!lineText.includes('@mixin') || lineText.includes('@define-mixin')) {
    return undefined;
  }

  // Walk all @mixin occurrences on the line (there's almost always one)
  const re = /@mixin\s+([\w-]+)/g;
  let m: RegExpExecArray | null;

  while ((m = re.exec(lineText)) !== null) {
    const name = m[1];
    // Start of the name token inside the match
    const nameStart = m.index + m[0].indexOf(name);
    const nameEnd = nameStart + name.length;
    const col = position.character;

    // Accept if cursor is anywhere from the '@' to the last char of the name
    if (col >= m.index && col <= nameEnd) {
      const range = new vscode.Range(
        new vscode.Position(position.line, nameStart),
        new vscode.Position(position.line, nameEnd)
      );
      return { name, range };
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// DefinitionProvider  (F12 and Cmd+Click)
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
      (loc) =>
        new vscode.Location(vscode.Uri.file(loc.file), new vscode.Position(loc.line, 0))
    );
  }
}

// ---------------------------------------------------------------------------
// ReferenceProvider  (Shift+F12 — from @define-mixin → all uses)
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
    const glob = getGlob();
    const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**');
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
        const m = USE_RE.exec(lines[i]);
        if (m && m[1] === name) {
          results.push(new vscode.Location(uri, new vscode.Position(i, 0)));
        }
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// HoverProvider — shows the mixin definition body inline
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

    const previews: string[] = [];
    for (const loc of locs) {
      let content: string;
      try {
        content = fs.readFileSync(loc.file, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      const snippet = lines.slice(loc.line, loc.line + 10).join('\n');
      const fileName = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        loc.file
      );
      previews.push(`**${fileName}**\n\`\`\`css\n${snippet}\n\`\`\``);
    }

    if (previews.length === 0) return undefined;

    const md = new vscode.MarkdownString(previews.join('\n\n---\n\n'));
    // Return hover with explicit range so it anchors to the mixin name token
    return new vscode.Hover(md, hit.range);
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  // Register for any language that might be used with CSS/PostCSS files.
  // The file-pattern entry is the catch-all for editors that use unusual language IDs.
  const selector: vscode.DocumentSelector = [
    { language: 'css' },
    { language: 'postcss' },
    { language: 'scss' },
    { scheme: 'file', pattern: '**/*.css' },
    { scheme: 'file', pattern: '**/*.pcss' },
    { scheme: 'file', pattern: '**/*.postcss' },
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new MixinDefinitionProvider()),
    vscode.languages.registerReferenceProvider(selector, new MixinReferenceProvider()),
    vscode.languages.registerHoverProvider(selector, new MixinHoverProvider())
  );

  // Eagerly kick off index build so first Cmd+Click isn't slow
  getIndex();

  // Keep index in sync with file changes
  const watcher = vscode.workspace.createFileSystemWatcher(getGlob());
  watcher.onDidChange((uri) => {
    if (!cachedIndex) return;
    removeFileFromIndex(cachedIndex, uri.fsPath);
    addFileToIndex(cachedIndex, uri.fsPath);
  });
  watcher.onDidCreate((uri) => {
    if (!cachedIndex) return;
    addFileToIndex(cachedIndex, uri.fsPath);
  });
  watcher.onDidDelete((uri) => {
    if (!cachedIndex) return;
    removeFileFromIndex(cachedIndex, uri.fsPath);
  });
  context.subscriptions.push(watcher);

  // Manual rebuild command
  context.subscriptions.push(
    vscode.commands.registerCommand('postcssMixinNav.rebuildIndex', () => {
      cachedIndex = undefined;
      getIndex().then(() =>
        vscode.window.showInformationMessage('PostCSS Mixin Navigator: index rebuilt.')
      );
    })
  );
}

export function deactivate(): void {
  cachedIndex = undefined;
}
