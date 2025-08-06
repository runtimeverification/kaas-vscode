import gitUrlParse from 'git-url-parse';
import * as vscode from 'vscode';
import { API, GitExtension, Remote, Repository } from './git-api';

export interface GitInfo {
  owner: string;
  repo: string;
  branch: string;
}

export function gitApi(): API {
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

export async function getGitRepository(
  git: API,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<Repository | undefined> {
  let repository = git.getRepository(workspaceFolder.uri);

  // If no repository found, try to wait a bit and check again
  if (!repository) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    repository = git.getRepository(workspaceFolder.uri);
  }

  // Also try to find it in the repositories list
  if (!repository) {
    const foundRepo = git.repositories.find(
      repo => repo.rootUri.fsPath === workspaceFolder.uri.fsPath
    );
    repository = foundRepo || null;
  }

  return repository ?? undefined;
}

export async function getRemoteOrigin(repository: Repository): Promise<Remote | undefined> {
  // If no remotes found, wait a bit for Git to load them
  if (repository.state.remotes.length === 0) {
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const remote = repository.state.remotes.find((r: Remote) => r.name === 'origin');
  return remote ?? undefined;
}

export async function getRemoteBranch(repository: Repository): Promise<GitInfo | undefined> {
  const remote = await getRemoteOrigin(repository);

  if (remote && remote.pushUrl) {
    const upstream = repository.state.HEAD?.upstream;

    try {
      const parsed = gitUrlParse(remote.pushUrl);

      // Check if it's a GitHub repository
      if (parsed.source === 'github.com' || parsed.resource.includes('github')) {
        const owner = parsed.owner;
        const repo = parsed.name;

        if (owner && repo) {
          let branch: string;

          if (upstream) {
            branch = upstream.name;
          } else if (repository.state.HEAD?.name) {
            branch = repository.state.HEAD.name;
          } else {
            return undefined;
          }

          return { owner, repo, branch };
        }
      }
    } catch (error) {
      // Failed to parse git URL
    }
  }

  return undefined;
}

export async function hasUnpushedChanges(repository: Repository): Promise<boolean> {
  const hasChanges = (repository.state.HEAD?.ahead ?? 0) > 0;
  return hasChanges;
}

export async function hasWorkingTreeChanges(repository: Repository): Promise<boolean> {
  const hasChanges = repository.state.workingTreeChanges.length > 0;
  return hasChanges;
}

export function getRootRepository(
  git: API,
  workspaceFolder: vscode.WorkspaceFolder
): Repository | undefined {
  const repository = git.getRepository(workspaceFolder.uri);
  return (
    repository || git.repositories.find(repo => repo.rootUri.fsPath === workspaceFolder.uri.fsPath)
  );
}

export async function getGithubRepoUrl(
  git: API,
  workspaceFolder: vscode.WorkspaceFolder
): Promise<string | undefined> {
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

export async function getGitInfo(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<GitInfo | undefined> {
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
      branch: remoteBranch.branch,
    };
  } catch (error: any) {
    console.error('Error getting git info:', error);
    vscode.window.showErrorMessage(`Error getting git info: ${error.message}`);
    return undefined;
  }
}
