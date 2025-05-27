import * as vscode from 'vscode';
export async function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "kaas-vscode" is now active!');

	context.subscriptions.push(
		vscode.commands.registerCommand('kaas-vscode.helloWorld', () => {
			vscode.window.showInformationMessage('Hello World from K as a Service!');
		})
	);

	const testController = vscode.tests.createTestController('kaas-vscode.testController', 'KaaS Proofs');
	
	const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
	const client = new KaaSClient(apiKey || '');


	await fetchComputeJobs(client, testController);
}

type Org = {
	id: string;
	name: string;
}

type Job = {
	id: string;
	status: string;
	repo: string;
	kind: string; // e.g. "kontrol"
	type: string; // e.g. "build", "prove"
	duration: number; // in seconds
	organizationName: string;
	vaultName: string;
}

async function fetchComputeJobs(client: KaaSClient, testController: vscode.TestController) {
	const allJobs: [Job, vscode.TestItem][] = []; // List of all discovered computed jobs

	const orgs = await client.orgs();
	for (const org of orgs) {
		const orgItem = testController.createTestItem(org.name, org.name);
		const orgName = org.name;
		const jobs = await client.jobs(orgName);
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
			testRun.passed(testItem, job.duration);
		} else if (job.status === 'cancelled') {
			testRun.errored(testItem, new vscode.TestMessage(`Job ${jobName(job)} was cancelled`), job.duration);
		} else {
			testRun.failed(testItem, new vscode.TestMessage(`Job ${jobName(job)} failed`), job.duration);
		}
	}
	testRun.end();
}

function jobName(job: Job): string {
	return `${job.kind}/${job.type}/${job.repo}`;
}

function jobUri(job: Job) : vscode.Uri {
	return vscode.Uri.parse(`https://kaas.runtimeverification.com/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}`);
}

class KaaSClient {

	baseUrl: string = 'https://kaas.runtimeverification.com/api';

	constructor(private apiKey: string) {
	}

	async orgs() : Promise<Org[]> {
		const response = await fetch(`${this.baseUrl}/orgs`, {
			headers: {
				'Authorization': `Bearer ${this.apiKey}`
			}
		});
		if (!response.ok) {
			throw new Error(`Error fetching orgs: ${response.statusText}`);
		}
		return await response.json() as Org[];
	}

	async jobs(orgName: string) : Promise<Job[]> {
		const response = await fetch(`${this.baseUrl}/orgs/${orgName}/jobs?page=1&per_page=10`, {
			headers: {
				'Authorization': `Bearer ${this.apiKey}`
			},
		});
		if (!response.ok) {
			throw new Error(`Error fetching jobs for org ${orgName}: ${response.statusText}`);
		}
		return await response.json() as Job[];
	}

}

export function deactivate() {}
