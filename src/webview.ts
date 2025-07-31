import * as vscode from 'vscode';

// Helper function to create and show webview with authentication
export function createAuthenticatedWebview(
  url: string,
  viewType: string,
  title: string
): vscode.WebviewPanel {
  const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
  const authUrl = `${url}?api-token=${apiKey}`;

  const panel = vscode.window.createWebviewPanel(viewType, title, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>${title}</title>
          <style>
              body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; }
              iframe { width: 100%; height: 100vh; border: none; }
          </style>
          <script>
              const vscode = acquireVsCodeApi();
              
              // Listen for messages from the iframe
              window.addEventListener('message', (event) => {
                  if (event.data && event.data.type === 'openExternal') {
                      vscode.postMessage({
                          command: 'openExternal',
                          url: event.data.url
                      });
                  }
              });
          </script>
      </head>
      <body>
          <iframe src="${authUrl}"></iframe>
      </body>
      </html>
    `;

  // Handle messages from webview
  panel.webview.onDidReceiveMessage(message => {
    switch (message.command) {
      case 'openExternal':
        vscode.env.openExternal(vscode.Uri.parse(message.url));
        break;
    }
  });

  return panel;
}
