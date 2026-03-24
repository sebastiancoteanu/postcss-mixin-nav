"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// Matches: @define-mixin mixinName  or  @define-mixin mixinName $param1, $param2 {
const DEFINE_RE = /^\s*@define-mixin\s+([\w-]+)/;
// Matches: @mixin mixinName  or  @mixin mixinName arg1, arg2;  or  @mixin mixinName {
const USE_RE = /^\s*@mixin\s+([\w-]+)/;
let cachedIndex;
let indexPromise;
async function buildIndex(glob) {
    const index = new Map();
    const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**');
    for (const uri of uris) {
        addFileToIndex(index, uri.fsPath);
    }
    return index;
}
function addFileToIndex(index, filePath) {
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    }
    catch {
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
function removeFileFromIndex(index, filePath) {
    for (const [name, locs] of index) {
        const filtered = locs.filter((l) => l.file !== filePath);
        if (filtered.length === 0) {
            index.delete(name);
        }
        else {
            index.set(name, filtered);
        }
    }
}
function getGlob() {
    return vscode.workspace.getConfiguration('postcssMixinNav').get('fileGlob') ?? '**/*.{css,pcss,postcss}';
}
async function getIndex() {
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
function mixinNameAt(document, position) {
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
class MixinDefinitionProvider {
    async provideDefinition(document, position) {
        const name = mixinNameAt(document, position);
        if (!name) {
            return undefined;
        }
        const index = await getIndex();
        const locs = index.get(name);
        if (!locs || locs.length === 0) {
            return undefined;
        }
        return locs.map((loc) => new vscode.Location(vscode.Uri.file(loc.file), new vscode.Position(loc.line, 0)));
    }
}
// ---------------------------------------------------------------------------
// ReferenceProvider (from @define-mixin → all @mixin uses)
// ---------------------------------------------------------------------------
class MixinReferenceProvider {
    async provideReferences(document, position) {
        const line = document.lineAt(position.line).text;
        const defMatch = DEFINE_RE.exec(line);
        if (!defMatch) {
            return undefined;
        }
        const name = defMatch[1];
        const glob = getGlob();
        const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**');
        const results = [];
        for (const uri of uris) {
            let content;
            try {
                content = fs.readFileSync(uri.fsPath, 'utf8');
            }
            catch {
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
class MixinHoverProvider {
    async provideHover(document, position) {
        const name = mixinNameAt(document, position);
        if (!name) {
            return undefined;
        }
        const index = await getIndex();
        const locs = index.get(name);
        if (!locs || locs.length === 0) {
            return undefined;
        }
        const previews = [];
        for (const loc of locs) {
            let content;
            try {
                content = fs.readFileSync(loc.file, 'utf8');
            }
            catch {
                continue;
            }
            const lines = content.split('\n');
            // Grab up to 10 lines from the definition
            const snippet = lines.slice(loc.line, loc.line + 10).join('\n');
            const fileName = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '', loc.file);
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
function activate(context) {
    const selector = [
        { language: 'css' },
        { language: 'postcss' },
        { scheme: 'file', pattern: '**/*.{css,pcss,postcss}' },
    ];
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, new MixinDefinitionProvider()), vscode.languages.registerReferenceProvider(selector, new MixinReferenceProvider()), vscode.languages.registerHoverProvider(selector, new MixinHoverProvider()));
    // Keep index up to date when files change
    const watcher = vscode.workspace.createFileSystemWatcher(getGlob());
    watcher.onDidChange((uri) => {
        if (!cachedIndex)
            return;
        removeFileFromIndex(cachedIndex, uri.fsPath);
        addFileToIndex(cachedIndex, uri.fsPath);
    });
    watcher.onDidCreate((uri) => {
        if (!cachedIndex)
            return;
        addFileToIndex(cachedIndex, uri.fsPath);
    });
    watcher.onDidDelete((uri) => {
        if (!cachedIndex)
            return;
        removeFileFromIndex(cachedIndex, uri.fsPath);
    });
    context.subscriptions.push(watcher);
    // Command to manually rebuild the index
    context.subscriptions.push(vscode.commands.registerCommand('postcssMixinNav.rebuildIndex', () => {
        cachedIndex = undefined;
        getIndex().then(() => vscode.window.showInformationMessage('PostCSS Mixin Navigator: index rebuilt.'));
    }));
}
function deactivate() {
    cachedIndex = undefined;
}
