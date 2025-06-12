import { components, paths, JobKind, JobStatus } from "./kaas-api";
import { Client } from "openapi-fetch";
import * as vscode from 'vscode';
import { TestRunState } from "./test_run_state";
import { runFoundryTestViaKaaS } from './foundry';
import { runKontrolProfileViaKaaS } from './kontrol';

function getRootTestId(test: vscode.TestItem): string | undefined {
	let current = test;
	while (current.parent) {
		current = current.parent;
	}
	return current.id;
}

function gatherLeafTests(test: vscode.TestItem, collection: Set<vscode.TestItem>) {
	if (test.children.size > 0) {
		test.children.forEach(child => gatherLeafTests(child, collection));
	} else if (test.uri) { // It's a leaf node with a file URI
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
) : Promise<void> {
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
		const rootId = getRootTestId(test);

		if (rootId === 'kontrol') {
			await runKontrolProfileViaKaaS(worksaceFolder, client, testController, testRun, test, testRunState);
		} else {
			await runFoundryTestViaKaaS(worksaceFolder, client, testController, testRun, test, testRunState);
		}
	}

	// The 'end' of the testRun is now handled by the polling function for each individual test.
	// This allows the "Run All" to show progress correctly.
}

