import * as vscode from 'vscode';
import * as path from 'path';

export class PhotoEditorProvider implements vscode.CustomEditorProvider<vscode.CustomDocument> {
  private readonly _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  // --- CustomEditorProvider lifecycle ---

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentContentChangeEvent<vscode.CustomDocument>
  >();
  public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  public async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  public async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('\\'))),
        vscode.Uri.file(document.uri.fsPath.substring(0, document.uri.fsPath.lastIndexOf('/'))),
      ],
    };

    const imageUri = webviewPanel.webview.asWebviewUri(document.uri);
    const fsPath = document.uri.fsPath;
    const imageDir = path.dirname(fsPath);
    const originalFileName = path.basename(fsPath);
    const sep = path.sep;
    const version = vscode.extensions.getExtension('quinn.my-photo-editor')?.packageJSON.version || '1.0.0';
    webviewPanel.webview.html = this._getHtmlForWebview(imageUri, originalFileName, version);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'save': {
          try {
            const dataUrl: string = message.dataUrl;
            const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            const binaryData = Buffer.from(base64Data, 'base64');
            await vscode.workspace.fs.writeFile(document.uri, new Uint8Array(binaryData));
            vscode.window.showInformationMessage(`Photo saved successfully: ${document.uri.fsPath}`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to save photo: ${err?.message || err}`);
          }
          break;
        }
        case 'saveAnnotations': {
          try {
            const dir = message.folder || imageDir;
            const baseName = message.fileName || ('zMarkdown_' + originalFileName.replace(/\.[^.]+$/, ''));
            const screenshotDataUrl: string = message.screenshotDataUrl;
            const screenshotBase64 = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, '');
            const screenshotBuf = Buffer.from(screenshotBase64, 'base64');
            const screenshotPath = vscode.Uri.file(dir + sep + baseName + '_annotated.png');
            await vscode.workspace.fs.writeFile(screenshotPath, new Uint8Array(screenshotBuf));
            const jsonPath = vscode.Uri.file(dir + sep + baseName + '.annotations.json');
            const data = {
              metadata: {
                version: baseName.substring(baseName.lastIndexOf('_A') + 1) || 'A1',
                source: originalFileName,
                timestamp: new Date().toISOString(),
                software: 'Photo Editor (Antigravity Edition)'
              },
              annotations: message.annotations
            };
            const jsonData = JSON.stringify(data, null, 2);
            await vscode.workspace.fs.writeFile(jsonPath, new Uint8Array(Buffer.from(jsonData, 'utf-8')));
            const annotations = message.annotations as any[];
            let mdContent = '# ' + baseName + '\n\n';
            mdContent += '> Annotated from: `' + originalFileName + '`\n\n';
            mdContent += '![Annotated Screenshot](./' + baseName + '_annotated.png)\n\n';
            mdContent += '## Annotations\n\n';
            mdContent += '| Label | Type | Color | Coordinates | Note |\n';
            mdContent += '|-------|------|-------|-------------|------|\n';
            for (const ann of annotations) {
              let coords = '';
              if (ann.type === 'box') {
                coords = 'x:' + Math.round(ann.x) + ' y:' + Math.round(ann.y) + ' w:' + Math.round(ann.w) + ' h:' + Math.round(ann.h);
              } else {
                coords = 'x1:' + Math.round(ann.x1) + ' y1:' + Math.round(ann.y1) + ' x2:' + Math.round(ann.x2) + ' y2:' + Math.round(ann.y2);
              }
              mdContent += '| ' + ann.id + ' | ' + ann.type + ' | ' + ann.color + ' | ' + coords + ' | ' + (ann.note || '') + ' |\n';
            }
            const mdPath = vscode.Uri.file(dir + sep + baseName + '.md');
            await vscode.workspace.fs.writeFile(mdPath, new Uint8Array(Buffer.from(mdContent, 'utf-8')));
            vscode.window.showInformationMessage('Annotations saved: ' + baseName);
            webviewPanel.webview.postMessage({ type: 'annotationsSaved', fileName: baseName });
          } catch (err: any) {
            vscode.window.showErrorMessage('Failed to save annotations: ' + (err?.message || err));
          }
          break;
        }
        case 'loadAnnotations': {
          try {
            const data = await vscode.workspace.fs.readFile(vscode.Uri.file(message.filePath));
            const json = JSON.parse(Buffer.from(data).toString('utf-8'));
            const annotations = Array.isArray(json) ? json : (json.annotations || []);
            webviewPanel.webview.postMessage({ type: 'annotationsLoaded', annotations: annotations, fileName: message.fileName });
          } catch (err: any) {
            vscode.window.showErrorMessage('Failed to load annotations: ' + (err?.message || err));
          }
          break;
        }
        case 'listSavedAnnotations': {
          try {
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(imageDir));
            const files = entries
              .filter(([n]) => n.toLowerCase().endsWith('.annotations.json'))
              .map(([n]) => ({
                name: n.substring(0, n.length - 17), 
                fullPath: path.join(imageDir, n),
              }));
            webviewPanel.webview.postMessage({ type: 'savedAnnotationsList', files });
          } catch { webviewPanel.webview.postMessage({ type: 'savedAnnotationsList', files: [] }); }
          break;
        }
        case 'deleteAnnotationSet': {
          try {
            const pathBase = message.filePath.replace('.annotations.json', '');
            const jsonUri = vscode.Uri.file(message.filePath);
            const mdUri = vscode.Uri.file(pathBase + '.md');
            const pngUri = vscode.Uri.file(pathBase + '_annotated.png');
            await vscode.workspace.fs.delete(jsonUri, { recursive: false, useTrash: true });
            try { await vscode.workspace.fs.delete(mdUri, { recursive: false, useTrash: true }); } catch {}
            try { await vscode.workspace.fs.delete(pngUri, { recursive: false, useTrash: true }); } catch {}
            vscode.window.showInformationMessage('Deleted: ' + message.fileName);
            // Refresh list
            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(imageDir));
            const files = entries.filter(([n]) => n.endsWith('.annotations.json')).map(([n]) => ({
              name: n.replace('.annotations.json', ''), fullPath: imageDir + sep + n,
            }));
            webviewPanel.webview.postMessage({ type: 'savedAnnotationsList', files });
          } catch (err: any) {
            vscode.window.showErrorMessage('Failed to delete: ' + (err?.message || err));
          }
          break;
        }
        case 'pickFolder': {
          const result = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            defaultUri: vscode.Uri.file(imageDir), openLabel: 'Select Folder',
          });
          if (result && result.length > 0) {
            webviewPanel.webview.postMessage({ type: 'folderPicked', folder: result[0].fsPath });
          }
          break;
        }
      }
    });
  }

  // --- Persistence stubs ---
  public async saveCustomDocument(_d: vscode.CustomDocument, _c: vscode.CancellationToken): Promise<void> {}
  public async saveCustomDocumentAs(_d: vscode.CustomDocument, _u: vscode.Uri, _c: vscode.CancellationToken): Promise<void> {}
  public async revertCustomDocument(_d: vscode.CustomDocument, _c: vscode.CancellationToken): Promise<void> {}
  public async backupCustomDocument(_d: vscode.CustomDocument, _ctx: vscode.CustomDocumentBackupContext, _c: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return { id: _ctx.destination.toString(), delete: () => {} };
  }

  // --- Webview HTML ---
  private _getHtmlForWebview(imageUri: vscode.Uri, originalFileName: string, version: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Photo Editor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden;font-family:var(--vscode-font-family,system-ui,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background);user-select:none}
.toolbar{display:flex;gap:8px;align-items:center;padding:10px 16px;width:100%;background:var(--vscode-editorWidget-background,#252526);border-bottom:1px solid var(--vscode-editorWidget-border,#454545);z-index:10;flex-shrink:0}
.toolbar .title{font-size:13px;font-weight:600;opacity:.85;margin-right:auto;cursor:pointer;transition:opacity .15s}
.toolbar .title:hover{opacity:1}
.toolbar button{padding:6px 14px;border:none;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;transition:opacity .15s,filter .15s}
.toolbar button:hover{filter:brightness(1.15)}.toolbar button:active{filter:brightness(.9)}
.btn-primary{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff)}
.btn-secondary{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc)}
.btn-save{background:#2ea043;color:#fff}
.btn-annot{background:#b8860b;color:#fff}.btn-annot.active{background:#daa520;color:#000}
.btn-mirror{background:#8e44ad;color:#fff}.btn-mirror.active{background:#9b59b6;border:2px solid #fff}
.toolbar button:disabled{opacity:.4;cursor:default;filter:none}
.hidden{display:none!important}
body.minimized .toolbar{border-bottom:none}
body.minimized .toolbar button,body.minimized .nav-buttons,body.minimized .status-bar{display:none!important}
.main-area{display:flex;flex:1;overflow:hidden}
.canvas-wrapper{flex:1;overflow:hidden;position:relative}
canvas{display:block;width:100%;height:100%}
.nav-buttons{position:absolute;top:10px;right:22px;display:flex;flex-direction:column;gap:4px;z-index:5}.nav-buttons.sidebar-style{position:static;padding:12px;border-bottom:1px solid rgba(255,255,255,0.1);background:transparent;backdrop-filter:none}
.nav-buttons button{padding:5px 10px;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer;background:rgba(50,50,50,.85);color:#ddd;backdrop-filter:blur(4px);transition:background .15s;white-space:nowrap}
.nav-buttons.sidebar-style button{width:100%;text-align:center;background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#ccc)}
.nav-buttons button:hover{background:rgba(80,80,80,.9)}
.nav-divider{height:1px;background:rgba(255,255,255,.2);margin:4px 0}
.resizer{width:6px;cursor:col-resize;background:var(--vscode-editorWidget-border,#454545);z-index:15;transition:background 0.15s;flex-shrink:0}
.resizer:hover{background:var(--vscode-focusBorder,#007fd4)}
.annotation-toolbar{display:flex;gap:4px;padding:6px 12px;background:var(--vscode-editorWidget-background,#252526);border-bottom:1px solid var(--vscode-editorWidget-border,#454545);z-index:6;justify-content:center;flex-shrink:0}
.annotation-toolbar button{width:32px;height:32px;border:2px solid transparent;border-radius:6px;cursor:pointer;font-size:10px;font-weight:700;transition:all .15s;display:flex;align-items:center;justify-content:center}
.annotation-toolbar button.active{border-color:#fff;transform:scale(1.1)}
.annotation-toolbar .sep{width:1px;background:rgba(255,255,255,.2);margin:0 12px}
.tool-group{display:flex;align-items:center;gap:6px}
.tool-group span{font-size:9px;opacity:0.5;font-weight:700;letter-spacing:0.5px;margin-right:2px}
.atb-box{color:#fff;font-size:16px!important}.atb-line{color:#fff;font-size:18px!important}
.atb-save-btn{background:#2ea043!important;color:#fff!important;width:auto!important;padding:0 10px!important;font-size:11px!important}
.notes-panel{width:280px;min-width:150px;max-width:800px;background:var(--vscode-editorWidget-background,#252526);border-left:1px solid var(--vscode-editorWidget-border,#454545);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
.notes-header{padding:10px 12px;font-size:12px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.1);display:flex;justify-content:space-between;align-items:center}
.notes-list{flex:1;overflow-y:auto;padding:6px}
.note-item{padding:8px;margin-bottom:6px;border-radius:6px;border-left:4px solid;background:rgba(255,255,255,.04);cursor:pointer;transition:background .15s}
.note-item:hover{background:rgba(255,255,255,.08)}.note-item.selected{background:rgba(255,255,255,.12)}
.note-item-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.note-item-label{font-size:11px;font-weight:600}
.note-item-coords{font-size:10px;opacity:.6;font-family:monospace;margin-bottom:4px}
.note-item-input{width:100%;padding:4px 6px;border:1px solid rgba(255,255,255,.15);border-radius:3px;background:rgba(0,0,0,.3);color:inherit;font-size:11px;font-family:inherit;resize:vertical;min-height:28px}
.note-delete-btn{background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;padding:0 4px;opacity:.7;transition:opacity .15s}
.note-delete-btn:hover{opacity:1}
.modal-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.6);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)}
.modal{background:var(--vscode-editorWidget-background,#2d2d2d);border-radius:10px;padding:24px;width:640px;max-width:90%;border:1px solid rgba(255,255,255,.15)}
.modal h3{margin-bottom:16px;font-size:15px}
.modal label{font-size:12px;opacity:.8;display:block;margin-bottom:4px}
.modal input[type=text]{width:100%;padding:8px 10px;border:1px solid rgba(255,255,255,0.2);border-radius:5px;background:rgba(0,0,0,0.3);color:inherit;font-size:13px;margin-bottom:12px}
.modal input[type=text].conflict{border-color:#e74c3c;box-shadow:0 0 5px rgba(231,76,60,0.5)}
.conflict-msg{color:#e74c3c;font-size:10px;margin-top:-10px;margin-bottom:10px;display:none}
.input-wrap{position:relative;flex:1}
.btn-increment{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:24px;height:24px;border:none;border-radius:4px;background:none;color:#e74c3c;font-size:20px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:color .15s}
.btn-increment.available{color:#2ecc71}
.btn-increment:hover{background:rgba(255,255,255,.05)}
.modal-buttons{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.modal-buttons button{padding:7px 16px;border:none;border-radius:5px;font-size:12px;cursor:pointer}
.saved-dropdown{position:absolute;top:100%;left:0;min-width:250px;max-height:300px;overflow-y:auto;background:var(--vscode-editorWidget-background,#2d2d2d);border:1px solid rgba(255,255,255,.15);border-radius:6px;z-index:20;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.saved-dropdown-item{padding:4px 4px 4px 12px;cursor:pointer;font-size:12px;transition:background .1s;border-bottom:1px solid rgba(255,255,255,.05);display:flex;justify-content:space-between;align-items:center}
.saved-dropdown-item:hover{background:rgba(255,255,255,.1)}
.saved-delete-btn{color:#e74c3c;padding:4px 10px;font-size:16px;font-weight:bold;opacity:.5;transition:opacity .15s}
.saved-delete-btn:hover{opacity:1}.saved-delete-btn.confirm{background:#e74c3c;color:#fff;font-size:10px;border-radius:3px;padding:4px 8px;margin-right:4px}
.floating-confirm{position:absolute;z-index:20;background:#2ea043;color:#fff;border:none;border-radius:50%;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,0.4);border:2px solid #fff}
.mirror-fine-tune{position:absolute;z-index:25;display:flex;gap:4px;background:rgba(30,30,30,0.95);padding:4px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);box-shadow:0 4px 12px rgba(0,0,0,0.5);align-items:center}
.mirror-fine-tune button{width:32px;height:32px;background:var(--vscode-button-secondaryBackground,#3a3d41);color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:16px;display:flex;align-items:center;justify-content:center}
.mirror-fine-tune button:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e)}
.mirror-fine-tune .val{font-size:10px;font-family:monospace;min-width:40px;text-align:center;color:#fff;font-weight:bold}
.status-bar{width:100%;padding:4px 16px;font-size:11px;opacity:.6;background:var(--vscode-editorWidget-background,#252526);border-top:1px solid var(--vscode-editorWidget-border,#454545);text-align:center;flex-shrink:0}
.modal-list{margin-top:10px;max-height:100px;overflow-y:auto;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:4px}
.modal-list-item{font-size:11px;padding:4px 8px;opacity:0.8;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.05)}
.modal-list-item:last-child{border-bottom:none}
.modal-list-label{font-size:10px;text-transform:uppercase;opacity:0.5;letter-spacing:0.5px;margin-top:12px;margin-bottom:4px}
.trim-add-section{padding:10px;border-top:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:6px;background:rgba(255,255,255,0.02)}
.trim-add-section input{width:100%;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);color:#fff;padding:4px 6px;border-radius:4px;font-size:11px}
.trim-edge-toggle{display:flex;gap:4px}.trim-edge-toggle button{flex:1;font-size:9px;padding:3px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#aaa;border-radius:3px;cursor:pointer}
.trim-edge-toggle button.active{background:var(--vscode-button-background);color:#fff;border-color:transparent}
.trim-item{padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.03)}
.trim-item:hover{background:rgba(255,255,255,0.08)}
.trim-item .edge-tag{font-size:8px;font-weight:bold;padding:1px 6px;border-radius:3px;margin-right:8px;min-width:32px;text-align:center}
.trim-tag-top{background:#2ea043;color:#fff}.trim-tag-bottom{background:#0e639c;color:#fff}
.trim-add-panel{padding:12px;background:rgba(255,255,255,0.03);border-top:1px solid rgba(255,255,255,0.1);display:flex;flex-direction:column;gap:10px}
.trim-add-label{font-size:9px;font-weight:bold;opacity:0.6;text-transform:uppercase;margin-bottom:-4px}
.trim-add-footer{display:flex;gap:4px;margin-top:4px}
.trim-plus-btn{width:100%;padding:8px;background:none;border:1px dashed rgba(255,255,255,0.2);color:#aaa;border-radius:4px;cursor:pointer;font-size:11px;transition:all 0.1s}
.trim-plus-btn:hover{background:rgba(255,255,255,0.05);color:#fff;border-color:rgba(255,255,255,0.4)}
</style></head>
<body>
<div class="toolbar">
  <div style="display:flex;align-items:center;margin-right:auto">
  <div class="title" id="titleToggle" style="display:flex;flex-direction:column;line-height:1;justify-content:center">
    <span style="font-size:14px;font-weight:800;letter-spacing:1px">CROP</span>
    <span style="font-size:9px;opacity:0.4;font-weight:bold;margin-top:1px">v${version}</span>
  </div>
  <div id="fileInfo" class="hidden" style="margin-left:16px;border-left:1px solid rgba(255,255,255,0.15);padding-left:16px;display:flex;flex-direction:column;justify-content:center;line-height:1.1;max-width:350px">
    <div id="filePrefix" style="font-size:8px;opacity:0.4;text-transform:uppercase;letter-spacing:0.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
    <div id="fileMain" style="font-size:11px;font-weight:500;color:rgba(255,255,255,0.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
  </div>
  <span id="cropPresetsWrap" class="hidden" style="position:relative;margin-left:12px">
    <button class="btn-secondary" id="btnCropPresets">&#9991; Trim</button>
    <div class="saved-dropdown hidden" id="cropPresetsDropdown" style="min-width:180px"></div>
  </span>
</div>
  <span id="savedAnnotationsWrap" class="hidden" style="position:relative">
    <button class="btn-secondary" id="btnSavedAnnotations">&#128203; Saved</button>
    <div class="saved-dropdown hidden" id="savedDropdown"></div>
  </span>
  <button class="btn-primary" id="btnCrop">Crop</button>
  <button class="btn-secondary hidden" id="btnCancel">Cancel</button>
  <button class="btn-secondary" id="btnReset">Reset</button>
  <button class="btn-secondary" id="btnFit">Fit</button>
  <button class="btn-mirror" id="btnMirror">Mirror Fix</button>
  <span id="mirrorToolbarButtons" class="hidden" style="display:flex;gap:4px">
    <button id="btnMirrorOkTop" style="background:#2ea043;color:#fff">&check; Apply Mirror</button>
    <button id="btnMirrorCancelTop" style="background:#e74c3c;color:#fff">&times; Cancel Box</button>
  </span>
  <button class="btn-save" id="btnSave" disabled>Crops save</button>
</div>
<div class="annotation-toolbar hidden" id="annotToolbar">
  <div class="tool-group">
    <span>BOX:</span>
    <button class="atb-box" style="background:#e74c3c" data-tool="box" data-color="red" title="Red Box">&#9634;</button>
    <button class="atb-box" style="background:#3498db" data-tool="box" data-color="blue" title="Blue Box">&#9634;</button>
    <button class="atb-box" style="background:#2ecc71" data-tool="box" data-color="green" title="Green Box">&#9634;</button>
    <button class="atb-box" style="background:#f1c40f;color:#333" data-tool="box" data-color="yellow" title="Yellow Box">&#9634;</button>
  </div>
  <div class="sep"></div>
  <div class="tool-group">
    <span>DASH:</span>
    <button class="atb-line" style="background:#e74c3c" data-tool="line" data-color="red" title="Red Line">&#10515;</button>
    <button class="atb-line" style="background:#3498db" data-tool="line" data-color="blue" title="Blue Line">&#10515;</button>
    <button class="atb-line" style="background:#2ecc71" data-tool="line" data-color="green" title="Green Line">&#10515;</button>
    <button class="atb-line" style="background:#f1c40f;color:#333" data-tool="line" data-color="yellow" title="Yellow Line">&#10515;</button>
  </div>
  <div class="sep"></div>
  <span id="unsavedIndicator" class="hidden" style="color:#f1c40f;font-size:10px;font-weight:bold;margin-right:8px">&bullet; UNSAVED CHANGES</span>
  <button class="atb-save-btn" id="btnSaveAnnotations">💾 Annotation save</button>
  <button class="atb-save-btn" id="btnNewSaveAnnotations" style="background:#0e639c!important">💾 New Annotation save</button>
</div>
<div class="main-area">
  <div class="canvas-wrapper" id="wrapper">
    <canvas id="canvas"></canvas>
    <div class="nav-buttons" id="navButtons">
      <button id="btnZoomIn">&#10133; Zoom In</button>
      <button id="btnZoomOut">&#10134; Zoom Out</button>
      <div class="nav-divider"></div>
      <button id="btnFitTop">&#11014; Fit Width &middot; Top</button>
      <button id="btnFitBottom">&#11015; Fit Width &middot; Bottom</button>
      <div class="nav-divider"></div>
      <button id="btnAnnotationMode" class="btn-annot">A &middot; Annotation Mode</button>
    </div>
    <button id="btnMirrorConfirm" class="floating-confirm hidden">&check;</button>
    <button id="btnMirrorX" class="floating-confirm hidden" style="background:#e74c3c">&times;</button>
    <div class="mirror-fine-tune hidden" id="mirrorFT">
      <button id="btnMirrorOffsetL" title="Shift Centerline Left (-0.5px)">&larr;</button>
      <div class="val" id="mirrorOffsetVal">0.0</div>
      <button id="btnMirrorOffsetR" title="Shift Centerline Right (+0.5px)">&rarr;</button>
    </div>
  </div>
  <div class="resizer hidden" id="resizer"></div>
  <div class="notes-panel hidden" id="notesPanel">
    <div id="sidebarNav"></div>
    <div class="notes-header"><span>Annotations</span><span id="annotCount">0</span></div>
    <div class="notes-list" id="notesList"></div>
  </div>
</div>
<div class="status-bar" id="statusBar">Loading image...</div>
<div class="modal-overlay hidden" id="saveModal">
  <div class="modal">
    <h3>Save Annotations</h3>
    <label>File Name</label>
    <div style="display:flex;gap:6px;margin-bottom:12px">
      <div class="input-wrap">
        <input type="text" id="saveFileName" style="margin-bottom:0;width:100%" placeholder="Enter file name..."/>
        <button class="btn-increment" id="btnIncrement" title="Increment Version">&plus;</button>
      </div>
      <button class="btn-secondary" id="btnAutoFill" style="white-space:nowrap;padding:6px 12px;border:none;border-radius:5px;font-size:12px;cursor:pointer">Auto-fill</button>
    </div>
    <div id="conflictMsg" class="conflict-msg">This version already exists. Please change the name.</div>
    <label>Location</label>
    <div style="display:flex;gap:6px;margin-bottom:4px">
      <input type="text" id="saveLocation" style="margin-bottom:0;flex:1" readonly placeholder="Same as image folder"/>
      <button class="btn-secondary" id="btnBrowse" style="white-space:nowrap;padding:6px 12px;border:none;border-radius:5px;font-size:12px;cursor:pointer">Browse</button>
    </div>
    <div class="modal-list-label">Existing versions for this image:</div>
    <div class="modal-list" id="modalExistingList"></div>
    <div class="modal-buttons">
      <button class="btn-secondary" id="btnSaveCancel">Cancel</button>
      <button class="btn-save" id="btnSaveConfirm">Save</button>
    </div>
  </div>
</div>
<script>
(function(){
var vscodeApi=acquireVsCodeApi();
var wrapper=document.getElementById('wrapper');
var canvas=document.getElementById('canvas');
var ctx=canvas.getContext('2d');
var btnCrop=document.getElementById('btnCrop');
var btnCancel=document.getElementById('btnCancel');
var btnReset=document.getElementById('btnReset');
var btnFit=document.getElementById('btnFit');
var btnMirror=document.getElementById('btnMirror');
var btnMirrorConfirm=document.getElementById('btnMirrorConfirm');
var btnMirrorX=document.getElementById('btnMirrorX');
var mirrorToolbarButtons=document.getElementById('mirrorToolbarButtons');
var btnMirrorOkTop=document.getElementById('btnMirrorOkTop');
var btnMirrorCancelTop=document.getElementById('btnMirrorCancelTop');
var mirrorFT=document.getElementById('mirrorFT');
var btnMirrorOffsetL=document.getElementById('btnMirrorOffsetL');
var btnMirrorOffsetR=document.getElementById('btnMirrorOffsetR');
var mirrorOffsetVal=document.getElementById('mirrorOffsetVal');
var btnSave=document.getElementById('btnSave');
var btnFitTop=document.getElementById('btnFitTop');
var btnFitBottom=document.getElementById('btnFitBottom');
var btnZoomIn=document.getElementById('btnZoomIn');
var btnZoomOut=document.getElementById('btnZoomOut');
var statusBar=document.getElementById('statusBar');
var titleToggle=document.getElementById('titleToggle');
var btnAnnotationMode=document.getElementById('btnAnnotationMode');
var annotToolbar=document.getElementById('annotToolbar');
var notesPanel=document.getElementById('notesPanel');
var sidebarNav=document.getElementById('sidebarNav');
var navButtons=document.getElementById('navButtons');
var btnSaveAnnotations=document.getElementById('btnSaveAnnotations');
var btnNewSaveAnnotations=document.getElementById('btnNewSaveAnnotations');
var notesList=document.getElementById('notesList');
var modalExistingList=document.getElementById('modalExistingList');
var btnIncrement=document.getElementById('btnIncrement');
var currentFileName=null;
var fileInfo=document.getElementById('fileInfo');
var filePrefix=document.getElementById('filePrefix');
var fileMain=document.getElementById('fileMain');

function updateFileDisplay(){
  if(!currentFileName){fileInfo.classList.add('hidden');return}
  fileInfo.classList.remove('hidden');
  var name=currentFileName;
  var idx=name.indexOf('_');
  var prefix=idx!==-1?name.substring(0,idx):'ANNOTATIONS';
  var main=idx!==-1?name.substring(idx+1):name;
  var vMatch=main.match(/(_A\d+)$/i);
  if(vMatch){
    var base=main.substring(0, main.length-vMatch[1].length);
    var ver=vMatch[1];
    filePrefix.textContent=prefix;
    fileMain.innerHTML='<span style="opacity:0.6">'+base+'</span><span style="color:#fff;font-weight:bold;text-shadow:0 0 5px rgba(255,255,255,0.3)">'+ver+'</span>';
  }else{
    filePrefix.textContent=prefix;fileMain.textContent=main;
  }
}
var annotCountEl=document.getElementById('annotCount');
var saveModal=document.getElementById('saveModal');
var saveFileNameInput=document.getElementById('saveFileName');
var saveLocationInput=document.getElementById('saveLocation');
var savedAnnotationsWrap=document.getElementById('savedAnnotationsWrap');
var savedDropdown=document.getElementById('savedDropdown');
var btnSavedAnnotations=document.getElementById('btnSavedAnnotations');

var IMAGE_SRC='${imageUri}';
var ORIG_FILENAME='${originalFileName}';
var IS_EXPORT=ORIG_FILENAME.indexOf('_annotated')!==-1;
var HANDLE_R=6,HIT_R=12,MIN_CROP=10,SBAR_SIZE=20,SBAR_PAD=4,SBAR_MIN_THUMB=30;

var originalImage=null,currentImage=null;
var baseScale=1,zoomFactor=1,offsetX=0,offsetY=0;
function eff(){return baseScale*zoomFactor}
function scrToImg(sx,sy){var s=eff();return{x:(sx-offsetX)/s,y:(sy-offsetY)/s}}
var cropMode=false,crop=null,drag=null,hBar=null,vBar=null;
var mirrorMode=false,mirrorBox=null,mirrorOffsetX=0;
var cropPresets=[{amount:25,edge:'top'}];
var isAddingTrim=false;
var btnCropPresets=document.getElementById('btnCropPresets');
var cropPresetsWrap=document.getElementById('cropPresetsWrap');
var cropPresetsDropdown=document.getElementById('cropPresetsDropdown');

/* ── annotation state ─────────────── */
var annotationMode=false;
var annotations=[];
var activeTool=null; // {type:'box'|'line', color:string}
var selectedAnnotId=null;
var annotDrag=null; // drawing or moving annotation
var colorCounters={red:0,blue:0,green:0,yellow:0};
var COLOR_HEX={red:'#e74c3c',blue:'#3498db',green:'#2ecc71',yellow:'#f1c40f'};
var EDGE_COLORS={top:'#2ea043',bottom:'#0e639c',left:'#e67e22',right:'#9b59b6'};
var hasSavedAnnotations=false;
var chosenFolder='';
var nextVersion=1;
var currentFiles=[];
var scrollbarW=0,scrollbarH=0;
var isDirty=false;
function setDirty(v){isDirty=v;var el=document.getElementById('unsavedIndicator');if(el)el.classList.toggle('hidden',!v)}

function sizeCanvas(){if(!wrapper||!canvas)return;canvas.width=wrapper.clientWidth;canvas.height=wrapper.clientHeight}
function computeFit(img){var pad=40;if(!wrapper)return 1;return Math.min(1,(wrapper.clientWidth-pad)/img.width,(wrapper.clientHeight-pad)/img.height)}
function centerImage(){if(!currentImage)return;var s=eff();offsetX=(canvas.width-scrollbarW-currentImage.width*s)/2;offsetY=(canvas.height-scrollbarH-currentImage.height*s)/2}
function clampOffsets(){if(!currentImage)return;var s=eff(),cw=canvas.width-scrollbarW,ch=canvas.height-scrollbarH,iw=currentImage.width*s,ih=currentImage.height*s,m=300;if(iw>cw)offsetX=Math.max(-(iw-cw)-m,Math.min(m,offsetX));else offsetX=(cw-iw)/2;if(ih>ch)offsetY=Math.max(-(ih-ch)-m,Math.min(m,offsetY));else offsetY=(ch-ih)/2}

function roundRect(x,y,w,h,r){if(w<2*r)r=w/2;if(h<2*r)r=h/2;ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}

function drawScrollbars(){
  if(!currentImage)return;var s=eff();var imgW=currentImage.width*s;var imgH=currentImage.height*s;
  var showH=imgW>canvas.width-24;var showV=imgH>canvas.height-24;hBar=null;vBar=null;
  scrollbarW=showV?SBAR_SIZE+SBAR_PAD*2:0;scrollbarH=showH?SBAR_SIZE+SBAR_PAD*2:0;
  var cw=canvas.width-scrollbarW,ch=canvas.height-scrollbarH;
  if(showH){var tX=SBAR_PAD,tY=canvas.height-SBAR_SIZE-SBAR_PAD,tW=cw-SBAR_PAD,tH=SBAR_SIZE;
    var thumbFrac=Math.min(1,cw/imgW);var thumbW=Math.max(SBAR_MIN_THUMB,thumbFrac*tW);
    var scrollRange=imgW-cw;var scrollPos=Math.max(0,Math.min(1,-offsetX/scrollRange));var thumbX=tX+scrollPos*(tW-thumbW);
    hBar={tX:tX,tY:tY,tW:tW,tH:tH,thumbX:thumbX,thumbW:thumbW,scrollRange:scrollRange};
    ctx.fillStyle='rgba(20,20,20,1)';ctx.fillRect(tX-SBAR_PAD,tY-SBAR_PAD,tW+SBAR_PAD+scrollbarW,tH+SBAR_PAD*2);
    ctx.fillStyle='rgba(60,60,60,1)';roundRect(tX,tY,tW,tH,10);ctx.fill();
    ctx.fillStyle='rgba(150,150,150,0.8)';roundRect(thumbX,tY,thumbW,tH,10);ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.4)';ctx.lineWidth=1.5;roundRect(thumbX,tY,thumbW,tH,10);ctx.stroke()}
  if(showV){var vtX=canvas.width-SBAR_SIZE-SBAR_PAD,vtY=SBAR_PAD,vtW=SBAR_SIZE,vtH=ch-SBAR_PAD;
    var vTF=Math.min(1,ch/imgH);var vTH=Math.max(SBAR_MIN_THUMB,vTF*vtH);
    var vSR=imgH-ch;var vSP=Math.max(0,Math.min(1,-offsetY/vSR));var vTY=vtY+vSP*(vtH-vTH);
    vBar={tX:vtX,tY:vtY,tW:vtW,tH:vtH,thumbY:vTY,thumbH:vTH,scrollRange:vSR};
    ctx.fillStyle='rgba(20,20,20,1)';ctx.fillRect(vtX-SBAR_PAD,vtY-SBAR_PAD,vtW+SBAR_PAD*2,vtH+SBAR_PAD+scrollbarH);
    ctx.fillStyle='rgba(60,60,60,1)';roundRect(vtX,vtY,vtW,vtH,10);ctx.fill();
    ctx.fillStyle='rgba(150,150,150,0.8)';roundRect(vtX,vTY,vtW,vTH,10);ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.4)';ctx.lineWidth=1.5;roundRect(vtX,vTY,vtW,vTH,10);ctx.stroke()}
}

function drawAnnotations(){
  if(!annotationMode||!currentImage)return;
  var s=eff();
  for(var i=0;i<annotations.length;i++){
    var a=annotations[i];var sel=a.id===selectedAnnotId;
    ctx.save();
    if(a.type==='box'){
      var ax=a.x*s+offsetX,ay=a.y*s+offsetY,aw=a.w*s,ah=a.h*s;
      ctx.fillStyle=COLOR_HEX[a.color]+'33';ctx.fillRect(ax,ay,aw,ah);
      ctx.strokeStyle=COLOR_HEX[a.color];ctx.lineWidth=sel?3:2;ctx.setLineDash([]);ctx.strokeRect(ax,ay,aw,ah);
      ctx.font='bold 11px system-ui';ctx.fillStyle=COLOR_HEX[a.color];ctx.fillText(a.id,ax+4,ay+14);
    }else{
      var x1=a.x1*s+offsetX,y1=a.y1*s+offsetY,x2=a.x2*s+offsetX,y2=a.y2*s+offsetY;
      ctx.strokeStyle=COLOR_HEX[a.color];ctx.lineWidth=sel?3:2;ctx.setLineDash([8,4]);
      ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
      ctx.setLineDash([]);ctx.font='bold 11px system-ui';ctx.fillStyle=COLOR_HEX[a.color];ctx.fillText(a.id,(x1+x2)/2+4,(y1+y2)/2-6);
    }
    ctx.restore();
  }
}

function updateStatus(){
  if(!currentImage)return;var pct=Math.round(eff()*100);
  var msg=currentImage.width+' x '+currentImage.height+' px - '+pct+'%';
  if(annotationMode){msg+=' - Annotation Mode';if(activeTool)msg+=' ['+activeTool.color+' '+activeTool.type+']'}
  else if(cropMode&&crop){msg+=' - Crop: '+Math.round(crop.w)+' x '+Math.round(crop.h)+' - Drag handles to adjust'}
  else{msg+=' - Scroll to zoom, drag to pan'}
  statusBar.textContent=msg;
}

function draw(){
  sizeCanvas();ctx.clearRect(0,0,canvas.width,canvas.height);if(!currentImage)return;
  var s=eff(),imgX=offsetX,imgY=offsetY,imgW=currentImage.width*s,imgH=currentImage.height*s;
  if(cropMode&&crop){
    ctx.globalAlpha=0.35;ctx.drawImage(currentImage,imgX,imgY,imgW,imgH);ctx.globalAlpha=1.0;
    var cx=crop.x*s+offsetX,cy=crop.y*s+offsetY,cw=crop.w*s,ch=crop.h*s;
    ctx.save();ctx.beginPath();ctx.rect(cx,cy,cw,ch);ctx.clip();ctx.drawImage(currentImage,imgX,imgY,imgW,imgH);ctx.restore();
    ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.setLineDash([]);ctx.strokeRect(cx,cy,cw,ch);
    ctx.strokeStyle='rgba(255,255,255,0.2)';ctx.lineWidth=1;
    for(var gi=1;gi<=2;gi++){var gx=cx+(cw/3)*gi,gy=cy+(ch/3)*gi;ctx.beginPath();ctx.moveTo(gx,cy);ctx.lineTo(gx,cy+ch);ctx.stroke();ctx.beginPath();ctx.moveTo(cx,gy);ctx.lineTo(cx+cw,gy);ctx.stroke()}
    var handles=getHandles();ctx.lineWidth=2;
    for(var hi=0;hi<handles.length;hi++){
      var h=handles[hi];ctx.fillStyle=h.color||'#fff';ctx.strokeStyle=h.color? '#fff' : 'var(--vscode-button-background,#0e639c)';
      ctx.beginPath();ctx.arc(h.sx,h.sy,HANDLE_R,0,Math.PI*2);ctx.fill();ctx.stroke();
    }
    if(drag&&drag.type==='handle'){
      ctx.font='bold 12px system-ui';var s2=eff();
      var t=Math.round(crop.y),b=Math.round(currentImage.height-(crop.y+crop.h)),l=Math.round(crop.x),r=Math.round(currentImage.width-(crop.x+crop.w));
      var show=function(val,color,hx,hy){if(val<=0)return;var txt=val+'px';var tw=ctx.measureText(txt).width;ctx.fillStyle='rgba(0,0,0,0.85)';ctx.fillRect(hx-tw/2-4,hy-24,tw+8,20);ctx.fillStyle=color;ctx.fillText(txt,hx-tw/2,hy-10)};
      if(drag.handleId.includes('t'))show(t,EDGE_COLORS.top,cx+cw/2,cy);
      if(drag.handleId.includes('b'))show(b,EDGE_COLORS.bottom,cx+cw/2,cy+ch);
      if(drag.handleId.includes('l'))show(l,EDGE_COLORS.left,cx,cy+ch/2);
      if(drag.handleId.includes('r'))show(r,EDGE_COLORS.right,cx+cw,cy+ch/2);
    }
    var rw=Math.round(crop.w),rh=Math.round(crop.h);
    if(rw>0&&rh>0){var label=rw+' x '+rh;ctx.font='12px system-ui';var tw=ctx.measureText(label).width;var lx=cx+cw/2-tw/2-6,ly=cy+ch+14;ctx.fillStyle='rgba(0,0,0,0.75)';ctx.fillRect(lx,ly,tw+12,22);ctx.fillStyle='#fff';ctx.fillText(label,lx+6,ly+15)}
  }else if(mirrorMode){
    ctx.drawImage(currentImage,imgX,imgY,imgW,imgH);
    // Centerline
    var midX=imgX+imgW/2+mirrorOffsetX*s;
    ctx.strokeStyle='rgba(231,76,60,0.7)';ctx.lineWidth=2;ctx.setLineDash([10,5]);
    ctx.beginPath();ctx.moveTo(midX,Math.max(0,imgY));ctx.lineTo(midX,Math.min(canvas.height,imgY+imgH));ctx.stroke();ctx.setLineDash([]);
    
    // Position fine tune controls at top of centerline
    mirrorFT.classList.remove('hidden');
    mirrorToolbarButtons.classList.remove('hidden');
    btnMirrorOkTop.disabled=!mirrorBox;
    mirrorFT.style.left=(midX- mirrorFT.offsetWidth/2)+'px';
    mirrorFT.style.top=Math.max(10, imgY)+'px';
    mirrorOffsetVal.textContent=mirrorOffsetX.toFixed(2);

    if(mirrorBox){
      var mx=mirrorBox.x*s+offsetX,my=mirrorBox.y*s+offsetY,mw=mirrorBox.w*s,mh=mirrorBox.h*s;
      // selection box
      ctx.strokeStyle='#2ecc71';ctx.lineWidth=1;ctx.strokeRect(mx,my,mw,mh);
      // mirror preview
      var tx=(currentImage.width-(mirrorBox.x+mirrorBox.w)+2*mirrorOffsetX)*s+offsetX;
      ctx.save();ctx.globalAlpha=0.95;
      ctx.translate(tx+mw/2,my+mh/2);ctx.scale(-1,1);
      ctx.drawImage(currentImage,mirrorBox.x,mirrorBox.y,mirrorBox.w,mirrorBox.h,-mw/2,-mh/2,mw,mh);
      ctx.restore();
      // Position checkbox
      var rx=mx+mw,ry=my+mh;
      if(!drag && mw>5 && mh>5){
        btnMirrorConfirm.classList.remove('hidden');
        btnMirrorX.classList.remove('hidden');
        var btnX=Math.max(20,Math.min(canvas.width-scrollbarW-80,rx-16));
        var btnY=Math.max(20,Math.min(canvas.height-scrollbarH-40,ry-16));
        btnMirrorConfirm.style.left=btnX+'px';btnMirrorConfirm.style.top=btnY+'px';
        btnMirrorX.style.left=(btnX+40)+'px';btnMirrorX.style.top=btnY+'px';
      }else{btnMirrorConfirm.classList.add('hidden');btnMirrorX.classList.add('hidden')}
    }else{btnMirrorConfirm.classList.add('hidden');btnMirrorX.classList.add('hidden')}
  }else{ctx.drawImage(currentImage,imgX,imgY,imgW,imgH);mirrorFT.classList.add('hidden')}
  drawAnnotations();drawScrollbars();updateStatus();
}

function getHandles(){
  if(!crop)return[];var s=eff(),cx=crop.x*s+offsetX,cy=crop.y*s+offsetY,cw=crop.w*s,ch=crop.h*s;
  return[
    {id:'tl',sx:cx,sy:cy,cursor:'nwse-resize'},
    {id:'t',sx:cx+cw/2,sy:cy,cursor:'ns-resize',color:EDGE_COLORS.top},
    {id:'tr',sx:cx+cw,sy:cy,cursor:'nesw-resize'},
    {id:'r',sx:cx+cw,sy:cy+ch/2,cursor:'ew-resize',color:EDGE_COLORS.right},
    {id:'br',sx:cx+cw,sy:cy+ch,cursor:'nwse-resize'},
    {id:'b',sx:cx+cw/2,sy:cy+ch,cursor:'ns-resize',color:EDGE_COLORS.bottom},
    {id:'bl',sx:cx,sy:cy+ch,cursor:'nesw-resize'},
    {id:'l',sx:cx,sy:cy+ch/2,cursor:'ew-resize',color:EDGE_COLORS.left}
  ];
}
function hitHandle(mx,my){var hs=getHandles();for(var i=0;i<hs.length;i++){if(Math.hypot(mx-hs[i].sx,my-hs[i].sy)<=HIT_R)return hs[i]}return null}
function isInsideCrop(mx,my){if(!crop)return false;var s=eff(),cx=crop.x*s+offsetX,cy=crop.y*s+offsetY;return mx>=cx&&mx<=cx+crop.w*s&&my>=cy&&my<=cy+crop.h*s}
function hitHBar(mx,my){if(!hBar)return false;return mx>=hBar.thumbX&&mx<=hBar.thumbX+hBar.thumbW&&my>=hBar.tY&&my<=hBar.tY+hBar.tH}
function hitHTrack(mx,my){if(!hBar)return false;return mx>=hBar.tX&&mx<=hBar.tX+hBar.tW&&my>=hBar.tY&&my<=hBar.tY+hBar.tH}
function hitVBar(mx,my){if(!vBar)return false;return mx>=vBar.tX&&mx<=vBar.tX+vBar.tW&&my>=vBar.thumbY&&my<=vBar.thumbY+vBar.thumbH}
function hitVTrack(mx,my){if(!vBar)return false;return mx>=vBar.tX&&mx<=vBar.tX+vBar.tW&&my>=vBar.tY&&my<=vBar.tY+vBar.tH}

function hitAnnotation(mx,my){
  var s=eff();
  for(var i=annotations.length-1;i>=0;i--){
    var a=annotations[i];
    if(a.type==='box'){var ax=a.x*s+offsetX,ay=a.y*s+offsetY,aw=a.w*s,ah=a.h*s;if(mx>=ax&&mx<=ax+aw&&my>=ay&&my<=ay+ah)return a}
    else{var x1=a.x1*s+offsetX,y1=a.y1*s+offsetY,x2=a.x2*s+offsetX,y2=a.y2*s+offsetY;var dist=distToSegment(mx,my,x1,y1,x2,y2);if(dist<10)return a}
  }
  return null;
}
function distToSegment(px,py,x1,y1,x2,y2){var dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/(dx*dx+dy*dy)));return Math.hypot(px-(x1+t*dx),py-(y1+t*dy))}

function renderNotes(){
  notesList.innerHTML='';annotCountEl.textContent=annotations.length;
  for(var i=0;i<annotations.length;i++){(function(a,idx){
    var div=document.createElement('div');div.className='note-item'+(a.id===selectedAnnotId?' selected':'');div.style.borderLeftColor=COLOR_HEX[a.color];
    var hdr=document.createElement('div');hdr.className='note-item-header';
    var lbl=document.createElement('span');lbl.className='note-item-label';lbl.textContent=a.id;
    var del=document.createElement('button');del.className='note-delete-btn';del.textContent='x';del.title='Delete';
    del.addEventListener('click',function(e){e.stopPropagation();annotations.splice(idx,1);if(selectedAnnotId===a.id)selectedAnnotId=null;setDirty(true);renderNotes();draw()});
    hdr.appendChild(lbl);hdr.appendChild(del);div.appendChild(hdr);
    var coords=document.createElement('div');coords.className='note-item-coords';
    if(a.type==='box'){coords.textContent='x:'+Math.round(a.x)+' y:'+Math.round(a.y)+' w:'+Math.round(a.w)+' h:'+Math.round(a.h)}
    else{coords.textContent='x1:'+Math.round(a.x1)+' y1:'+Math.round(a.y1)+' x2:'+Math.round(a.x2)+' y2:'+Math.round(a.y2)}
    div.appendChild(coords);
    var ta=document.createElement('textarea');ta.className='note-item-input';ta.placeholder='Add note...';ta.value=a.note||'';
    ta.addEventListener('input',function(){a.note=ta.value;setDirty(true)});ta.addEventListener('click',function(e){e.stopPropagation()});
    div.appendChild(ta);
    div.addEventListener('click',function(){selectedAnnotId=a.id;renderNotes();draw()});
    notesList.appendChild(div);
  })(annotations[i],i)}
}

canvas.addEventListener('mousedown',function(e){
  var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(e.button===1){drag={type:'pan',startMouse:{x:mx,y:my},origOffset:{x:offsetX,y:offsetY}};canvas.style.cursor='grabbing';return}
  if(e.button!==0)return;
  if(hitHBar(mx,my)){drag={type:'scrollH',startMouse:{x:mx,y:my},origOffset:{x:offsetX,y:offsetY}};return}
  if(hitVBar(mx,my)){drag={type:'scrollV',startMouse:{x:mx,y:my},origOffset:{x:offsetX,y:offsetY}};return}
  if(hitHTrack(mx,my)&&hBar){var dir=mx<hBar.thumbX?1:-1;offsetX+=dir*canvas.width*0.8;clampOffsets();draw();return}
  if(hitVTrack(mx,my)&&vBar){var dir=my<vBar.thumbY?1:-1;offsetY+=dir*canvas.height*0.8;clampOffsets();draw();return}
  if(annotationMode){
    if(activeTool){var ip=scrToImg(mx,my);annotDrag={type:'draw',startImg:ip,tool:activeTool};return}
    var hitA=hitAnnotation(mx,my);
    if(hitA){selectedAnnotId=hitA.id;renderNotes();draw();var ip2=scrToImg(mx,my);
      if(hitA.type==='box'){annotDrag={type:'moveBox',ann:hitA,startImg:ip2,origX:hitA.x,origY:hitA.y}}
      else{annotDrag={type:'moveLine',ann:hitA,startImg:ip2,origX1:hitA.x1,origY1:hitA.y1,origX2:hitA.x2,origY2:hitA.y2}}
      return}
    selectedAnnotId=null;renderNotes();
  }
  if(mirrorMode){
    var sip=scrToImg(mx,my);drag={type:'mirror',startImg:sip,startMouse:{x:mx,y:my}};mirrorBox={x:sip.x,y:sip.y,w:0,h:0};draw();return;
  }
  if(cropMode&&crop){var h=hitHandle(mx,my);if(h){drag={type:'handle',handleId:h.id,startMouse:{x:mx,y:my},origCrop:{x:crop.x,y:crop.y,w:crop.w,h:crop.h}};return}if(isInsideCrop(mx,my)){drag={type:'move',startMouse:{x:mx,y:my},origCrop:{x:crop.x,y:crop.y,w:crop.w,h:crop.h}};return}}
  drag={type:'pan',startMouse:{x:mx,y:my},origOffset:{x:offsetX,y:offsetY}};
});

canvas.addEventListener('mousemove',function(e){
  var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(annotDrag){
    var ip=scrToImg(mx,my);
    if(annotDrag.type==='draw'){annotDrag.currentImg=ip;draw();
      var s=eff(),si=annotDrag.startImg,ci=annotDrag.currentImg;
      if(annotDrag.tool.type==='box'){var bx=Math.min(si.x,ci.x)*s+offsetX,by=Math.min(si.y,ci.y)*s+offsetY,bw=Math.abs(ci.x-si.x)*s,bh=Math.abs(ci.y-si.y)*s;ctx.strokeStyle=COLOR_HEX[annotDrag.tool.color];ctx.lineWidth=2;ctx.strokeRect(bx,by,bw,bh)}
      else{ctx.strokeStyle=COLOR_HEX[annotDrag.tool.color];ctx.lineWidth=2;ctx.setLineDash([8,4]);ctx.beginPath();ctx.moveTo(si.x*s+offsetX,si.y*s+offsetY);ctx.lineTo(ci.x*s+offsetX,ci.y*s+offsetY);ctx.stroke();ctx.setLineDash([])}
      return}
    if(annotDrag.type==='moveBox'){var ddx=ip.x-annotDrag.startImg.x,ddy=ip.y-annotDrag.startImg.y;annotDrag.ann.x=annotDrag.origX+ddx;annotDrag.ann.y=annotDrag.origY+ddy;renderNotes();draw();return}
    if(annotDrag.type==='moveLine'){var ddx2=ip.x-annotDrag.startImg.x,ddy2=ip.y-annotDrag.startImg.y;annotDrag.ann.x1=annotDrag.origX1+ddx2;annotDrag.ann.y1=annotDrag.origY1+ddy2;annotDrag.ann.x2=annotDrag.origX2+ddx2;annotDrag.ann.y2=annotDrag.origY2+ddy2;renderNotes();draw();return}
  }
  if(!drag){canvas.style.cursor=(annotationMode&&activeTool)?'crosshair':(annotationMode&&hitAnnotation(mx,my))?'move':'default';return}
  var dx=mx-drag.startMouse.x,dy=my-drag.startMouse.y;
  if(drag.type==='pan'){offsetX=drag.origOffset.x+dx;offsetY=drag.origOffset.y+dy;clampOffsets();canvas.style.cursor='grabbing'}
  else if(drag.type==='mirror'){
    var cip=scrToImg(mx,my);var sip=drag.startImg;
    mirrorBox={x:Math.min(sip.x,cip.x),y:Math.min(sip.y,cip.y),w:Math.abs(cip.x-sip.x),h:Math.abs(cip.y-sip.y)};
    draw();
  }
  else if(drag.type.indexOf('scroll')>=0){
    if(drag.type==='scrollH'){var hf=(mx-drag.startMouse.x)/(hBar.tW-hBar.thumbW);offsetX=drag.origOffset.x-hf*hBar.scrollRange}
    else{var vf=(my-drag.startMouse.y)/(vBar.tH-vBar.thumbH);offsetY=drag.origOffset.y-vf*vBar.scrollRange}
    clampOffsets();
  }
  else if(drag.type==='move'){
    var s=eff();crop.x=Math.max(0,Math.min(currentImage.width-crop.w,drag.origCrop.x+dx/s));
    crop.y=Math.max(0,Math.min(currentImage.height-crop.h,drag.origCrop.y+dy/s));
  }
  else if(drag.type==='handle'){
    var s2=eff();var ox=drag.origCrop.x,oy=drag.origCrop.y,ow=drag.origCrop.w,oh=drag.origCrop.h;
    var mdx=dx/s2,mdy=dy/s2;
    if(drag.handleId.includes('r')){crop.w=Math.max(MIN_CROP,ow+mdx)}
    if(drag.handleId.includes('l')){var nw=Math.max(MIN_CROP,ow-mdx);crop.x=ox+(ow-nw);crop.w=nw}
    if(drag.handleId.includes('b')){crop.h=Math.max(MIN_CROP,oh+mdy)}
    if(drag.handleId.includes('t')){var nh=Math.max(MIN_CROP,oh-mdy);crop.y=oy+(oh-nh);crop.h=nh}
    crop.x=Math.max(0,Math.min(currentImage.width-crop.w,crop.x));
    crop.y=Math.max(0,Math.min(currentImage.height-crop.h,crop.y));
  }
  draw();
});

window.addEventListener('mouseup',function(){
  if(annotDrag&&annotDrag.type==='draw'&&annotDrag.currentImg){
    var si=annotDrag.startImg,ci=annotDrag.currentImg,t=annotDrag.tool;
    colorCounters[t.color]=(colorCounters[t.color]||0)+1;
    var id=t.color.charAt(0).toUpperCase()+t.color.slice(1)+(t.type==='box'?'Box':'Line')+colorCounters[t.color];
    if(t.type==='box'){var bx=Math.min(si.x,ci.x),by=Math.min(si.y,ci.y),bw=Math.abs(ci.x-si.x),bh=Math.abs(ci.y-si.y);if(bw>5&&bh>5){annotations.push({id:id,type:'box',color:t.color,x:bx,y:by,w:bw,h:bh,note:''});setDirty(true)}}
    else{if(Math.hypot(ci.x-si.x,ci.y-si.y)>5){annotations.push({id:id,type:'line',color:t.color,x1:si.x,y1:si.y,x2:ci.x,y2:ci.y,note:''});setDirty(true)}}
    renderNotes();draw()}
  annotDrag=null;drag=null;
});

canvas.addEventListener('wheel',function(e){
  e.preventDefault();var r=canvas.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(e.ctrlKey || e.metaKey){
    var ip=scrToImg(mx,my);zoomFactor=Math.max(0.1,Math.min(30,zoomFactor*(e.deltaY>0?0.9:1.1)));
    var ns=eff();offsetX=mx-ip.x*ns;offsetY=my-ip.y*ns;
  }else{
    var dx=e.deltaX,dy=e.deltaY;
    if(e.shiftKey&&dx===0){dx=dy;dy=0}
    if(e.deltaMode===1){dx*=30;dy*=30}else if(e.deltaMode===2){dx*=canvas.width;dy*=canvas.height}
    offsetX-=dx;offsetY-=dy;
  }
  clampOffsets();
  draw();
},{passive:false});

function renderCropPresets(){
  cropPresetsDropdown.innerHTML='';
  cropPresets.forEach(function(p,idx){
    var div=document.createElement('div');div.className='trim-item';
    var left=document.createElement('div');left.style.display='flex';left.style.alignItems='center';
    var tag=document.createElement('span');tag.className='edge-tag trim-tag-'+p.edge;tag.textContent=p.edge.toUpperCase();
    left.appendChild(tag);left.appendChild(document.createTextNode(p.amount+'px'));
    div.appendChild(left);
    div.onclick=function(){applyTrim(p.amount,p.edge);cropPresetsDropdown.classList.add('hidden')};
    var del=document.createElement('span');del.style.color='#e74c3c';del.style.cursor='pointer';del.textContent='×';del.style.padding='4px 8px';del.style.opacity='0.6';
    del.onclick=function(e){e.stopPropagation();cropPresets.splice(idx,1);vscodeApi.postMessage({type:'updateCropPresets',presets:cropPresets});renderCropPresets()};
    div.appendChild(del);
    cropPresetsDropdown.appendChild(div);
  });

  if(!isAddingTrim){
    var plus=document.createElement('button');plus.className='trim-plus-btn';plus.innerHTML='<b>+</b> Add New Trim';
    plus.onclick=function(e){e.stopPropagation();isAddingTrim=true;renderCropPresets()};
    var pad=document.createElement('div');pad.style.padding='8px';pad.appendChild(plus);
    cropPresetsDropdown.appendChild(pad);
  }else{
    var pnl=document.createElement('div');pnl.className='trim-add-panel';
    pnl.innerHTML='<div class="trim-add-label">New Trim Amount</div>';
    var inp=document.createElement('input');inp.type='number';inp.placeholder='Pixels...';inp.value='50';
    pnl.appendChild(inp);
    var edge='top';
    var toggle=document.createElement('div');toggle.className='trim-edge-toggle';
    var bT=document.createElement('button');bT.textContent='TOP';bT.className='active';
    var bB=document.createElement('button');bB.textContent='BOTTOM';
    bT.onclick=function(){edge='top';bT.className='active';bB.className=''};
    bB.onclick=function(){edge='bottom';bB.className='active';bT.className=''};
    toggle.appendChild(bT);toggle.appendChild(bB);pnl.appendChild(toggle);
    var foot=document.createElement('div');foot.className='trim-add-footer';
    var cBtn=document.createElement('button');cBtn.textContent='Cancel';cBtn.className='btn-secondary';cBtn.style.flex='1';cBtn.style.fontSize='10px';
    cBtn.onclick=function(e){e.stopPropagation();isAddingTrim=false;renderCropPresets()};
    var aBtn=document.createElement('button');aBtn.textContent='Add';aBtn.className='btn-primary';aBtn.style.flex='1';aBtn.style.fontSize='10px';
    aBtn.onclick=function(e){e.stopPropagation();var amt=parseInt(inp.value);if(!isNaN(amt)){cropPresets.push({amount:amt,edge:edge});vscodeApi.postMessage({type:'updateCropPresets',presets:cropPresets});isAddingTrim=false;renderCropPresets()}};
    foot.appendChild(cBtn);foot.appendChild(aBtn);pnl.appendChild(foot);
    cropPresetsDropdown.appendChild(pnl);
    setTimeout(function(){inp.focus();inp.select()},10);
  }
}
function applyTrim(amt,edge){
  if(!crop)return;
  if(edge==='top'){
    var move=Math.min(amt,crop.h-MIN_CROP);
    crop.y+=move;crop.h-=move;
  }else{
    crop.h=Math.max(MIN_CROP,crop.h-amt);
  }
  draw();
}
btnCropPresets.onclick=function(e){e.stopPropagation();cropPresetsDropdown.classList.toggle('hidden')};
window.addEventListener('click',function(){cropPresetsDropdown.classList.add('hidden')});
cropPresetsDropdown.onclick=function(e){e.stopPropagation()};

function toggleCrop(next){
  if(!currentImage||IS_EXPORT)return;
  if(next===undefined)next=!cropMode;
  cropMode=next;
  btnCrop.classList.toggle('active',cropMode);
  btnCrop.textContent=cropMode?'Apply':'Crop';
  btnCancel.classList.toggle('hidden',!cropMode);
  cropPresetsWrap.classList.toggle('hidden',!cropMode);
  if(cropMode){
    if(mirrorMode)toggleMirror(false);
    if(annotationMode)toggleAnnotationMode(false);
    crop={x:0,y:0,w:currentImage.width,h:currentImage.height};
  }else{crop=null}
  draw();
}

btnCrop.addEventListener('click',function(){
  if(!currentImage||annotationMode||IS_EXPORT)return;
  if(!cropMode){
    toggleCrop(true);
    return;
  }
  // Applying crop
  var off=document.createElement('canvas');off.width=crop.w;off.height=crop.h;off.getContext('2d').drawImage(currentImage,crop.x,crop.y,crop.w,crop.h,0,0,crop.w,crop.h);
  loadImage(off.toDataURL(),function(img){currentImage=img;toggleCrop(false);baseScale=computeFit(img);zoomFactor=1;centerImage();draw();btnSave.disabled=false});
});
btnCancel.addEventListener('click',function(){toggleCrop(false);draw()});
btnReset.addEventListener('click',function(){if(!originalImage)return;currentImage=originalImage;toggleCrop(false);draw();btnSave.disabled=true});
btnFit.addEventListener('click',function(){if(!currentImage)return;baseScale=computeFit(currentImage);zoomFactor=1;centerImage();draw()});
function zoomAtCenter(f){if(!currentImage)return;var mx=canvas.width/2,my=canvas.height/2,ip=scrToImg(mx,my);zoomFactor=Math.max(0.1,Math.min(30,zoomFactor*f));var ns=eff();offsetX=mx-ip.x*ns;offsetY=my-ip.y*ns;draw()}
btnZoomIn.addEventListener('click',function(){zoomAtCenter(1.2)});
btnZoomOut.addEventListener('click',function(){zoomAtCenter(0.8)});
btnMirror.addEventListener('click',function(){
  if(!currentImage||cropMode||annotationMode)return;
  mirrorMode=!mirrorMode;mirrorBox=null;mirrorOffsetX=0;
  btnMirror.classList.toggle('active',mirrorMode);
  if(!mirrorMode){btnMirrorConfirm.classList.add('hidden');mirrorFT.classList.add('hidden')}
  draw();
});
btnMirrorOffsetL.addEventListener('click',function(){mirrorOffsetX-=0.25;draw()});
btnMirrorOffsetR.addEventListener('click',function(){mirrorOffsetX+=0.25;draw()});
btnMirrorConfirm.addEventListener('click',confirmMirror);
btnMirrorOkTop.addEventListener('click',confirmMirror);
function cancelMirrorBox(){mirrorBox=null;draw()}
btnMirrorX.addEventListener('click',cancelMirrorBox);
btnMirrorCancelTop.addEventListener('click',cancelMirrorBox);
function confirmMirror(){
  if(!currentImage||!mirrorBox)return;
  var off=document.createElement('canvas');off.width=currentImage.width;off.height=currentImage.height;
  var oc=off.getContext('2d');oc.drawImage(currentImage,0,0);
  var mw=mirrorBox.w,mh=mirrorBox.h;
  if(mw<1||mh<1)return;
  var tx=currentImage.width-(mirrorBox.x+mirrorBox.w)+2*mirrorOffsetX;
  oc.save();oc.translate(tx+mw/2,mirrorBox.y+mh/2);oc.scale(-1,1);
  oc.drawImage(currentImage,mirrorBox.x,mirrorBox.y,mw,mh,-mw/2,-mh/2,mw,mh);oc.restore();
  loadImage(off.toDataURL(),function(img){currentImage=img;mirrorBox=null;btnMirrorConfirm.classList.add('hidden');btnMirrorX.classList.add('hidden');mirrorToolbarButtons.classList.add('hidden');draw();btnSave.disabled=false});
}

btnFitTop.addEventListener('click',function(){
  if(!currentImage)return;var padLR=40,padTB=annotationMode?60:20;
  baseScale=computeFit(currentImage);zoomFactor=(canvas.width-padLR*2)/(currentImage.width*baseScale);
  offsetX=padLR;offsetY=padTB;draw();
});
btnFitBottom.addEventListener('click',function(){
  if(!currentImage)return;var padLR=40,padTB=20;
  baseScale=computeFit(currentImage);zoomFactor=(canvas.width-padLR*2)/(currentImage.width*baseScale);
  offsetX=padLR;offsetY=canvas.height-currentImage.height*eff()-padTB;draw();
});

btnSave.addEventListener('click',function(){
  if(!currentImage)return;var off=document.createElement('canvas');off.width=currentImage.width;off.height=currentImage.height;
  off.getContext('2d').drawImage(currentImage,0,0);vscodeApi.postMessage({type:'save',dataUrl:off.toDataURL()});
});

var resizer=document.getElementById('resizer');
var isResizing=false;
resizer.addEventListener('mousedown',function(e){isResizing=true;document.body.style.cursor='col-resize'});
window.addEventListener('mousemove',function(e){
  if(!isResizing)return;var newWidth=window.innerWidth-e.clientX;
  if(newWidth>150&&newWidth<800){notesPanel.style.width=newWidth+'px';draw()}
});
window.addEventListener('mouseup',function(){isResizing=false;document.body.style.cursor='default'});

function toggleAnnotationMode(force){
  if(IS_EXPORT)return;
  var nextMode=force!==undefined?force:!annotationMode;
  if(annotationMode && !nextMode && isDirty){
    if(!confirm("You have unsaved changes. Close Annotation mode anyway?")) return;
  }
  annotationMode=nextMode;
  btnAnnotationMode.classList.toggle('active',annotationMode);annotToolbar.classList.toggle('hidden',!annotationMode);notesPanel.classList.toggle('hidden',!annotationMode);resizer.classList.toggle('hidden',!annotationMode);
  if(annotationMode){
    navButtons.classList.add('sidebar-style');sidebarNav.appendChild(navButtons);
    // Fit width logic
    sizeCanvas();drawScrollbars();
    var padLR=40;var cw=canvas.width-scrollbarW;
    var oldS=eff(),oldImgY=-offsetY/oldS;
    zoomFactor=(cw-padLR*2)/(currentImage.width*baseScale);
    var newS=eff();offsetX=padLR;offsetY=-oldImgY*newS;
  }
  else{navButtons.classList.remove('sidebar-style');wrapper.appendChild(navButtons);activeTool=null}
  clampOffsets();draw();
}
btnAnnotationMode.addEventListener('click',function(){if(!cropMode)toggleAnnotationMode()});

annotToolbar.querySelectorAll('button[data-tool]').forEach(function(btn){
  btn.addEventListener('click',function(){
    var tool=btn.getAttribute('data-tool'),color=btn.getAttribute('data-color');
    if(activeTool&&activeTool.type===tool&&activeTool.color===color)activeTool=null;else activeTool={type:tool,color:color};
    annotToolbar.querySelectorAll('button[data-tool]').forEach(function(b){b.classList.toggle('active',activeTool&&b.getAttribute('data-tool')===activeTool.type&&b.getAttribute('data-color')===activeTool.color)});
  });
});

function confirmSave(fileName,folder){
  if(annotations.length===0)return;
  var bScale=Math.max(1,currentImage.width/1000);
  var sw=Math.round(400*bScale),off=document.createElement('canvas');off.width=currentImage.width+sw;off.height=currentImage.height;
  var oc=off.getContext('2d');oc.fillStyle='#1e1e1e';oc.fillRect(0,0,off.width,off.height);oc.drawImage(currentImage,0,0);
  
  var labelFS=Math.max(30,Math.round(40*bScale)),titleFS=Math.max(40,Math.round(56*bScale));
  var idFS=Math.max(28,Math.round(36*bScale)),dataFS=Math.max(20,Math.round(28*bScale));
  var lw=Math.max(4,Math.round(6*bScale));
  
  for(var i=0;i<annotations.length;i++){var a=annotations[i];
    oc.strokeStyle=COLOR_HEX[a.color];oc.lineWidth=lw;
    if(a.type==='box'){oc.strokeRect(a.x,a.y,a.w,a.h);oc.fillStyle=COLOR_HEX[a.color]+'33';oc.fillRect(a.x,a.y,a.w,a.h)}
    else{oc.setLineDash([16*bScale,8*bScale]);oc.beginPath();oc.moveTo(a.x1,a.y1);oc.lineTo(a.x2,a.y2);oc.stroke();oc.setLineDash([])}
    oc.fillStyle=COLOR_HEX[a.color];oc.font='bold '+labelFS+'px system-ui';
    var textY=(a.type==='box'?a.y:a.y1)-(10*bScale);
    oc.fillText(a.id,a.type==='box'?a.x:a.x1,Math.max(labelFS,textY));
  }
  oc.fillStyle='#252526';oc.fillRect(currentImage.width,0,sw,off.height);
  oc.fillStyle='#fff';oc.font='bold '+titleFS+'px system-ui';oc.fillText('Annotations',currentImage.width+20*bScale,40*bScale);
  var cy=90*bScale;for(var j=0;j<annotations.length;j++){var an=annotations[j];
    oc.fillStyle=COLOR_HEX[an.color];oc.font='bold '+idFS+'px system-ui';oc.fillText(an.id,currentImage.width+20*bScale,cy);
    oc.fillStyle='#aaa';oc.font=dataFS+'px monospace';
    var c=an.type==='box'?('X:'+Math.round(an.x)+' Y:'+Math.round(an.y)+' W:'+Math.round(an.w)+' H:'+Math.round(an.h)):('X1:'+Math.round(an.x1)+' Y1:'+Math.round(an.y1)+' X2:'+Math.round(an.x2)+' Y2:'+Math.round(an.y2));
    oc.fillText(c,currentImage.width+20*bScale,cy+idFS*1.4);
    if(an.note){
      oc.fillStyle='#fff';oc.font=dataFS+'px system-ui';
      oc.fillText(an.note,currentImage.width+20*bScale,cy+idFS*1.4+dataFS*1.4);
      cy+=idFS*4.5;
    }else{
      cy+=idFS*3.5;
    }
    if(cy>off.height-40*bScale)break;
  }
  vscodeApi.postMessage({type:'saveAnnotations',screenshotDataUrl:off.toDataURL(),annotations:annotations,fileName:fileName,folder:folder});
}
function triggerSave(isNew){
  var h3=saveModal.querySelector('h3');
  // Refresh list to detect existing versions
  vscodeApi.postMessage({type:'listSavedAnnotations'});
  
  // Populate existing list
  modalExistingList.innerHTML='';
  var baseName='zMarkdown_'+ORIG_FILENAME.replace(/\.[^.]+$/,'');
  var matchCount=0;
  for(var i=0;i<currentFiles.length;i++){
    if(currentFiles[i].name.startsWith(baseName)){
      var item=document.createElement('div');item.className='modal-list-item';item.textContent=currentFiles[i].name;
      modalExistingList.appendChild(item);matchCount++;
    }
  }
  if(matchCount===0){modalExistingList.innerHTML='<div style="font-size:10px;opacity:0.4;padding:4px">No existing versions found</div>'}

  if(isNew||!currentFileName){
    h3.textContent='New Annotation Save';
    saveModal.classList.remove('hidden');
    saveFileNameInput.value='';
    saveLocationInput.value=chosenFolder;
  }else{
    h3.textContent='Update Annotations';
    confirmSave(currentFileName,chosenFolder);
  }
  validateSave(); // Validate on modal open
}
btnSaveAnnotations.addEventListener('click',function(){triggerSave(false)});
btnNewSaveAnnotations.addEventListener('click',function(){triggerSave(true)});
document.getElementById('btnSaveCancel').addEventListener('click',function(){saveModal.classList.add('hidden')});
function validateSave(){
  var name=saveFileNameInput.value.trim();
  var exists=currentFiles.some(function(f){return f.name.toLowerCase()===name.toLowerCase()});
  saveFileNameInput.classList.toggle('conflict',exists);
  btnIncrement.classList.toggle('available',!exists && !!name);
  btnIncrement.style.color = exists ? '#e74c3c' : (name ? '#2ecc71' : '#e74c3c');
  document.getElementById('conflictMsg').style.display=exists?'block':'none';
  document.getElementById('btnSaveConfirm').disabled=exists||!name;
}
saveFileNameInput.addEventListener('input',validateSave);
btnIncrement.addEventListener('click',function(){
  var val=saveFileNameInput.value;
  var idx=val.lastIndexOf('_A');
  if(idx!==-1){
    var prefix=val.substring(0,idx);
    var suffix=val.substring(idx+2);
    var numMatch=suffix.match(/^(\d+)/);
    if(numMatch){
      var nextV=parseInt(numMatch[1])+1;
      saveFileNameInput.value=prefix+'_A'+nextV+suffix.substring(numMatch[1].length);
    }else{
      saveFileNameInput.value+='_A1';
    }
  }else{
    saveFileNameInput.value+='_A1';
  }
  validateSave();
});
document.getElementById('btnAutoFill').addEventListener('click',function(){
  var baseName='zMarkdown_'+ORIG_FILENAME.replace(/\.[^.]+$/,'');
  var maxV=0;
  for(var i=0;i<currentFiles.length;i++){
    var match=currentFiles[i].name.match(/_A(\d+)/i);
    if(match){var v=parseInt(match[1]);if(v>maxV)maxV=v}
  }
  var v=Math.max(nextVersion,maxV+1);
  saveFileNameInput.value=baseName+'_A'+v;
  validateSave();
});
document.getElementById('btnBrowse').addEventListener('click',function(){vscodeApi.postMessage({type:'pickFolder'})});
document.getElementById('btnSaveConfirm').addEventListener('click',function(){
  if(document.getElementById('btnSaveConfirm').disabled)return;
  confirmSave(saveFileNameInput.value,chosenFolder);saveModal.classList.add('hidden');
});
btnSavedAnnotations.addEventListener('click',function(){savedDropdown.classList.toggle('hidden');if(!savedDropdown.classList.contains('hidden'))vscodeApi.postMessage({type:'listSavedAnnotations'})});

window.addEventListener('message',function(e){
  var msg=e.data;
  if(msg.type==='annotationsSaved'){
    hasSavedAnnotations=true;setDirty(false);
    currentFileName=msg.fileName;updateFileDisplay();
    var vMatch=msg.fileName.match(/_A(\d+)$/i);
    if(vMatch){nextVersion=Math.max(nextVersion,parseInt(vMatch[1])+1)}
    savedAnnotationsWrap.classList.remove('hidden');
    vscodeApi.postMessage({type:'listSavedAnnotations'});
  }
  else if(msg.type==='savedAnnotationsList'){
    console.log('Detected annotation files:', msg.files ? msg.files.length : 0);
    currentFiles=msg.files||[];
    savedDropdown.innerHTML='';currentFiles.forEach(function(f){
      var d=document.createElement('div');d.className='saved-dropdown-item';
      var span=document.createElement('span');span.textContent=f.name;span.style.flex='1';
      span.onclick=function(){
        if(isDirty && !confirm("Discard unsaved changes and load '"+f.name+"'?")) return;
        vscodeApi.postMessage({type:'loadAnnotations',filePath:f.fullPath,fileName:f.name});
        savedDropdown.classList.add('hidden');
      };
      var del=document.createElement('div');del.className='saved-delete-btn';del.textContent='x';
      del.onclick=function(e){
        e.stopPropagation();
        if(del.classList.contains('confirm')){vscodeApi.postMessage({type:'deleteAnnotationSet',filePath:f.fullPath,fileName:f.name})}
        else{del.classList.add('confirm');del.textContent='Confirm?';setTimeout(function(){del.classList.remove('confirm');del.textContent='x'},3000)}
      };
      d.appendChild(span);d.appendChild(del);savedDropdown.appendChild(d)});
    
    // Auto-detect next version
    var maxV=0;
    (msg.files||[]).forEach(function(f){
      var vMatch=f.name.match(/_A(\d+).*/i);
      if(vMatch){var v=parseInt(vMatch[1]);if(v>maxV)maxV=v}
    });
    nextVersion=Math.max(nextVersion,maxV+1);

    if(msg.files&&msg.files.length>0)savedAnnotationsWrap.classList.remove('hidden')}
  else if(msg.type==='annotationsLoaded'){annotations=msg.annotations||[];currentFileName=msg.fileName;setDirty(false);activeTool=null;updateFileDisplay();toggleAnnotationMode(true);renderNotes()}
  else if(msg.type==='folderPicked'){chosenFolder=msg.folder;saveLocationInput.value=msg.folder}
  else if(msg.type==='cropPresets'){cropPresets=msg.presets&&msg.presets.length?msg.presets:[{amount:25,edge:'top'}];renderCropPresets()}
});

renderCropPresets();

function loadImage(src,cb){var img=new Image();img.onload=function(){cb(img)};img.onerror=function(){statusBar.textContent='Failed to load image'};img.src=src}
window.addEventListener('resize',function(){sizeCanvas();draw()});
titleToggle.onclick=function(){document.body.classList.toggle('minimized');draw()};
if(IS_EXPORT){
  btnCrop.style.display='none';
  btnReset.style.display='none';
  btnSave.style.display='none';
  titleToggle.innerHTML = '&#128065; Export Viewer';
  if(savedAnnotationsWrap)savedAnnotationsWrap.style.display='none';
  if(btnAnnotationMode)btnAnnotationMode.style.display='none';
}
loadImage(IMAGE_SRC,function(img){originalImage=img;currentImage=img;sizeCanvas();baseScale=computeFit(img);centerImage();draw();if(!IS_EXPORT)vscodeApi.postMessage({type:'listSavedAnnotations'})});
})();
</script>
</body></html>`;
  }
}
