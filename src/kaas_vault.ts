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

    const vaultResponse = await client.GET('/api/orgs/{organizationName}/vaults/{vaultName}', {
      params: { path: { organizationName, vaultName } },
    });

    if (!vaultResponse.data) {
      // Vault doesn't exist, try to link it to the organization automatically
      try {
        const linkResponse = await client.POST('/api/orgs/{organizationName}/vaults/{vaultName}', {
          params: { path: { organizationName, vaultName } },
        });

        if (!linkResponse.data) {
          return `Failed to link vault '${vaultName}' to organization '${organizationName}': ${JSON.stringify(linkResponse.error)}`;
        }
        // Successfully linked the vault
      } catch (linkError: any) {
        return `Failed to link vault '${vaultName}' to organization '${organizationName}': ${linkError.message}`;
      }
    }
    // Vault exists or was successfully linked
  } catch (e: any) {
    return `Error validating org/vault: ${e.message}`;
  }
  return undefined; // No error
}
