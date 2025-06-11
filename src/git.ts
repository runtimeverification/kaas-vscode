import * as vscode from 'vscode';
import { API, GitExtension, Repository, Remote } from './git-api';
import * as child_process from 'child_process';

export
function gitApi() : API {
    // Active the Git extension and get its API.
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	if (!gitExtension) {
        // The Git extension is distributed with VS Code, so it should always be available.
		throw new Error('Git extension not found. Please install the Git extension.');
	}
	const git = gitExtension.exports.getAPI(1);
	if (!git) {
        // There is currently only version 1 of the Git API available and no signs of a deprecation.
		throw new Error('Git API not available. Please ensure the Git extension is activated.');
	}
	return git;
}

export
async function getGitRepository(git: API, workspaceFolder: vscode.WorkspaceFolder): Promise<Repository | undefined> {
	const repository = git.getRepository(workspaceFolder.uri);
	return repository ?? undefined;
}

export
async function getRemoteOrigin(repository: Repository): Promise<Remote | undefined> {
	const remote = repository.state.remotes.find((r: Remote) => r.name === 'origin');
	return remote ?? undefined;
}

export
async function getRemoteBranch(repository: Repository): Promise<{ owner: string, repo: string, branch: string} | undefined> {
    const remote = await getRemoteOrigin(repository);
    if (remote && remote.pushUrl) {
        const upstream = repository.state.HEAD?.upstream;
        if (upstream) {
            const match = remote.pushUrl.match(/github\.com[/:]([\w-]+)\/([\w.-]+)(?:\.git)?/);
            if (match && match[1] && match[2]) {
                const owner = match[1];
                const repo = match[2].replace(/\.git$/, '');
                const branch = upstream.name;
                return { owner, repo, branch };
            }
        }
    }
    return undefined;
}

export
async function hasUnpushedChanges(repository: Repository): Promise<boolean> {
	const hasChanges = (repository.state.HEAD?.ahead ?? 0) > 0;
	return hasChanges;
}

export
async function hasWorkingTreeChanges(repository: Repository): Promise<boolean> {
	const hasChanges = repository.state.workingTreeChanges.length > 0;
	return hasChanges;
}

export
function getRootRepository(git: API, workspaceFolder: vscode.WorkspaceFolder): Repository | undefined {
	const repository = git.getRepository(workspaceFolder.uri);
	return repository || git.repositories.find(repo => repo.rootUri.fsPath === workspaceFolder.uri.fsPath);
}

export
async function getGithubRepoUrl(git: API, workspaceFolder: vscode.WorkspaceFolder): Promise<string | undefined> {
	const rootRepo = getRootRepository(git, workspaceFolder);

	if (!rootRepo) {
		vscode.window.showErrorMessage('No repositories found');
		return undefined;
	}

	const remote = rootRepo.state.remotes.find((r: Remote) => r.name === 'origin');
	if (remote?.fetchUrl) {
		return remote.fetchUrl;
	}

	vscode.window.showErrorMessage('No remote repository found');
	return undefined;
}


export async function getGitInfo(folderPath: string): Promise<{ owner: string; repo: string; branch: string } | undefined> {
    try {
        const getUrlCmd = 'git remote get-url origin';
        const getBranchCmd = 'git rev-parse --abbrev-ref HEAD';

        const exec = (command: string) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const process = child_process.exec(command, { cwd: folderPath });
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
                    reject(new Error(`git command failed with code ${code}: ${stderr}`));
                }
            });
        });
        
        const [urlResult, branchResult] = await Promise.all([
            exec(getUrlCmd),
            exec(getBranchCmd)
        ]);

        const remoteUrl = urlResult.stdout.trim();
        const branch = branchResult.stdout.trim();
        const match = remoteUrl.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);

        if (match && match[1] && match[2]) {
            const repoName = match[2].replace(/\.git$/, '');
            return { owner: match[1], repo: repoName, branch: branch };
        }
		vscode.window.showErrorMessage(`Could not parse git remote URL: ${remoteUrl}`);
        return undefined;
    } catch (error: any) {
        console.error('Error getting git info:', error);
		vscode.window.showErrorMessage(`Error getting git info: ${error.message}`);
        return undefined;
    }
} 
