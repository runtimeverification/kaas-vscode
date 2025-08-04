import * as vscode from 'vscode';

export function getKaasBaseUrl(): string {
  const config = vscode.workspace.getConfiguration('kaas-vscode');
  return config.get<string>('baseUrl') || 'https://kaas.runtimeverification.com';
}

export function validateKaasBaseUrl(url: string): { isValid: boolean; error?: string } {
  try {
    const parsedUrl = new URL(url);

    // Check if it's HTTP or HTTPS
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { isValid: false, error: 'Base URL must use HTTP or HTTPS protocol' };
    }

    // Check if hostname is provided
    if (!parsedUrl.hostname) {
      return { isValid: false, error: 'Base URL must include a valid hostname' };
    }

    return { isValid: true };
  } catch (error) {
    return {
      isValid: false,
      error: `Invalid URL format: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function validateKaasBaseUrlReachability(
  url: string
): Promise<{ isReachable: boolean; error?: string }> {
  // First check if the URL format is valid
  const formatValidation = validateKaasBaseUrl(url);
  if (!formatValidation.isValid) {
    return { isReachable: false, error: formatValidation.error };
  }

  try {
    // Try to reach the /api/hello endpoint
    const helloUrl = `${url.replace(/\/$/, '')}/api/hello`;
    const response = await fetch(helloUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      // Set a reasonable timeout
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (response.status === 200) {
      return { isReachable: true };
    } else {
      return {
        isReachable: false,
        error: `Server responded with status ${response.status}`,
      };
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return { isReachable: false, error: 'Request timed out - server may be unreachable' };
      }
      return {
        isReachable: false,
        error: `Failed to reach server: ${error.message}`,
      };
    }
    return {
      isReachable: false,
      error: 'Failed to reach server: Unknown error',
    };
  }
}

export function getGithubAppInstallUrl(): string {
  const baseUrl = getKaasBaseUrl();
  const isProduction = baseUrl.startsWith('https://kaas.runtimeverification.com');
  return isProduction
    ? 'https://github.com/apps/runtime-verification-inc/installations/new'
    : 'https://github.com/apps/runtime-verification-inc-sandbox/installations/new';
}

export enum TestKind {
  foundry = 'foundry',
  kontrol = 'kontrol',
}

export const KAAS_JOB_POLL_INTERVAL = 5000;
