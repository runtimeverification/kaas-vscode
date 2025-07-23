import * as vscode from 'vscode';

export function getKaasBaseUrl(): string {
  const config = vscode.workspace.getConfiguration('kaas-vscode');
  return config.get<string>('baseUrl') || 'https://kaas.runtimeverification.com';
}

export const KAAS_JOB_POLL_INTERVAL = 5000;
