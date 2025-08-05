import createClient from 'openapi-fetch';
import * as vscode from 'vscode';
import { getKaasBaseUrl, TestKind } from './config';
import { discoverFoundryProfiles, discoverFoundryTestsAndPopulate } from './foundry';
import { type paths, components } from './kaas-api';
import { getJobStatusByJobId, jobCacheUri, jobReportUri } from './kaas_jobs';
import { runTests } from './kaas_run';
import { kontrolProfiles } from './kontrol';
import { createRemoteSyncView } from './remote_sync_view';
import { TestRunState } from './test_run_state';

interface KontrolProfile {
  'match-test': string;
  [key: string]: any;
}

interface KontrolToml {
  prove: {
    [key: string]: KontrolProfile;
  };
  [key: string]: any;
}

interface FoundryTest {
  filePath: string;
  testName: string;
  contractName: string;
}

export async function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "kaas-vscode" is now active!');

  const testController = vscode.tests.createTestController(
    'kaas-vscode.testController',
    'KaaS Proofs'
  );

  // Factory function to create a new client with current configuration
  const createKaasClient = () => {
    const client = createClient<paths>({ baseUrl: getKaasBaseUrl() });
    client.use({
      onRequest: request => {
        const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
        request.request.headers.set('Authorization', `Bearer ${apiKey}`);
      },
    });
    return client;
  };

  let client = createKaasClient();
  const testRunState = new TestRunState(context);

  // Function to discover tests for a specific workspace folder
  async function discoverTestsForWorkspace(workspaceFolder: vscode.WorkspaceFolder) {
    const rootPath = workspaceFolder.uri;

    const workspaceItem = testController.createTestItem(workspaceFolder.name, workspaceFolder.name);
    testController.items.add(workspaceItem);

    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'kontrol.toml'));
      const kontrolRoot = testController.createTestItem(TestKind.kontrol, 'Kontrol');
      workspaceItem.children.add(kontrolRoot);
      const kontrolProfilesRoot = testController.createTestItem('kontrolProfiles', 'Profiles');
      kontrolRoot.children.add(kontrolProfilesRoot);
      const kontrolProveRoot = testController.createTestItem('kontrolProve', 'Prove');
      kontrolProfilesRoot.children.add(kontrolProveRoot);
      const kontrolTestsRoot = testController.createTestItem('kontrolTests', 'Tests');
      kontrolRoot.children.add(kontrolTestsRoot);

      await kontrolProfiles(
        workspaceFolder,
        client,
        testController,
        testRunState,
        kontrolProveRoot
      );
      await discoverFoundryTestsAndPopulate(workspaceFolder, testController, kontrolTestsRoot);
    } catch (e) {
      // kontrol.toml not found
    }

    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'foundry.toml'));
      const foundryRoot = testController.createTestItem(TestKind.foundry, 'Foundry');
      workspaceItem.children.add(foundryRoot);
      const foundryProfilesRoot = testController.createTestItem('foundryProfiles', 'Profiles');
      foundryRoot.children.add(foundryProfilesRoot);
      const foundryTestsRoot = testController.createTestItem('foundryTests', 'Tests');
      foundryRoot.children.add(foundryTestsRoot);

      await discoverFoundryProfiles(workspaceFolder, testController, foundryProfilesRoot);
      await discoverFoundryTestsAndPopulate(workspaceFolder, testController, foundryTestsRoot);
    } catch (e) {
      // foundry.toml not found
    }
  }

  // Create root items for Kontrol and Foundry if their respective config files exist.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  for (const workspaceFolder of workspaceFolders || []) {
    await discoverTestsForWorkspace(workspaceFolder);
  }

  // Helper function to find the correct job from children based on test item name
  function findJobFromChildren(
    parentJob: components['schemas']['IJob'],
    testItemLabel: string
  ): components['schemas']['IJob'] {
    // If the job has children, try to find one that matches the test item name
    if (parentJob.children && parentJob.children.length > 0) {
      for (const childJob of parentJob.children) {
        if (childJob.profileName === testItemLabel) {
          return childJob;
        }
      }
    }
    // If no matching child found, return the parent job
    return parentJob;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('kaas-vscode.helloWorld', () => {
      vscode.window.showInformationMessage('Welcome to Simbolik powered by KaaS!');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'kaas-vscode.viewJobDetails',
      async (testItem: vscode.TestItem) => {
        const jobId = testRunState.getJobId(testItem);
        if (!jobId) {
          vscode.window.showInformationMessage(
            'No job has been started for this test yet. Run the test first to view job details.'
          );
          return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(testItem.uri!);
        if (workspaceFolder) {
          try {
            // Get git info to construct the proper job URL
            const { getGitInfo } = await import('./git');
            const gitInfo = await getGitInfo(workspaceFolder);

            if (gitInfo) {
              const baseUrl = getKaasBaseUrl();
              const jobUrl = `${baseUrl}/app/organization/${gitInfo.owner}/${gitInfo.repo}/job/${jobId}`;
              vscode.env.openExternal(vscode.Uri.parse(jobUrl));
            } else {
              // Fallback to basic URL if git info is not available
              const baseUrl = getKaasBaseUrl();
              const jobUrl = `${baseUrl}/app/job/${jobId}`;
              vscode.env.openExternal(vscode.Uri.parse(jobUrl));
            }
          } catch (error) {
            vscode.window.showErrorMessage(`Failed to open job details: ${error}`);
          }
        } else {
          vscode.window.showErrorMessage('Could not determine workspace folder for this test.');
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaas-vscode.viewReport', async (testItem: vscode.TestItem) => {
      const jobId = testRunState.getJobId(testItem);
      if (!jobId) {
        vscode.window.showInformationMessage(
          'No job has been started for this test yet. Run the test first to view the report.'
        );
        return;
      }

      try {
        // Get the job details to construct the proper report URI
        const parentJob = await getJobStatusByJobId(client, jobId);
        const job = findJobFromChildren(parentJob, testItem.label);
        const reportUri = jobReportUri(job);
        vscode.env.openExternal(reportUri);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open job report: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaas-vscode.viewCache', async (testItem: vscode.TestItem) => {
      const jobId = testRunState.getJobId(testItem);
      if (!jobId) {
        vscode.window.showInformationMessage(
          'No job has been started for this test yet. Run the test first to view the cache.'
        );
        return;
      }

      try {
        // Get the job details to construct the proper cache URI
        const parentJob = await getJobStatusByJobId(client, jobId);
        const job = findJobFromChildren(parentJob, testItem.label);
        const cacheUri = jobCacheUri(job);

        if (cacheUri) {
          vscode.env.openExternal(cacheUri);
        } else {
          vscode.window.showInformationMessage(
            'No cache is available for this job. Cache may not have been generated or preserved.'
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open job cache: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaas-vscode.refreshComputeJobs', async () => {
      // Re-run test discovery for all workspace folders
      testController.items.replace([]);
      const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
      for (const workspaceFolder of currentWorkspaceFolders || []) {
        await discoverTestsForWorkspace(workspaceFolder);
      }
    })
  );

  // The refresh handler should re-run the discovery logic
  testController.refreshHandler = async () => {
    // Clear all existing test items
    testController.items.replace([]);

    // Re-discover tests for all current workspace folders
    const currentWorkspaceFolders = vscode.workspace.workspaceFolders;
    for (const workspaceFolder of currentWorkspaceFolders || []) {
      await discoverTestsForWorkspace(workspaceFolder);
    }
  };

  for (const workspaceFolder of workspaceFolders || []) {
    const runProfile = testController.createRunProfile(
      'Run KaaS Tests',
      vscode.TestRunProfileKind.Run,
      (request, token) => {
        runTests(workspaceFolder, client, testController, request, token, testRunState);
      },
      true
    );
  }

  context.subscriptions.push(testController);

  // Add Remote Sync View
  let remoteSyncResult = await createRemoteSyncView(context, client);
  let view = remoteSyncResult.view;
  let remoteSyncDataProvider = remoteSyncResult.dataProvider;
  context.subscriptions.push(view);

  // Trigger initial refresh to ensure data loads
  remoteSyncDataProvider.update();

  // Register the refresh command once
  const refreshSyncViewCommand = vscode.commands.registerCommand(
    'kaas-vscode.refreshSyncView',
    () => {
      // Use the current remoteSyncDataProvider reference
      if (remoteSyncDataProvider && remoteSyncDataProvider.update) {
        remoteSyncDataProvider.update();
      }
    }
  );
  context.subscriptions.push(refreshSyncViewCommand);

  // Listen for configuration changes and refresh the sync view when relevant settings change
  const configChangeListener = vscode.workspace.onDidChangeConfiguration(async event => {
    if (
      event.affectsConfiguration('kaas-vscode.apiKey') ||
      event.affectsConfiguration('kaas-vscode.baseUrl')
    ) {
      if (event.affectsConfiguration('kaas-vscode.baseUrl')) {
        // Base URL changed - need to recreate client and update the data provider
        client = createKaasClient();

        // Update the data provider with the new client instead of recreating the whole view
        remoteSyncDataProvider.updateClient(client);

        vscode.window.showInformationMessage(
          'Base URL updated. All KaaS services are now using the new endpoint.'
        );
      } else {
        // Just API key changed - refresh the sync view to re-run checkSyncState
        // The client will pick up the new API key on the next request due to the onRequest middleware
        vscode.commands.executeCommand('kaas-vscode.refreshSyncView');
      }
    }
  });

  context.subscriptions.push(configChangeListener);

  // Listen for workspace folder changes and update views accordingly
  const workspaceFolderChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(
    async event => {
      // Handle removed folders
      for (const removedFolder of event.removed) {
        // Remove test items for the removed workspace folder
        const testItems = Array.from(testController.items);
        for (const [id, testItem] of testItems) {
          if (id === removedFolder.name) {
            testController.items.delete(id);
          }
        }
      }

      // Handle added folders - discover tests for new workspace folders
      for (const addedFolder of event.added) {
        await discoverTestsForWorkspace(addedFolder);

        // Create run profile for the new workspace folder
        const runProfile = testController.createRunProfile(
          'Run KaaS Tests',
          vscode.TestRunProfileKind.Run,
          (request, token) => {
            runTests(addedFolder, client, testController, request, token, testRunState);
          },
          true
        );
      }

      // Refresh the remote sync view to show updated workspace folders
      remoteSyncDataProvider.update();
    }
  );

  context.subscriptions.push(workspaceFolderChangeListener);
}

export function deactivate() {}
