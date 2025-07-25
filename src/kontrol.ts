import { Client } from 'openapi-fetch';
import { parse } from 'smol-toml';
import * as vscode from 'vscode';
import { getKaasBaseUrl } from './config';
import {
  getGitInfo,
  getGitRepository,
  gitApi,
  hasUnpushedChanges,
  hasWorkingTreeChanges,
} from './git';
import { components, JobKind, JobStatus, paths } from './kaas-api';
import { getJobStatusByJobId, pollForJobStatus } from './kaas_jobs';
import { verifyVaultExists } from './kaas_vault';
import { TestRunState } from './test_run_state';

interface KontrolToml {
  prove: {
    [key: string]: KontrolProfile;
  };
  [key: string]: any;
}

interface KontrolProfile {
  'match-test': string;
  [key: string]: any;
}

export async function kontrolProfiles(
  worksaceFolder: vscode.WorkspaceFolder,
  client: Client<paths>,
  testController: vscode.TestController,
  testRunState: TestRunState,
  proveRoot: vscode.TestItem
): Promise<void> {
  const git = await gitApi();
  if (!git) {
  }
  const queue: Promise<void>[] = [];
  // Does the folder contain a kontrol.toml file?
  const kontrolTomlPath = vscode.Uri.joinPath(worksaceFolder.uri, 'kontrol.toml');
  try {
    const kontrolTomlExists = await vscode.workspace.fs.stat(kontrolTomlPath);
    if (kontrolTomlExists) {
      const gitInfo = await getGitInfo(worksaceFolder);

      // If it exists, parse the file
      const kontrolTomlContent = await vscode.workspace.fs.readFile(kontrolTomlPath);
      const kontrolToml = parse(kontrolTomlContent.toString()) as KontrolToml;
      // Create a test item for each profile in the kontrol.toml
      const proveProfiles = Object.entries(kontrolToml.prove);
      for (const [profileName, profile] of proveProfiles) {
        const testName = profile['match-test'];
        const testItem = testController.createTestItem(profileName, profileName, kontrolTomlPath);
        proveRoot.children.add(testItem);

        const storedJobId = testRunState.getJobId(testItem);
        if (storedJobId) {
          queue.push(updateTestFromJobId(client, testController, testItem, storedJobId, true));
        }
      }

      if (!gitInfo) {
        proveRoot.description =
          "Could not determine git origin. Make sure you are in a git repository with a remote named 'origin'.";
      }
    }
  } catch (error) {
    // We expect an error if the file doesn't exist, so we can ignore it.
  }
  await Promise.all(queue);
}

