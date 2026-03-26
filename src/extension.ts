import * as vscode from 'vscode';
import { PhotoEditorProvider } from './editorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new PhotoEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'myPhotoEditor.cropTool',
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
      }
    )
  );
}

export function deactivate(): void {
  // cleanup if needed
}
