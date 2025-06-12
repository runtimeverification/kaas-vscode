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


export async function getGitInfo(workspaceFolder: vscode.WorkspaceFolder): Promise<{ owner: string; repo: string; branch: string } | undefined> {
    try {
        const git = gitApi();
        const repository = await getGitRepository(git, workspaceFolder);
        if (!repository) {
            vscode.window.showErrorMessage('No Git repository found in the current workspace.');
            return undefined;
        }

        const remote = await getRemoteOrigin(repository);
        if (!remote) {
            vscode.window.showErrorMessage('No remote named "origin" found in the Git repository.');
            return undefined;
        }

        const remoteBranch = await getRemoteBranch(repository);
        if (!remoteBranch) {
            vscode.window.showErrorMessage('No remote branch found for the current Git repository.');
            return undefined;
        }

        return {
            owner: remoteBranch.owner,
            repo: remoteBranch.repo,
            branch: remoteBranch.branch
        };
    } catch (error: any) {
        console.error('Error getting git info:', error);
		vscode.window.showErrorMessage(`Error getting git info: ${error.message}`);
        return undefined;
    }
} 
