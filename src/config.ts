import * as vscode from 'vscode';

export function getKaasBaseUrl(): string {
  const config = vscode.workspace.getConfiguration('kaas-vscode');
  return config.get<string>('baseUrl') || 'https://kaas.runtimeverification.com';
}

export function getGithubAppInstallUrl(): string {
  const baseUrl = getKaasBaseUrl();
  const isProduction = baseUrl.startsWith('https://kaas.runtimeverification.com');
  return isProduction
    ? 'https://github.com/apps/runtime-verification-inc/installations/new'
    : 'https://github.com/apps/runtime-verification-inc-sandbox/installations/new';
}

export const KAAS_JOB_POLL_INTERVAL = 5000;