export async function runKontrolProfileViaKaaS(
  worksaceFolder: vscode.WorkspaceFolder,
  client: Client<paths>,
  testController: vscode.TestController,
  testRun: vscode.TestRun,
  test: vscode.TestItem,
  testRunState: TestRunState
): Promise<void> {
  console.log(`Processing Kontrol test: ${test.id}`);
  test.busy = true;
  testRun.enqueued(test);

  if (!test.uri) {
    console.error(`Test ${test.id} has no URI, skipping.`);
    test.busy = false;
    testRun.errored(test, new vscode.TestMessage('Test has no file URI.'));
    return;
  }

  // --- Dirty git check ---
  const git = gitApi();
  const repository = await getGitRepository(git, worksaceFolder);
  if (repository) {
    const workingTreeChanges = await hasWorkingTreeChanges(repository);
    const unpushedChanges = await hasUnpushedChanges(repository);
    if (workingTreeChanges || unpushedChanges) {
      const proceed = await vscode.window.showWarningMessage(
        'You have uncommitted or unpushed changes. Please commit and push your changes before running a remote job on KaaS.',
        { modal: true },
        'Proceed Anyway',
        'Cancel'
      );
      if (proceed !== 'Proceed Anyway') {
        test.busy = false;
        testRun.errored(test, new vscode.TestMessage('Job cancelled due to dirty git state.'));
        return;
      }
    }
  }

  const gitInfo = await getGitInfo(worksaceFolder);
  if (!gitInfo) {
    vscode.window
      .showErrorMessage(
        'KaaS requires access to your remote repository. Please install the Runtime Verification GitHub App and grant access.',
        'Install App'
      )
      .then(selection => {
        if (selection === 'Install App') {
          vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/apps/runtime-verification-inc')
          );
        }
      });
    console.error(`Could not get git info for ${test.uri.fsPath}`);
    test.busy = false;
    testRun.errored(
      test,
      new vscode.TestMessage(
        'Could not determine git origin. Make sure you are in a git repository with a remote named "origin" and KaaS has access.'
      )
    );
    return;
  }
  console.log(`Git info for ${test.id}:`, gitInfo);

  const { owner: organizationName, repo: vaultName } = gitInfo;

  const verificationError = await verifyVaultExists(client, organizationName, vaultName);
  if (verificationError) {
    console.error(
      `Vault verification failed for ${organizationName}/${vaultName}: ${verificationError}`
    );
    test.busy = false;
    testRun.errored(test, new vscode.TestMessage(verificationError));
    return;
  }
  console.log(`Vault verified for ${test.id}`);

  let profiles: components['schemas']['CreateProveProfileDto'][];

  // A test under 'kontrolProve' is a profile run.
  // A test under 'kontrolTests' is a single test run.
  if (test.parent?.id === 'kontrolProve') {
    profiles = [
      {
        profileName: test.id,
        extraProveArgs: '',
        tag: 'latest',
      },
    ];
  } else {
    profiles = [
      {
        profileName: 'default',
        extraProveArgs: `--match-test ${test.id}`,
        tag: 'latest',
      },
    ];
  }

  const body: components['schemas']['CreateJobDto'] = {
    branch: gitInfo.branch,
    kontrolVersion: '',
    kontrolDockerImage: '',
    kaasCliBranch: 'master',
    extraBuildArgs: '', // Not yet configurable
    foundryProfile: 'default',
    profiles: profiles,
    workflowBranch: 'main',
    kaasServerUrl: getKaasBaseUrl(),
    kind: JobKind.kontrol,
  };
  console.log(`Submitting job for test ${test.id} with body:`, body);
  vscode.window.showInformationMessage(`Starting KaaS job for: ${test.id}`);

  try {
    const jobResponse = await client.POST('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
      params: {
        path: {
          organizationName,
          vaultName,
        },
      },
      body: body,
    });

    if (jobResponse.error) {
      console.error(`Job creation failed for ${test.id}:`, jobResponse.error);
      test.busy = false;
      testRun.errored(
        test,
        new vscode.TestMessage(`Failed to create job: ${JSON.stringify(jobResponse.error)}`)
      );
      return;
    }

    const job = jobResponse.data;
    if (!job) {
      console.error(`Job creation returned no data for ${test.id}`);
      test.busy = false;
      testRun.errored(test, new vscode.TestMessage('Job creation returned no data'));
      return;
    }
    console.log(`Job created for ${test.id} with KaaS ID: ${job.jobId}`);

    testRunState.setJobId(test, job.jobId);
    pollForJobStatus(client, testController, test, job.jobId);
  } catch (e: any) {
    console.error(`An exception occurred while creating job for ${test.id}:`, e);
    test.busy = false;
    testRun.errored(test, new vscode.TestMessage(`Failed to create job: ${e.message}`));
    return;
  }
}

async function updateTestFromJobId(
  client: Client<paths>,
  testController: vscode.TestController,
  testItem: vscode.TestItem,
  jobId: string,
  isStartup: boolean
): Promise<void> {
  let job: components['schemas']['IJob'] | undefined;
  try {
    job = await getJobStatusByJobId(client, jobId);
  } catch (error) {
    // Job might not be found, which is ok.
    return;
  }

  if (job === undefined) {
    return;
  }

  // On startup, we only want to display a status for jobs that are still actively running.
  // Finished jobs (pass or fail) from a previous session will be cleared, giving a "clean slate".
  if (
    isStartup &&
    (job.status === JobStatus.success ||
      job.status === JobStatus.failure ||
      job.status === JobStatus.processing_failed ||
      job.status === JobStatus.cancelled)
  ) {
    return;
  }

  const testRun = testController.createTestRun(new vscode.TestRunRequest([testItem], []));
  if (job.status === JobStatus.success) {
    testRun.passed(testItem, job.duration * 1000);
  } else if (job.status === JobStatus.cancelled) {
    testRun.errored(
      testItem,
      new vscode.TestMessage(`Job ${job.id} was cancelled`),
      job.duration * 1000
    );
  } else if (job.status === JobStatus.failure || job.status === JobStatus.processing_failed) {
    testRun.failed(testItem, new vscode.TestMessage(`Job ${job.id} failed`), job.duration * 1000);
  } else if (job.status === JobStatus.pending || job.status === JobStatus.running) {
    testRun.enqueued(testItem);
    // Here you could implement polling for this specific job
  }
  testRun.end();
}
