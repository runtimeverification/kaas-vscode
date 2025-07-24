import { Client } from 'openapi-fetch';
import * as vscode from 'vscode';
import { TestKind } from './config';
import { runFoundryTestViaKaaS } from './foundry';
import { paths } from './kaas-api';
import { runKontrolProfileViaKaaS } from './kontrol';
import { TestRunState } from './test_run_state';

function getTestId(test: vscode.TestItem): string | undefined {
  let current = test;
  while (current.parent?.parent) {
    current = current.parent;
  }
  return current.id;
}

function gatherLeafTests(test: vscode.TestItem, collection: Set<vscode.TestItem>) {
  if (test.children.size > 0) {
    test.children.forEach(child => gatherLeafTests(child, collection));
  } else if (test.uri) {
    // It's a leaf node with a file URI
    collection.add(test);
  }
}

export async function runTests(
  worksaceFolder: vscode.WorkspaceFolder,
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

  for (const test of testsToRun) {
    if (token.isCancellationRequested) {
      break;
    }
    const testId = getTestId(test);

    if (testId === TestKind.kontrol) {
      await runKontrolProfileViaKaaS(
        worksaceFolder,
        client,
        testController,
        testRun,
        test,
        testRunState
      );
    } else if (testId === TestKind.foundry) {
      await runFoundryTestViaKaaS(
        worksaceFolder,
        client,
        testController,
        testRun,
        test,
        testRunState
      );
    } else {
      console.warn(`Unknown test kind for test ${testId}, skipping.`);
      testRun.errored(test, new vscode.TestMessage(`Unknown test kind: ${testId}`));
    }
  }

  // The 'end' of the testRun is now handled by the polling function for each individual test.
  // This allows the "Run All" to show progress correctly.
}
