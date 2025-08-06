import { Client } from 'openapi-fetch';
import * as vscode from 'vscode';
import { TestKind } from './config';
import { runFoundryTestViaKaaS } from './foundry';
import {
  getGitInfo,
  getGitRepository,
  gitApi,
  GitInfo,
  hasUnpushedChanges,
  hasWorkingTreeChanges,
} from './git';
import { paths } from './kaas-api';
import { verifyVaultExists } from './kaas_vault';
import { runKontrolProfileViaKaaS } from './kontrol';
import { TestRunState } from './test_run_state';

function getTestId(test: vscode.TestItem): string | undefined {
  let current = test;
  while (current.parent?.parent) {
    current = current.parent;
  }
  return current.id;
}

export function gatherLeafTests(test: vscode.TestItem, collection: Set<vscode.TestItem>) {
  if (test.children.size > 0) {
    test.children.forEach(child => gatherLeafTests(child, collection));
  } else if (test.uri) {
    // It's a leaf node with a file URI
    collection.add(test);
  }
}

export async function runTests(
  workspaceFolder: vscode.WorkspaceFolder,
  client: Client<paths>,
  testController: vscode.TestController,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
  testRunState: TestRunState
): Promise<void> {
  const testRun = testController.createTestRun(request);
  const testsToRun = new Set<vscode.TestItem>();
  console.log('runTests triggered');

  if (request.include) {
    console.log(`Request includes ${request.include.length} items.`);
    request.include.forEach(test => gatherLeafTests(test, testsToRun));
  } else {
    // Run all tests
    console.log('Request to run all tests.');
    testController.items.forEach(test => gatherLeafTests(test, testsToRun));
  }
  console.log(`Found ${testsToRun.size} leaf tests to run.`);

  if (testsToRun.size === 0) {
    testRun.end();
    return;
  }

  // Perform common validation checks once before running any tests
  let validatedGitInfo: GitInfo | null = null;

  try {
    // --- Dirty git check ---
    const git = gitApi();
    const repository = await getGitRepository(git, workspaceFolder);
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
          for (const test of testsToRun) {
            testRun.errored(test, new vscode.TestMessage('Job cancelled due to dirty git state.'));
          }
          testRun.end();
          return;
        }
      }
    }

    // --- Git info validation ---
    const gitInfo = await getGitInfo(workspaceFolder);
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
      console.error(`Could not get git info for workspace ${workspaceFolder.name}`);
      for (const test of testsToRun) {
        testRun.errored(
          test,
          new vscode.TestMessage(
            'Could not determine git origin. Make sure you are in a git repository with a remote named "origin" and KaaS has access.'
          )
        );
      }
      testRun.end();
      return;
    }

    validatedGitInfo = gitInfo;
    console.log(`Git info for workspace ${workspaceFolder.name}:`, gitInfo);

    // --- Vault verification ---
    const { owner: organizationName, repo: vaultName } = gitInfo;
    const verificationError = await verifyVaultExists(client, organizationName, vaultName);
    if (verificationError) {
      console.error(
        `Vault verification failed for ${organizationName}/${vaultName}: ${verificationError}`
      );
      for (const test of testsToRun) {
        testRun.errored(test, new vscode.TestMessage(verificationError));
      }
      testRun.end();
      return;
    }
    console.log(`Vault verified for workspace ${workspaceFolder.name}`);
  } catch (error) {
    console.error('Pre-run validation failed:', error);
    for (const test of testsToRun) {
      testRun.errored(
        test,
        new vscode.TestMessage(
          `Pre-run validation failed: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
    testRun.end();
    return;
  }

  // Now run each test with the validated information
  const runningTests = new Set<vscode.TestItem>();

  for (const test of testsToRun) {
    if (token.isCancellationRequested) {
      break;
    }
    const testId = getTestId(test);
    runningTests.add(test);

    if (testId === TestKind.kontrol) {
      await runKontrolProfileViaKaaS(
        workspaceFolder,
        client,
        testController,
        testRun,
        test,
        testRunState,
        validatedGitInfo,
        runningTests
      );
    } else if (testId === TestKind.foundry) {
      await runFoundryTestViaKaaS(
        workspaceFolder,
        client,
        testController,
        testRun,
        test,
        testRunState,
        validatedGitInfo,
        runningTests
      );
    } else {
      console.warn(`Unknown test kind for test ${testId}, skipping.`);
      testRun.errored(test, new vscode.TestMessage(`Unknown test kind: ${testId}`));
      runningTests.delete(test);
    }
  }

  // If no tests were actually started (e.g., all were unknown kinds), end the test run
  if (runningTests.size === 0) {
    testRun.end();
  }
}
