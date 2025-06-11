import * as vscode from 'vscode';
import createClient from "openapi-fetch";
import { type paths } from "./kaas-api";
import * as path from 'path';
import * as ChildProcess from 'child_process';
import { fetchComputeJobs } from './kaas_jobs';
import { runTests } from './kaas_run';
import { discoverFoundryTestsAndPopulate, discoverFoundryProfiles } from './foundry';
import { kontrolProfiles } from './kontrol';
import { TestRunState } from './test_run_state';
import { KAAS_BASE_URL } from './config';
import { create } from 'domain';
import { createRemoteSyncView } from './remote_sync_view';

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

	const testController = vscode.tests.createTestController('kaas-vscode.testController', 'KaaS Proofs');
	const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
	let client = createClient<paths>({ baseUrl: KAAS_BASE_URL, headers: { 'Authorization': `Bearer ${apiKey}` } });
    
	// Lets make sure we update the client if the api key changes
	vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('kaas-vscode.apiKey')) {
			const newApiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
			client = createClient<paths>({ baseUrl: KAAS_BASE_URL, headers: { 'Authorization': `Bearer ${newApiKey}` } });
		}
	});

	const testRunState = new TestRunState(context);

	// Create root items for Kontrol and Foundry if their respective config files exist.
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const rootPath = workspaceFolders[0].uri;
		
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'kontrol.toml'));
			const kontrolRoot = testController.createTestItem('kontrol', 'Kontrol');
			testController.items.add(kontrolRoot);
			const kontrolProfilesRoot = testController.createTestItem('kontrolProfiles', 'Profiles');
			kontrolRoot.children.add(kontrolProfilesRoot);
			const kontrolProveRoot = testController.createTestItem('kontrolProve', 'Prove');
			kontrolProfilesRoot.children.add(kontrolProveRoot);
			const kontrolTestsRoot = testController.createTestItem('kontrolTests', 'Tests');
			kontrolRoot.children.add(kontrolTestsRoot);

			await kontrolProfiles(client, testController, testRunState, kontrolProveRoot);
			await discoverFoundryTestsAndPopulate(testController, kontrolTestsRoot);

		} catch (e) {
			// kontrol.toml not found
		}

		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'foundry.toml'));
			const foundryRoot = testController.createTestItem('foundry', 'Foundry');
			testController.items.add(foundryRoot);
			const foundryProfilesRoot = testController.createTestItem('foundryProfiles', 'Profiles');
			foundryRoot.children.add(foundryProfilesRoot);
			const foundryTestsRoot = testController.createTestItem('foundryTests', 'Tests');
			foundryRoot.children.add(foundryTestsRoot);

			await discoverFoundryProfiles(testController, foundryProfilesRoot);
			await discoverFoundryTestsAndPopulate(testController, foundryTestsRoot);

		} catch (e) {
			// foundry.toml not found
		}
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('kaas-vscode.helloWorld', () => {
			vscode.window.showInformationMessage('Welcome to Simbolik powered by KaaS!');
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

	const runProfile = testController.createRunProfile(
		'Run KaaS Tests',
		vscode.TestRunProfileKind.Run,
		(request, token) => {
			runTests(client, testController, request, token, testRunState);
		},
		true
	);

	context.subscriptions.push(testController);

	// Add Remote Sync View
	const view = await createRemoteSyncView(context);
	context.subscriptions.push(view);
}

export function deactivate() {}
