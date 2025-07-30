import createClient from 'openapi-fetch';
import * as vscode from 'vscode';
import { getKaasBaseUrl, TestKind } from './config';
import { discoverFoundryProfiles, discoverFoundryTestsAndPopulate } from './foundry';
import { type paths, components } from './kaas-api';
import { getJobStatusByJobId } from './kaas_jobs';
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
  const client = createClient<paths>({ baseUrl: getKaasBaseUrl() });
  client.use({
    onRequest: request => {
      const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
      request.request.headers.set('Authorization', `Bearer ${apiKey}`);
    },
  });

  const testRunState = new TestRunState(context);

  // Create root items for Kontrol and Foundry if their respective config files exist.
  const workspaceFolders = vscode.workspace.workspaceFolders;
  for (const workspaceFolder of workspaceFolders || []) {
    const rootPath = workspaceFolder.uri;

    const worrkspaceItem = testController.createTestItem(
      workspaceFolder.name,
      workspaceFolder.name
    );
    testController.items.add(worrkspaceItem);

    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'kontrol.toml'));
      const kontrolRoot = testController.createTestItem(TestKind.kontrol, 'Kontrol');
      worrkspaceItem.children.add(kontrolRoot);
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
      worrkspaceItem.children.add(foundryRoot);
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

  // Helper function to create and show webview with authentication
  function createAuthenticatedWebview(
    url: string,
    viewType: string,
    title: string
  ): vscode.WebviewPanel {
    const baseUrl = getKaasBaseUrl();
    const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
    const authUrl = `${url}?api-token=${apiKey}`;

    console.log(`authUrl: `, authUrl);

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
      </head>
      <body>
          <iframe src="${authUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation allow-popups allow-popups-to-escape-sandbox"></iframe>
      </body>
      </html>
    `;

    return panel;
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

        try {
          // Get the job details to construct the proper job URL
          const parentJob = await getJobStatusByJobId(client, jobId);
          const job = findJobFromChildren(parentJob, testItem.label);

          const baseUrl = getKaasBaseUrl();
          const jobUrl = `${baseUrl}/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}`;

          createAuthenticatedWebview(jobUrl, 'jobDetails', 'Job Details');
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open job details: ${error}`);
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

        const baseUrl = getKaasBaseUrl();
        const reportUrl = `${baseUrl}/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}/report`;

        createAuthenticatedWebview(reportUrl, 'jobReport', 'Job Report');
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

        if (!job.cacheHash) {
          vscode.window.showInformationMessage(
            'No cache is available for this job. Cache may not have been generated or preserved.'
          );
          return;
        }

        const baseUrl = getKaasBaseUrl();
        const cacheUrl = `${baseUrl}/app/organization/${job.organizationName}/${job.vaultName}/cache/${job.cacheHash}`;

        createAuthenticatedWebview(cacheUrl, 'jobCache', 'Job Cache');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open job cache: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kaas-vscode.refreshComputeJobs', async () => {
      testController.items.replace([]);
      // This command is now less relevant, as discovery happens on start.
      // Could be re-purposed to re-run discovery.
    })
  );

  // The refresh handler should re-run the discovery logic
  testController.refreshHandler = async () => {
    // This needs to be implemented to clear and re-populate the roots
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
  const view = await createRemoteSyncView(context, client);
  context.subscriptions.push(view);
}

export function deactivate() {}
