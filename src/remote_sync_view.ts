import { link } from 'fs';
import * as vscode from 'vscode';
import { getGitRepository, getRemoteOrigin, gitApi, hasWorkingTreeChanges } from './git';
import { Repository } from './git-api';

export
async function createRemoteSyncView(context: vscode.ExtensionContext): Promise<vscode.TreeView<vscode.TreeItem>> {
    const view = vscode.window.createTreeView('kaas-vscode.remote-sync-view', {
        treeDataProvider: new RemoteSyncDataProvider(),
        showCollapseAll: true,
    });

    view.message = 'Ensure your changes are synced with GitHub before starting a proof.';

    vscode.commands.registerCommand('kaas-vscode.refreshEntry', () => {
        vscode.window.showInformationMessage('Refreshing Remote Sync View');
    });
    vscode.commands.registerCommand('kaas-vscode.addEntry', () => {
        vscode.window.showInformationMessage('Adding Entry to Remote Sync View');
    });

        
    return view;
}

class RemoteSyncDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            // Return root items
            return Promise.resolve(this.getRootItems());
        }
        // Return children of the given element
        return Promise.resolve([]);
    }

    private getRootItems(): vscode.TreeItem[] {
        const git = gitApi();
        const rootItems = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        for (const workspaceFolder of workspaceFolders || []) {
            const childItems = this.getWorkspaceFolderItems(workspaceFolder);
            const workspaceItem = new WorkspaceFolderItem(workspaceFolder, childItems);
            rootItems.push(workspaceItem);
        }
        return rootItems;
    }

    private getWorkspaceFolderItems(workspaceFolder: vscode.WorkspaceFolder): vscode.TreeItem[] {
        const childItems = [];
        const git = gitApi();
        let repo : Repository | undefined;
        childItems.push(new RemoteSyncItem(
            'git-init',
            'passed',
            'Your workspace folder is a Git repository.',
            'Your workspace folder is not a Git repository. Please initialize it.',
            async () => {
                repo = await getGitRepository(git, workspaceFolder);
                return repo ? 'passed' : 'failed';
            }
        ));

        if (!repo) {
            return childItems;
        }
        
        childItems.push(new RemoteSyncItem(
            'git-commit',
            'passed',
            'You have no local changes in your worktree.',
            'You have local changes in your worktree.',
            async () => {
                const repo = await getGitRepository(git, workspaceFolder);
                if (!repo) {
                    return 'failed';
                }
                const hasChanges = await hasWorkingTreeChanges(repo);
                return hasChanges ? 'warning' : 'passed';
            }
        ));

        childItems.push(new RemoteSyncItem(
            'git-publish',
            'passed',
            'Your remote origin points to a GitHub repository.',
            'Your remote origin does not point to a GitHub repository.',
            async () => {
                const repo = await getGitRepository(git, workspaceFolder);
                if (!repo) {
                    return 'failed';
                }
                const remote = await getRemoteOrigin(repo);
                return remote ? 'passed' : 'warning';
            }
        ));

        childItems.push(new RemoteSyncItem(
            'git-tracking',
            'passed',
            'Your branch is tracking a remote branch.',
            'Your branch is not tracking a remote branch.',
            async () => {
                return 'failed'; // TODO
            }
        ));

        childItems.push(new RemoteSyncItem(
            'kaas-unlinked',
            'warning',
            'Your repository is linked to a Kaas vault.',
            'Your repository is not linked to a Kaas vault.',
            async () => {
                return 'failed'; // TODO
            }
        ));

        childItems.push(new RemoteSyncItem(
            'git-unpushed',
            'failed',
            'You don\'t have any unpushed commits.',
            'You have unpushed commits. Please push them to GitHub.',
            async () => {
                return 'failed'; // TODO
            }
        ));

        return childItems;
    }
}

class WorkspaceFolderItem extends vscode.TreeItem {
    constructor(
        private workspaceFolder: vscode.WorkspaceFolder,
        private children: vscode.TreeItem[] = []
    ) {
        super(workspaceFolder.name, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'workspaceFolder';
        this.iconPath = new vscode.ThemeIcon('folder');
    }
}

class RemoteSyncItem extends vscode.TreeItem {
    constructor(
        contextValue: string,
        private state: 'passed' | 'warning' | 'failed',
        private descriptionPassed: string,
        private descriptionFailed: string,
        private update: () => Promise<'passed' | 'warning' | 'failed'>
    ) {
        const label = state === 'passed' ? descriptionPassed : descriptionFailed;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = contextValue;
        this.updateDescription();
        this.updateIcon();
    }

    private setState(state: 'passed' | 'warning' | 'failed') {
        this.state = state;
        this.updateDescription();
        this.updateIcon();
    }

    private updateDescription() {
        this.label = this.state === 'passed' ? this.descriptionPassed : this.descriptionFailed;
    }
    
    private updateIcon() {
        if (this.state === 'failed') {
            this.iconPath = new vscode.ThemeIcon('close', { id: 'testing.iconFailed' });
        } else if (this.state === 'warning') {
            this.iconPath = new vscode.ThemeIcon('warning', { id: 'editorWarning.foreground' });
        } else {
            this.iconPath = new vscode.ThemeIcon('check', { id: 'testing.iconPassed' });
        }
    }
}