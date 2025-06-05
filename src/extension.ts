import * as vscode from 'vscode';
import createClient, { Client } from "openapi-fetch";
import { JobKind, JobStatus, type components, type paths } from "./kaas-api";

const KAAS_BASE_URL = 'https://kaas.runtimeverification.com/';
const KAAS_JOB_POLL_INTERVAL = 5000; // Polling interval for job status updates in milliseconds

// Initialize smol-toml
let parse: any;
let stringify: any;

// Create output channel for logging
let outputChannel: vscode.OutputChannel;

async function initializeSmolToml() {
	try {
		const smolToml = await import('smol-toml');
		parse = smolToml.parse;
		stringify = smolToml.stringify;
		outputChannel.appendLine('Successfully initialized smol-toml');
	} catch (error) {
		outputChannel.appendLine(`Failed to initialize smol-toml: ${error}`);
		throw error;
	}
}

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

export async function activate(context: vscode.ExtensionContext) {
	// Create output channel
	outputChannel = vscode.window.createOutputChannel('KaaS Extension');
	outputChannel.show();
	outputChannel.appendLine('KaaS Extension activating...');

	try {
		// Initialize smol-toml first
		await initializeSmolToml();
		
		outputChannel.appendLine('Extension initialization complete');

		const testController = vscode.tests.createTestController('kaas-vscode.testController', 'KaaS Proofs');
		const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
		if (!apiKey) {
			throw new Error('No API key found in settings. Please configure kaas-vscode.apiKey');
		}
		outputChannel.appendLine('API key found in settings');

		const client = createClient<paths>({ baseUrl: KAAS_BASE_URL, headers: { 'Authorization': `Bearer ${apiKey}` } });
		outputChannel.appendLine('API client initialized');

		context.subscriptions.push(
			vscode.commands.registerCommand('kaas-vscode.helloWorld', () => {
				vscode.window.showInformationMessage('Hello World from K as a Service!');
			})
		);

		testController.refreshHandler = async () => {
			outputChannel.appendLine('Refreshing test items...');
			testController.items.replace([]);
			await kontrolProfiles(client, testController);
			outputChannel.appendLine('Test items refreshed');
		};

		await kontrolProfiles(client, testController);
		outputChannel.appendLine('Initial test items loaded');

		const testRunProfile = testController.createRunProfile(
			'Run All',
			vscode.TestRunProfileKind.Run,
			runTest.bind(null, client, testController),
			true
		);
		outputChannel.appendLine('Test run profile created');

		// Add command to show logs
		context.subscriptions.push(
			vscode.commands.registerCommand('kaas-vscode.showLogs', () => {
				outputChannel.show();
			})
		);

		outputChannel.appendLine('KaaS Extension activation complete');
	} catch (error) {
		outputChannel.appendLine(`Error during activation: ${error}`);
		throw error;
	}
}

async function kontrolProfiles(
	client: Client<paths>,
	testController: vscode.TestController
) : Promise<void> {
	if (!parse) {
		throw new Error('smol-toml not initialized');
	}
	
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		for (const folder of workspaceFolders) {
			// Does the folder contain a kontrol.toml file?
			const kontrolTomlPath = vscode.Uri.joinPath(folder.uri, 'kontrol.toml');
			try {
				const kontrolTomlExists = await vscode.workspace.fs.stat(kontrolTomlPath);
				if (kontrolTomlExists) {
					// Create a test item for the folder
					const folderItem = testController.createTestItem(folder.name, folder.name, folder.uri);
					testController.items.add(folderItem);

					// If it exists, parse the file
					const kontrolTomlContent = await vscode.workspace.fs.readFile(kontrolTomlPath);
					const kontrolToml = parse(kontrolTomlContent.toString()) as KontrolToml;
					// Create a test item for each profile in the kontrol.toml
					const proveProfiles = Object.entries(kontrolToml.prove);
					for (const [profileName, profile] of proveProfiles) {
						const testName = profile['match-test'];
						const testItem = testController.createTestItem(profileName, testName, kontrolTomlPath);
						folderItem.children.add(testItem);
					}
				}
			} catch (error) {
				console.error(`Error reading kontrol.toml in ${folder.uri.fsPath}:`, error);
			}
		}
	}
	return;
}

