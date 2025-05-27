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

	const orgs = await client.orgs();
	for (const org of orgs) {
		const orgItem = testController.createTestItem(org.name, org.name);
		const orgName = org.name;
		const jobs = await client.jobs(orgName);
		for (const job of jobs) {
			const jobItem = testController.createTestItem(job.id, job.id);
			orgItem.children.add(jobItem);
		}
		testController.items.add(orgItem);
	}

}

type Org = {
	id: string;
	name: string;
}

type Job = {
	id: string;
	status: string;
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
