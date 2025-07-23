import { Client } from 'openapi-fetch';
import { getGithubAppInstallUrl } from './config';
import { components, paths } from './kaas-api';

export async function verifyVaultExists(
  client: Client<paths>,
  organizationName: string,
  vaultName: string
): Promise<string | undefined> {
  // returns error message string or undefined if ok
  try {
    const orgsResponse = await client.GET('/api/orgs');
    if (!orgsResponse.data) {
      const githubAppUrl = getGithubAppInstallUrl();

      return `Failed to fetch organizations: ${JSON.stringify(orgsResponse.error)}.\nPlease ensure the GitHub app is installed for your repository by visiting:\n${githubAppUrl}`;
    }

    const org = orgsResponse.data.find(
      (o: components['schemas']['IOrganizationSummary']) => o.name === organizationName
    );
    if (!org) {
      const githubAppUrl = getGithubAppInstallUrl();

      return `Organization '${organizationName}' not found on KaaS.\nPlease ensure the GitHub app is installed for your repository by visiting:\n${githubAppUrl}`;
    }

    const vaultsResponse = await client.GET('/api/orgs/{organizationName}/vaults', {
      params: { path: { organizationName } },
    });

    if (!vaultsResponse.data) {
      return `Failed to fetch vaults for organization '${organizationName}': ${JSON.stringify(vaultsResponse.error)}`;
    }

    const vault = vaultsResponse.data.find(
      (v: components['schemas']['IVault']) => v.name === vaultName
    );
    if (!vault) {
      return `Vault '${vaultName}' not found in organization '${organizationName}' on KaaS.`;
    }
  } catch (e: any) {
    return `Error validating org/vault: ${e.message}`;
  }
  return undefined; // No error
}
