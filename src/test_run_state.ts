import * as vscode from 'vscode';

const TEST_STATE_KEY = 'kaas-test-state';

interface TestState {
  [key: string]: string; // Maps test identifier to jobId
}

export class TestRunState {
  private state: TestState;
  private testsWithJobs = new Set<string>();

  constructor(private context: vscode.ExtensionContext) {
    this.state = this.context.workspaceState.get<TestState>(TEST_STATE_KEY, {});
    // Initialize context with existing jobs
    this.updateContext();
  }

  private getTestKey(test: vscode.TestItem): string {
    if (!test.uri) {
      // This should ideally not happen for tests we run
      return test.id;
    }
    // A composite key of file path and test id (profile name)
    return `${test.uri.fsPath}:${test.id}`;
  }

  private updateContext(): void {
    // Update the set with current tests that have jobs
    this.testsWithJobs.clear();
    for (const key in this.state) {
      if (this.state[key]) {
        this.testsWithJobs.add(key);
      }
    }
    // Update VS Code context
    vscode.commands.executeCommand(
      'setContext',
      'kaas-vscode.testsWithJobs',
      Array.from(this.testsWithJobs)
    );
  }

  public setJobId(test: vscode.TestItem, jobId: string): void {
    const key = this.getTestKey(test);
    this.state[key] = jobId;
    this.context.workspaceState.update(TEST_STATE_KEY, this.state);
    this.updateContext();
  }

  public getJobId(test: vscode.TestItem): string | undefined {
    const key = this.getTestKey(test);
    return this.state[key];
  }

  public clearJobId(test: vscode.TestItem): void {
    const key = this.getTestKey(test);
    delete this.state[key];
    this.context.workspaceState.update(TEST_STATE_KEY, this.state);
    this.updateContext();
  }
}
