import * as vscode from 'vscode';
import * as child_process from 'child_process';

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