async function runTest(
	client: Client<paths>,
	testController: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken
) : Promise<void> {
	outputChannel.appendLine('Starting test run...');
	const testRun = testController.createTestRun(request);
	
	for (const test of request.include ?? []) {
		outputChannel.appendLine(`Processing test: ${test.id}`);
		test.busy = true; // Mark the test as busy
		const profileName = test.id;
		const parent = test.parent;
		if (!parent) {
			outputChannel.appendLine(`Test ${test.id} has no parent, skipping`);
			continue;
		}

		// Get current git info
		outputChannel.appendLine('Getting git repository info...');
		const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
		const git = gitExtension?.getAPI(1);
		const repo = git?.repositories[0];
		if (!repo) {
			const error = 'No git repository found. Please initialize git in your workspace.';
			outputChannel.appendLine(error);
			vscode.window.showErrorMessage(error);
			continue;
		}

		// Get current branch and commit
		const currentBranch = repo.state.HEAD?.name;
		const currentCommit = repo.state.HEAD?.commit;
		if (currentBranch === undefined && currentCommit === undefined) {
			const error = 'Could not determine current branch or commit. Please ensure you are on a valid branch.';
			outputChannel.appendLine(error);
			vscode.window.showErrorMessage(error);
			continue;
		}
		outputChannel.appendLine(`Current branch: ${currentBranch}, commit: ${currentCommit}`);

		// Check if repo is dirty
		if (repo.state.workingTreeChanges.length > 0) {
			outputChannel.appendLine('Repository has uncommitted changes');
			const result = await vscode.window.showWarningMessage(
				'Your repository has uncommitted changes. KaaS will run against the latest commit on the current branch. Do you want to continue?',
				'Yes',
				'No'
			);
			if (result !== 'Yes') {
				outputChannel.appendLine('User chose not to continue with dirty repository');
				continue;
			}
		}

		// Get organization and vault info from git remote
		let organizationName = '';
		let vaultName = '';
		try {
			outputChannel.appendLine('Getting git remote info...');
			const remotes = repo.state.remotes;
			if (!remotes || remotes.length === 0) {
				const error = 'No git remotes found. Please add a remote to your repository.';
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			const origin = remotes.find((r: { name: string; fetchUrl?: string; pushUrl?: string }) => r.name === 'origin');
			if (!origin) {
				const error = 'No origin remote found. Please add an origin remote to your repository.';
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			const url = origin.fetchUrl || origin.pushUrl;
			if (!url) {
				const error = 'Could not determine repository URL from git remote.';
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			outputChannel.appendLine(`Found remote URL: ${url}`);

			// Parse URL to get organization and repository name
			const match = url.match(/(?:github\.com[:/]|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/);
			if (!match) {
				const error = 'Could not parse repository URL. Please ensure it is a valid GitHub URL.';
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			organizationName = match[1];
			vaultName = match[2];
			outputChannel.appendLine(`Parsed organization: ${organizationName}, vault: ${vaultName}`);

			// Check if vault exists in KaaS
			outputChannel.appendLine('Checking if vault exists in KaaS...');
			const vaultResponse = await client.GET('/api/orgs/{organizationName}/vaults/{vaultName}', {
				params: {
					path: {
						organizationName,
						vaultName
					}
				}
			});
			if (vaultResponse.response.status === 404) {
				const error = `Vault ${vaultName} does not exist in KaaS. Please create it first.`;
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			} else if (vaultResponse.response.status !== 200) {
				const error = `Failed to check vault existence: ${vaultResponse.response.statusText}`;
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			outputChannel.appendLine('Vault exists in KaaS');
		} catch (error) {
			const errorMsg = `Error getting repository info: ${error}`;
			outputChannel.appendLine(errorMsg);
			vscode.window.showErrorMessage(errorMsg);
			continue;
		}

		// Read kontrol.toml to get number of profiles
		let kontrolTomlProfiles = 1;
		try {
			if (!parent.uri) {
				throw new Error('Test item has no URI');
			}
			outputChannel.appendLine('Reading kontrol.toml...');
			const kontrolTomlPath = vscode.Uri.joinPath(parent.uri, 'kontrol.toml');
			const kontrolTomlContent = await vscode.workspace.fs.readFile(kontrolTomlPath);
			const kontrolToml = parse(kontrolTomlContent.toString()) as KontrolToml;
			kontrolTomlProfiles = Object.keys(kontrolToml.prove || {}).length;
			outputChannel.appendLine(`Found ${kontrolTomlProfiles} profiles in kontrol.toml`);
		} catch (error) {
			outputChannel.appendLine(`Error reading kontrol.toml: ${error}`);
			console.error('Error reading kontrol.toml:', error);
		}

		try {
			outputChannel.appendLine('Creating job in KaaS...');
			const jobResponse = await client.POST('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
				params: {
					path: {
						organizationName,
						vaultName
					}
				},
				body: {
					"kind": JobKind.kontrol,
					"branch": currentBranch,
					"workflowBranch": "",
					"kaasServerUrl": "",
					"extraBuildArgs": "",
					"kontrolVersion": "",
					"kontrolDockerImage": "",
					"kaasCliBranch": "",
					"kaasTestRoot": ".",
					"commitSha": currentCommit,
					"foundryProfile": profileName,
					"profiles": [
						{
							"profileName": profileName,
							"extraProveArgs": "",
							"tag": "default"
						}
					],
					"kontrolTomlProfiles": kontrolTomlProfiles,
					"executionTimeout": 480,
					"regenMode": false,
					"rekompile": false,
					"debugMode": false,
					"disableCache": false,
					"extraTestArgs": ""
				}
			});

			if (jobResponse.response.status !== 201) {
				const error = `Failed to create job: ${jobResponse.response.statusText}`;
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}

			const job = jobResponse.data;
			if (job === undefined) {
				const error = 'Job creation returned no data';
				outputChannel.appendLine(error);
				vscode.window.showErrorMessage(error);
				continue;
			}
			outputChannel.appendLine(`Job created successfully with ID: ${job.jobId}`);

			outputChannel.appendLine('Polling for job status...');
			while (true) {
				await new Promise(resolve => setTimeout(resolve, KAAS_JOB_POLL_INTERVAL));
				try {
					const jobDetails = await getJobStatusByJobId(client, job.jobId);
					if (jobDetails === undefined) {
						const error = `Job with ID ${job.jobId} not found`;
						outputChannel.appendLine(error);
						vscode.window.showErrorMessage(error);
						break;
					}
					outputChannel.appendLine(`Job status: ${jobDetails.status}`);
					
					if (jobDetails.status === JobStatus.success) {
						test.busy = false;
						testRun.passed(test, jobDetails.duration * 1000);
						outputChannel.appendLine('Job completed successfully');
						break;
					}
					if (jobDetails.status === JobStatus.cancelled) {
						test.busy = false;
						testRun.errored(test, new vscode.TestMessage(`Job ${jobDetails.id} was cancelled`), jobDetails.duration * 1000);
						outputChannel.appendLine('Job was cancelled');
						break;
					}
					if (jobDetails.status === JobStatus.failure || jobDetails.status === JobStatus.processing_failed) {
						test.busy = false;
						testRun.failed(test, new vscode.TestMessage(`Job ${jobDetails.id} failed`), jobDetails.duration * 1000);
						outputChannel.appendLine('Job failed');
						break;
					}
				} catch (error) {
					outputChannel.appendLine(`Error fetching job status: ${error}`);
					vscode.window.showErrorMessage(`Error fetching job status: ${error}`);
					continue;
				}
			}
		} catch (error) {
			outputChannel.appendLine(`Error during job execution: ${error}`);
			vscode.window.showErrorMessage(`Error during job execution: ${error}`);
			continue;
		}
	}
	outputChannel.appendLine('Test run completed');
	testRun.end();
}

async function fetchLatestRun(
	client: Client<paths>,
	testController: vscode.TestController,
	organizationName: string,
	vaultName: string,
	profileName: string,
	testItem: vscode.TestItem
): Promise<void> {
	let job : components["schemas"]["IJob"] | undefined;
	try {
		job = await getLatestJobStatusFor(client, organizationName, vaultName, profileName);
	} catch (error) {
		return;
	}
	if (job === undefined) {
		return;
	}
	const testRun = testController.createTestRun(new vscode.TestRunRequest([testItem], []));
	if (job.status === JobStatus.success) {
		testRun.passed(testItem, job.duration * 1000);
	} else if (job.status === JobStatus.cancelled) {
		testRun.errored(testItem, new vscode.TestMessage(`Job ${job.id} was cancelled`), job.duration * 1000);
	} else if (job.status === JobStatus.failure || job.status === JobStatus.processing_failed) {
		testRun.failed(testItem, new vscode.TestMessage(`Job ${job.id} failed`), job.duration * 1000);
	} else if (job.status === JobStatus.pending || job.status === JobStatus.running) {
		testRun.enqueued(testItem);
		// Todo: Keep polling for job status
	}
	testRun.end();

}

async function getJobStatusByJobId(client: Client<paths>, jobId: string): Promise<components["schemas"]["IJob"]> {
	const job = await client.GET('/api/jobs/{jobId}', {
		params: {
			path: {
				jobId
			}
		}
	});
	if (job.response.status !== 200) {
		throw new Error(`Job with ID ${jobId} not found`);
	}
	if (job.data === undefined) {
		throw new Error(`Job with ID ${jobId} returned no data`);
	}
	return job.data;
}

async function getLatestJobStatusFor(client: Client<paths>, organizationName: string, vaultName: string, profileName: string): Promise<components["schemas"]["IJob"]> {
	
	const job = await client.GET('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
		params: {
			path: {
				organizationName,
				vaultName
			},
			query: {
				profile: profileName, // TODO: Look like the endpoint filtering does not work
				page: 1,
				per_page: 1
			}
		}
	});
	if (job.response.status !== 200) {
		throw new Error(`Failed to fetch jobs for organization ${organizationName} and vault ${vaultName}: ${job.response.statusText}`);
	}
	if (job.data === undefined) {
		throw new Error(`No jobs found for organization ${organizationName} and vault ${vaultName}`);
	}
	for (const jobItem of job.data) {
		return jobItem;
	}
	throw new Error(`No jobs found for profile ${profileName} in organization ${organizationName} and vault ${vaultName}`);
}

export function deactivate() {}
