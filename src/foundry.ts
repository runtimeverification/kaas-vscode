import * as vscode from 'vscode';
import * as path from 'path';
import * as child_process from 'child_process';
import { parse } from 'smol-toml';
import { Client } from 'openapi-fetch';
import { paths, components, JobKind } from './kaas-api';
import { TestRunState } from './test_run_state';
import { getGitInfo } from './git';
import { verifyVaultExists } from './kaas_vault';
import { KAAS_BASE_URL } from './config';
import { pollForJobStatus } from './kaas_jobs';

interface FoundryTest {
	filePath: string;
	testName: string;
	contractName: string;
}

interface FoundryToml {
	profile: {
		[key: string]: any;
	};
}

export async function runFoundryTest(test: vscode.TestItem, testRun: vscode.TestRun) {
	const testPath = test.uri?.fsPath;
	if (!testPath) {
		testRun.failed(test, new vscode.TestMessage('Test path not found.'));
		return;
	}

	try {
		const testName = test.id.split('.').pop();
		const command = `forge test --match-test ${testName} -vv`;

		const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
			const process = child_process.exec(command, { cwd: path.dirname(testPath) });
			let stdout = '';
			let stderr = '';

			if (process.stdout) {
				process.stdout.on('data', (data: string) => stdout += data);
			}
			if (process.stderr) {
				process.stderr.on('data', (data: string) => stderr += data);
			}

			process.on('close', (code: number) => {
				if (code === 0) {
					resolve({ stdout, stderr });
				} else {
					reject(new Error(`Test failed with code ${code}: ${stderr}`));
				}
			});
		});

		if (stdout.includes('test result: ok')) {
			testRun.passed(test);
		} else {
			testRun.failed(test, new vscode.TestMessage(stderr));
		}
	} catch (error) {
		testRun.failed(test, new vscode.TestMessage(error instanceof Error ? error.message : String(error)));
	}
}

export async function discoverFoundryTestsAndPopulate(
	testController: vscode.TestController,
	testsRoot: vscode.TestItem
) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		for (const folder of workspaceFolders) {
			// Check if there is a 'test' directory
			const testDir = path.join(folder.uri.fsPath, 'test');
			try {
				await vscode.workspace.fs.stat(vscode.Uri.file(testDir));
			} catch {
				continue; // No test directory, so skip this folder
			}

			const foundryTests = await discoverFoundryTests(folder);
			
			// Group tests by contract
			const testsByContract: { [key: string]: FoundryTest[] } = {};
			for (const test of foundryTests) {
				if (!testsByContract[test.contractName]) {
					testsByContract[test.contractName] = [];
				}
				testsByContract[test.contractName].push(test);
			}

			for (const contractName in testsByContract) {
				const contractTests = testsByContract[contractName];
				// Use the file path of the first test for the contract item URI.
				const contractUri = vscode.Uri.file(contractTests[0].filePath); 
				const contractItem = testController.createTestItem(contractName, contractName, contractUri);
				testsRoot.children.add(contractItem);

				for (const test of contractTests) {
					const testItem = testController.createTestItem(
						`${test.contractName}.${test.testName}`,
						test.testName,
						vscode.Uri.file(test.filePath)
					);
					// maybe set range here if I can find it easily
					testItem.range = new vscode.Range(0, 0, 0, 0); // placeholder
					contractItem.children.add(testItem);
				}
			}
		}
	}
}

