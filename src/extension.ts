import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Matches: @define-mixin mixinName  or  @define-mixin mixinName $param1, $param2 {
const DEFINE_RE = /^\s*@define-mixin\s+([\w-]+)/;

// Matches: @mixin mixinName  or  @mixin mixinName arg1, arg2;  or  @mixin mixinName {
const USE_RE = /^\s*@mixin\s+([\w-]+)/;

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
    const match = DEFINE_RE.exec(lines[i]);
    if (match) {
      const name = match[1];
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
  return vscode.workspace.getConfiguration('postcssMixinNav').get<string>('fileGlob') ?? '**/*.{css,pcss,postcss}';
}

async function getIndex(): Promise<Index> {
  if (cachedIndex) {
    return cachedIndex;
  }
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
// Extract mixin name under cursor
// ---------------------------------------------------------------------------

function mixinNameAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const line = document.lineAt(position.line).text;
  const match = USE_RE.exec(line);
  if (!match) {
    return undefined;
  }

  const name = match[1];
  // Ensure cursor is on or after "@mixin" keyword but still on the name token.
  const nameStart = line.indexOf(name, line.indexOf('@mixin') + 6);
  const nameEnd = nameStart + name.length;
  const col = position.character;

  // Accept if cursor is anywhere on the line from @mixin to end of name.
  const atMixinStart = line.indexOf('@mixin');
  if (col < atMixinStart || col > nameEnd) {
    return undefined;
  }

  return name;
}

// ---------------------------------------------------------------------------
// DefinitionProvider
// ---------------------------------------------------------------------------

class MixinDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location | vscode.Location[] | undefined> {
    const name = mixinNameAt(document, position);
    if (!name) {
      return undefined;
    }

    const index = await getIndex();
    const locs = index.get(name);
    if (!locs || locs.length === 0) {
      return undefined;
    }

    return locs.map(
      (loc) =>
        new vscode.Location(
          vscode.Uri.file(loc.file),
          new vscode.Position(loc.line, 0)
        )
    );
  }
}

// ---------------------------------------------------------------------------
// ReferenceProvider (from @define-mixin → all @mixin uses)
// ---------------------------------------------------------------------------

class MixinReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Location[] | undefined> {
    const line = document.lineAt(position.line).text;
    const defMatch = DEFINE_RE.exec(line);
    if (!defMatch) {
      return undefined;
    }
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
// HoverProvider — shows the mixin definition body on hover
// ---------------------------------------------------------------------------

class MixinHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const name = mixinNameAt(document, position);
    if (!name) {
      return undefined;
    }

    const index = await getIndex();
    const locs = index.get(name);
    if (!locs || locs.length === 0) {
      return undefined;
    }

    const previews: string[] = [];
    for (const loc of locs) {
      let content: string;
      try {
        content = fs.readFileSync(loc.file, 'utf8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      // Grab up to 10 lines from the definition
      const snippet = lines.slice(loc.line, loc.line + 10).join('\n');
      const fileName = path.relative(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
        loc.file
      );
      previews.push(`**${fileName}**\n\`\`\`css\n${snippet}\n\`\`\``);
    }

    if (previews.length === 0) {
      return undefined;
    }

    return new vscode.Hover(new vscode.MarkdownString(previews.join('\n\n---\n\n')));
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = [
    { language: 'css' },
    { language: 'postcss' },
    { scheme: 'file', pattern: '**/*.{css,pcss,postcss}' },
  ];

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(selector, new MixinDefinitionProvider()),
    vscode.languages.registerReferenceProvider(selector, new MixinReferenceProvider()),
    vscode.languages.registerHoverProvider(selector, new MixinHoverProvider())
  );

  // Keep index up to date when files change
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

  // Command to manually rebuild the index
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
