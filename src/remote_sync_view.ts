import * as vscode from 'vscode';
import { getGitRepository, getRemoteBranch, getRemoteOrigin, gitApi, hasUnpushedChanges, hasWorkingTreeChanges } from './git';
import { verifyVaultExists } from './kaas_vault';
import { Client } from 'openapi-fetch';
import { paths } from './kaas-api';

export
async function createRemoteSyncView(context: vscode.ExtensionContext, client: Client<paths>): Promise<vscode.TreeView<vscode.TreeItem>> {
    const treeDataProvider = new RemoteSyncDataProvider(client);
    const view = vscode.window.createTreeView('kaas-vscode.remote-sync-view', {
        treeDataProvider
    });

    view.message = 'Ensure your changes are synced with GitHub before starting a proof.';

    vscode.commands.registerCommand('kaas-vscode.refreshSyncView', () => {
        treeDataProvider.update();
    });

        
    return view;
}

class RemoteSyncDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined> = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined> = this._onDidChangeTreeData.event;

    constructor(private client: Client<paths>) {
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            // Return root items
            return Promise.resolve(this.getRootItems());
        }
        // Return children of the given element
        if (element instanceof WorkspaceFolderItem) {
            return element.children();
        }
        return Promise.resolve([]);
    }

    update() : void {
        this._onDidChangeTreeData.fire(undefined);
    }

    private getRootItems(): vscode.TreeItem[] {
        const rootItems = [];
        const workspaceFolders = vscode.workspace.workspaceFolders;
        for (const workspaceFolder of workspaceFolders || []) {
            const workspaceItem = new WorkspaceFolderItem(this.client, workspaceFolder);
            rootItems.push(workspaceItem);
        }
        return rootItems;
    }
}


type GitState = 'NoGit' | 'NoRemote' | 'NoRemoteBranch' | { workingTreeChanges: boolean, unpushedChanges: boolean };
type KaasState = 'InvalidKaasToken' | 'ValidKaasToken' | 'NoVault' | 'Connected';
type SyncState = { git: GitState, kaas?: KaasState }


class WorkspaceFolderItem extends vscode.TreeItem {

    private gitInitItem: RemoteSyncItem;
    private kaasToken: RemoteSyncItem;
    private remoteOriginItem: RemoteSyncItem;
    private remoteBranchItem: RemoteSyncItem;
    private vaultItem: RemoteSyncItem;
    private workingTreeItem: RemoteSyncItem;
    private unpushedChangesItem: RemoteSyncItem;


    constructor(
        private client: Client<paths>,
        private workspaceFolder: vscode.WorkspaceFolder,
    ) {
        super(workspaceFolder.name, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'workspaceFolder';
        this.iconPath = new vscode.ThemeIcon('folder');

        this.gitInitItem = new RemoteSyncItem(
            'git-init',
            'passed',
            'Your workspace folder is a Git repository.',
            'Your workspace folder is not a Git repository. Please initialize it.',
        );

        this.kaasToken = new RemoteSyncItem(
            'kaas-token',
            'passed',
            'You have a valid KaaS API token.',
            'You do not have a valid KaaS API token.',
        );
        
        this.workingTreeItem = new RemoteSyncItem(
            'git-commit',
            'passed',
            'You have no local changes in your worktree.',
            'You have local changes in your worktree.',
        );

        this.remoteOriginItem = new RemoteSyncItem(
            'git-publish',
            'passed',
            'Your remote origin points to a GitHub repository.',
            'Your remote origin does not point to a GitHub repository.',
        );

        this.remoteBranchItem = new RemoteSyncItem(
            'git-tracking',
            'passed',
            'Your branch is tracking a remote branch.',
            'Your branch is not tracking a remote branch.',
        );

        this.vaultItem = new RemoteSyncItem(
            'kaas-unlinked',
            'warning',
            'Your repository is linked to a Kaas vault.',
            'Your repository is not linked to a Kaas vault.',
        );

        this.unpushedChangesItem = new RemoteSyncItem(
            'git-unpushed',
            'failed',
            'You don\'t have any unpushed commits.',
            'You have unpushed commits. Please push them to GitHub.',
        );
    }

    async children(): Promise<RemoteSyncItem[]> {
        const children = [this.gitInitItem, this.kaasToken];
        const {git, kaas} = await this.checkSyncState();

        if (kaas === 'InvalidKaasToken') {
            this.kaasToken.setState('failed');
        } else {
            this.kaasToken.setState('passed');
        }

        if (git === 'NoGit') {
            this.gitInitItem.setState('failed');
            return children;
        }
        this.gitInitItem.setState('passed');
        children.push(this.remoteOriginItem);
        if (git === 'NoRemote') {
            this.remoteOriginItem.setState('failed');
            return children;
        }
        this.remoteOriginItem.setState('passed');
        children.push(this.remoteBranchItem);
        if (git === 'NoRemoteBranch') {
            this.remoteBranchItem.setState('failed');
            return children;
        }
        this.remoteBranchItem.setState('passed');
        if (kaas !== 'InvalidKaasToken') {
            children.push(this.vaultItem);
            if (kaas === 'NoVault') {
                this.vaultItem.setState('failed');
                return children;
            }
            this.vaultItem.setState('passed');
        }
        children.push(this.workingTreeItem, this.unpushedChangesItem);
        this.workingTreeItem.setState(git.workingTreeChanges ? 'warning' : 'passed');
        this.unpushedChangesItem.setState(git.unpushedChanges ? 'warning' : 'passed');
        return children;
    }

    private async checkSyncState(): Promise<SyncState> {
        const git = gitApi();
        const [repo, kaasTokenValid] = await Promise.all([
            getGitRepository(git, this.workspaceFolder),
            validateKaasToken(this.client)
        ]);
        const kaas = kaasTokenValid ? 'ValidKaasToken' : 'InvalidKaasToken';
        if (!repo) {
            return {git: 'NoGit', kaas };
        }
        const remote = await getRemoteOrigin(repo);
        if (!remote) {
            return {git: 'NoRemote', kaas };
        }
        const remoteBranch = await getRemoteBranch(repo);
        if (!remoteBranch) {
            return {git: 'NoRemoteBranch', kaas };
        }
        const workingTreeChanges = await hasWorkingTreeChanges(repo);
        const unpushedChanges = await hasUnpushedChanges(repo);

        if (kaas === 'ValidKaasToken') {
            const vaultError = await verifyVaultExists(this.client, remoteBranch.owner, remoteBranch.repo);
            return {
                git: { workingTreeChanges, unpushedChanges },
                kaas: vaultError ? 'NoVault' : 'Connected'
            };
        }
        return { git: { workingTreeChanges, unpushedChanges }, kaas };
    }
}

class RemoteSyncItem extends vscode.TreeItem {
    constructor(
        contextValue: string,
        private state: 'passed' | 'warning' | 'failed',
        private descriptionPassed: string,
        private descriptionFailed: string
    ) {
        const label = state === 'passed' ? descriptionPassed : descriptionFailed;
        super(label, vscode.TreeItemCollapsibleState.None);
        this.contextValue = contextValue;
        this.updateDescription();
        this.updateIcon();
    }

    public setState(state: 'passed' | 'warning' | 'failed') {
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

async function validateKaasToken(client: Client<paths>): Promise<boolean> {
    const apiKey = vscode.workspace.getConfiguration('kaas-vscode').get<string>('apiKey');
    if (!apiKey) {
        return false;
    }
    const response = await client.GET('/api/user');
    if (response.error) {
        return false;
    }
    return true;
}