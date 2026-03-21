import * as vscode from 'vscode';
import { BinsleuthViewProvider } from './panel';

const BINARY_EXTS = new Set([
  '.elf', '.exe', '.dll', '.so', '.bin', '.o', '.a', '.dylib', '.out',
]);

export function activate(context: vscode.ExtensionContext): void {
  const provider = new BinsleuthViewProvider(context.extensionUri);

  // Register the sidebar Webview view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      BinsleuthViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // Command: analyze file selected in explorer context menu
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'binsleuth.analyzeFile',
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showErrorMessage('BinSleuth: No file selected.');
          return;
        }
        await provider.analyzeFile(target.fsPath);
      },
    ),
  );

  // Command: analyze the currently active text editor
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'binsleuth.analyzeActiveFile',
      async () => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) {
          vscode.window.showErrorMessage('BinSleuth: No active file.');
          return;
        }
        await provider.analyzeFile(uri.fsPath);
      },
    ),
  );

  // Auto-analyze when a binary-looking file becomes active
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (!editor) {
        return;
      }
      const fsPath = editor.document.uri.fsPath;
      const ext = fsPath.slice(fsPath.lastIndexOf('.')).toLowerCase();
      if (BINARY_EXTS.has(ext)) {
        await provider.analyzeFile(fsPath);
      }
    }),
  );
}

export function deactivate(): void {
  // Nothing to clean up.
}
