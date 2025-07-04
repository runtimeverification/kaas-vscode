import * as vscode from 'vscode';
import createClient from "openapi-fetch";
import { type paths } from "./kaas-api";
import { runTests } from './kaas_run';
import { discoverFoundryTestsAndPopulate, discoverFoundryProfiles } from './foundry';
import { kontrolProfiles } from './kontrol';
import { TestRunState } from './test_run_state';
import { KAAS_BASE_URL } from './config';
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
	const client = createClient<paths>({ baseUrl: KAAS_BASE_URL });
	client.use({
		onRequest: (request) => {
			const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
			request.request.headers.set('Authorization', `Bearer ${apiKey}`);
		}
	})

	const testRunState = new TestRunState(context);

	// Create root items for Kontrol and Foundry if their respective config files exist.
	const workspaceFolders = vscode.workspace.workspaceFolders;
	for (const workspaceFolder of workspaceFolders || []) {
		const rootPath = workspaceFolder.uri;

		const worrkspaceItem = testController.createTestItem(workspaceFolder.name, workspaceFolder.name);
		testController.items.add(worrkspaceItem);
		
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'kontrol.toml'));
			const kontrolRoot = testController.createTestItem('kontrol', 'Kontrol');
			worrkspaceItem.children.add(kontrolRoot);
			const kontrolProfilesRoot = testController.createTestItem('kontrolProfiles', 'Profiles');
			kontrolRoot.children.add(kontrolProfilesRoot);
			const kontrolProveRoot = testController.createTestItem('kontrolProve', 'Prove');
			kontrolProfilesRoot.children.add(kontrolProveRoot);
			const kontrolTestsRoot = testController.createTestItem('kontrolTests', 'Tests');
			kontrolRoot.children.add(kontrolTestsRoot);

			await kontrolProfiles(workspaceFolder, client, testController, testRunState, kontrolProveRoot);
			await discoverFoundryTestsAndPopulate(workspaceFolder, testController, kontrolTestsRoot);

		} catch (e) {
			// kontrol.toml not found
		}

		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(rootPath, 'foundry.toml'));
			const foundryRoot = testController.createTestItem('foundry', 'Foundry');
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
