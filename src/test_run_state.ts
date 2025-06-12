import * as vscode from 'vscode';

const TEST_STATE_KEY = 'kaas-test-state';

interface TestState {
    [key: string]: string; // Maps test identifier to jobId
}

export class TestRunState {
    private state: TestState;

    constructor(private context: vscode.ExtensionContext) {
        this.state = this.context.workspaceState.get<TestState>(TEST_STATE_KEY, {});
    }

    private getTestKey(test: vscode.TestItem): string {
        if (!test.uri) {
            // This should ideally not happen for tests we run
            return test.id;
        }
        // A composite key of file path and test id (profile name)
        return `${test.uri.fsPath}:${test.id}`;
    }

    public setJobId(test: vscode.TestItem, jobId: string): void {
        const key = this.getTestKey(test);
        this.state[key] = jobId;
        this.context.workspaceState.update(TEST_STATE_KEY, this.state);
    }

    public getJobId(test: vscode.TestItem): string | undefined {
        const key = this.getTestKey(test);
        return this.state[key];
    }
} 