export async function discoverFoundryTests(workspaceFolder: vscode.WorkspaceFolder): Promise<FoundryTest[]> {
	const tests: FoundryTest[] = [];
	const testDir = path.join(workspaceFolder.uri.fsPath, 'test');
	
	try {
		if (await vscode.workspace.fs.stat(vscode.Uri.file(testDir))) {
			const files = await vscode.workspace.findFiles(
				new vscode.RelativePattern(workspaceFolder, 'test/**/*.t.sol')
			);
			
			for (const file of files) {
				const content = await vscode.workspace.fs.readFile(file);
				const contentStr = content.toString();
				
				// Match test functions (both test_ and prove_ prefixes)
				const testRegex = /function\s+(test|prove)_([a-zA-Z0-9_]+)\s*\(/g;
				let match;
				
				// Extract contract name from the file
				const contractMatch = contentStr.match(/contract\s+([a-zA-Z0-9_]+)Test/);
				const contractName = contractMatch ? contractMatch[1] : path.basename(file.fsPath, '.t.sol');
				
				while ((match = testRegex.exec(contentStr)) !== null) {
					tests.push({
						filePath: file.fsPath,
						testName: match[2],
						contractName: contractName
					});
				}
			}
		}
	} catch (error) {
		console.error(`Error discovering Foundry tests in ${workspaceFolder.uri.fsPath}:`, error);
	}
	
	return tests;
}

export async function discoverFoundryProfiles(
	testController: vscode.TestController,
	profilesRoot: vscode.TestItem
) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		for (const folder of workspaceFolders) {
			const foundryTomlPath = vscode.Uri.joinPath(folder.uri, 'foundry.toml');
			try {
				const foundryTomlExists = await vscode.workspace.fs.stat(foundryTomlPath);
				if (foundryTomlExists) {
					const foundryTomlContent = await vscode.workspace.fs.readFile(foundryTomlPath);
					const foundryToml = parse(foundryTomlContent.toString()) as unknown as FoundryToml;

					if (foundryToml.profile) {
						const profiles = Object.keys(foundryToml.profile);
						for (const profileName of profiles) {
							// These profiles are not runnable via KaaS in the current implementation
							// We create them so the user can see them, but they won't have a play button.
							const testItem = testController.createTestItem(profileName, profileName, foundryTomlPath);
							profilesRoot.children.add(testItem);
						}
					}
				}
			} catch (error) {
				// We expect an error if the file doesn't exist, so we can ignore it.
			}
		}
	}
}

export async function runFoundryTestViaKaaS(
	client: Client<paths>,
	testController: vscode.TestController,
	testRun: vscode.TestRun,
	test: vscode.TestItem,
	testRunState: TestRunState
) : Promise<void> {
	console.log(`Processing Foundry test: ${test.id}`);
	test.busy = true;
	testRun.enqueued(test);

	if (!test.uri) {
		console.error(`Test ${test.id} has no URI, skipping.`);
		test.busy = false;
		testRun.errored(test, new vscode.TestMessage('Test has no file URI.'));
		return;
	}

	const gitInfo = await getGitInfo(path.dirname(test.uri.fsPath));
	if (!gitInfo) {
		console.error(`Could not get git info for ${test.uri.fsPath}`);
		test.busy = false;
		testRun.errored(test, new vscode.TestMessage('Could not determine git origin. Make sure you are in a git repository with a remote named "origin".'));
		return;
	}
	console.log(`Git info for ${test.id}:`, gitInfo);


	const { owner: organizationName, repo: vaultName } = gitInfo;

	const verificationError = await verifyVaultExists(client, organizationName, vaultName);
	if (verificationError) {
		console.error(`Vault verification failed for ${organizationName}/${vaultName}: ${verificationError}`);
		test.busy = false;
		testRun.errored(test, new vscode.TestMessage(verificationError));
		return;
	}
	console.log(`Vault verified for ${test.id}`);

	// This is a placeholder for the Foundry-specific test arguments.
	// We are setting the `match-test` argument, similar to how it was done for local runs.
	const profiles: components["schemas"]["CreateProveProfileDto"][] = [{
		profileName: 'default', // Assuming a default profile for Foundry tests
		extraProveArgs: `--match-test ${test.id}`,
		tag: "latest",
	}];


	const body: components["schemas"]["CreateJobDto"] = {
		branch: gitInfo.branch,
		kind: JobKind.foundry,
		// --- These fields are based on the Kontrol implementation and may need adjustment for Foundry ---
		kontrolVersion: "latest",
		kontrolDockerImage: "runtimeverification/kontrol:ubuntu-jammy-latest",
		kaasCliBranch: "master",
		extraBuildArgs: "", // Not yet configurable
		foundryProfile: "default",
		profiles: profiles,
		workflowBranch: "main",
		kaasServerUrl: KAAS_BASE_URL,
	};
	console.log(`Submitting job for test ${test.id} with body:`, body);
	vscode.window.showInformationMessage(`Starting KaaS job for: ${test.id}`);

	try {
		const jobResponse = await client.POST('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
			params: {
				path: {
					organizationName,
					vaultName
				}
			},
			body: body,
		});

		if (jobResponse.error) {
			console.error(`Job creation failed for ${test.id}:`, jobResponse.error);
			test.busy = false;
			testRun.errored(test, new vscode.TestMessage(`Failed to create job: ${JSON.stringify(jobResponse.error)}`));
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
