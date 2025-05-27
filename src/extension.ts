import * as vscode from 'vscode';
import { parse, stringify } from 'smol-toml'
import createClient, { Client } from "openapi-fetch";
import { JobKind, JobStatus, type components, type paths } from "./kaas-api";
import { ClientRequest } from 'http';

const KAAS_BASE_URL = 'https://kaas.runtimeverification.com/';
const KAAS_JOB_POLL_INTERVAL = 5000; // Polling interval for job status updates in milliseconds

export async function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "kaas-vscode" is now active!');

	const testController = vscode.tests.createTestController('kaas-vscode.testController', 'KaaS Proofs');
	const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
	const client = createClient<paths>({ baseUrl: KAAS_BASE_URL, headers: { 'Authorization': `Bearer ${apiKey}` } });

	context.subscriptions.push(
		vscode.commands.registerCommand('kaas-vscode.helloWorld', () => {
			vscode.window.showInformationMessage('Hello World from K as a Service!');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('kaas-vscode.refreshComputeJobs', async () => {
			testController.items.replace([]);
			await fetchComputeJobs(client, testController);
		})
	);

	testController.refreshHandler = async () => {
		testController.items.replace([]);
		await fetchComputeJobs(client, testController);
	};

	await kontrolProfiles(client, testController);
	await fetchComputeJobs(client, testController);


	const testRunProfile = testController.createRunProfile(
		'Run All',
		vscode.TestRunProfileKind.Run,
		runTest.bind(null, client, testController),
		true
	);
	
}

async function kontrolProfiles(
	client: Client<paths>,
	testController: vscode.TestController
) : Promise<void> {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		const queue : Promise<void>[] = [];
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
					const kontrolToml = parse(kontrolTomlContent.toString());
					// Create a test item for each profile in the kontrol.toml
					const proveProfiles = Object.entries(kontrolToml.prove);
					for (const [profileName, profile] of proveProfiles) {
						const testName = profile['match-test'];
						const testItem = testController.createTestItem(profileName, testName, kontrolTomlPath);
						folderItem.children.add(testItem);
						queue.push(fetchLatestRun(
							client,
							testController,
							'runtimeverification',
							'audit-kontrol-template',
							profileName,
							testItem
						));
					}
				}
			} catch (error) {
				console.error(`Error reading kontrol.toml in ${folder.uri.fsPath}:`, error);
			}
		}
		await Promise.all(queue);
	}
	return;
}

async function runTest(
	client: Client<paths>,
	testController: vscode.TestController,
	request: vscode.TestRunRequest,
	token: vscode.CancellationToken
) : Promise<void> {
	const testRun = testController.createTestRun(request);
	for (const test of request.include ?? []) {
		test.busy = true; // Mark the test as busy
		const profileName = test.id;
		const parent = test.parent;
		if (!parent) {
			continue;
		}
		const organizationName = 'runtimeverification'; // This should be dynamically determined based on the test item
		const vaultName = 'audit-kontrol-template'; // This should also be dynamically determined based on the test item
		const jobResponse = await client.POST('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
			params: {
				path: {
					organizationName,
					vaultName
				}
			},
			body: {
				"kind": JobKind.kontrol,
				"branch": "master",
				"workflowBranch": "",
				"kaasServerUrl": "",
				"extraBuildArgs": "",
				"kontrolVersion": "",
				"kontrolDockerImage": "",
				"kaasCliBranch": "",
				"kaasTestRoot": ".",
				"commitSha": "",
				"foundryProfile": "default",
				"profiles": [
					{
						"profileName": profileName,
						"extraProveArgs": "",
						"tag": "default"
					}
				],
				"kontrolTomlProfiles": 2,
				"executionTimeout": 480,
				"regenMode": false,
				"rekompile": false,
				"debugMode": false,
				"disableCache": false,
				"extraTestArgs": ""
			}
		});
		if (jobResponse.response.status !== 201) {
			vscode.window.showErrorMessage(`Failed to create job: ${jobResponse.response.statusText}`);
			continue;
		}
		const job = jobResponse.data;
		if (job === undefined) {
			vscode.window.showErrorMessage(`Job creation returned no data`);
			continue;
		}
		while (true) {
			await new Promise(resolve => setTimeout(resolve, KAAS_JOB_POLL_INTERVAL));
			try {
				const jobDetails = await getJobStatusByJobId(client, job.jobId);
				if (jobDetails === undefined) {
					vscode.window.showErrorMessage(`Job with ID ${job.jobId} not found`);
					break;
				}
				if (jobDetails.status === JobStatus.success) {
					test.busy = false;
					testRun.passed(test, jobDetails.duration * 1000);
					break;
				}
				if (jobDetails.status === JobStatus.cancelled) {
					test.busy = false;
					testRun.errored(test, new vscode.TestMessage(`Job ${jobDetails.id} was cancelled`), jobDetails.duration * 1000);
					break;
				}
				if (jobDetails.status === JobStatus.failure || jobDetails.status === JobStatus.processing_failed) {
					test.busy = false;
					testRun.failed(test, new vscode.TestMessage(`Job ${jobDetails.id} failed`), jobDetails.duration * 1000);
					break;
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Error fetching job status: ${error}`);
				continue;
			}
		}
	}
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

async function fetchComputeJobs(client: Client<paths>, testController: vscode.TestController) {
	const allJobs: [components["schemas"]["IJob"], vscode.TestItem][] = []; // List of all discovered computed jobs

	const orgsResponse = await client.GET('/api/orgs');
	const orgs = orgsResponse.data ?? [];
	for (const org of orgs) {
		const orgItem = testController.createTestItem(org.name, org.name);
		const orgName = org.name;
		const jobsResponse = await client.GET('/api/orgs/{organizationName}/jobs', {
			params: { path: { organizationName: orgName }, query: { page: 1, per_page: 10 } },	
		});
		const jobs = jobsResponse.data ?? [];
		for (const job of jobs) {
			const name = jobName(job);
			const jobItem = testController.createTestItem(job.id, name, jobUri(job));
			allJobs.push([job, jobItem]);
			orgItem.children.add(jobItem);
		}
		testController.items.add(orgItem);
	}
	const testRunRequest = new vscode.TestRunRequest(allJobs.map(([_, item]) => item), []);
	const testRun = testController.createTestRun(testRunRequest);

	for (const [job, testItem] of allJobs) {
		if (job.status === 'success') {
			testRun.passed(testItem, job.duration * 1000);
		} else if (job.status === 'cancelled') {
			testRun.errored(testItem, new vscode.TestMessage(`Job ${jobName(job)} was cancelled`), job.duration * 1000);
		} else {
			testRun.failed(testItem, new vscode.TestMessage(`Job ${jobName(job)} failed`), job.duration * 1000);
		}
	}
	testRun.end();
}

function jobName(job: components["schemas"]["IJob"]): string {
	return `${job.kind}/${job.type}/${job.repo}`;
}

function jobUri(job: components["schemas"]["IJob"]) : vscode.Uri {
	return vscode.Uri.parse(`${KAAS_BASE_URL}/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}`);
}

export function deactivate() {}
