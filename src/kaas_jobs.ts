import { Client } from 'openapi-fetch';
import * as vscode from 'vscode';
import { KAAS_JOB_POLL_INTERVAL, getKaasBaseUrl } from './config';
import { JobKind, JobStatus, components, paths } from './kaas-api';
import { createAuthenticatedWebview } from './webview';

export async function fetchLatestRun(
  client: Client<paths>,
  testController: vscode.TestController,
  organizationName: string,
  vaultName: string,
  profileName: string,
  testItem: vscode.TestItem
): Promise<void> {
  let job: components['schemas']['IJob'] | undefined;
  try {
    job = await getLatestJobStatusFor(client, organizationName, vaultName, profileName);
  } catch (error) {
    return;
  }
  if (job === undefined) {
    return;
  }
  const testRun = testController.createTestRun(new vscode.TestRunRequest([testItem], []));
  if (job.status === JobStatus.success) {
    testRun.passed(testItem, job.duration * 1000);
  } else if (job.status === JobStatus.cancelled) {
    testRun.errored(
      testItem,
      new vscode.TestMessage(`Job ${job.id} was cancelled`),
      job.duration * 1000
    );
  } else if (job.status === JobStatus.failure || job.status === JobStatus.processing_failed) {
    testRun.failed(testItem, new vscode.TestMessage(`Job ${job.id} failed`), job.duration * 1000);
  } else if (job.status === JobStatus.pending || job.status === JobStatus.running) {
    testRun.enqueued(testItem);
    // Todo: Keep polling for job status
  }
  testRun.end();
}

export async function getJobStatusByJobId(
  client: Client<paths>,
  jobId: string
): Promise<components['schemas']['IJob']> {
  const job = await client.GET('/api/jobs/{jobId}', {
    params: {
      path: {
        jobId,
      },
    },
  });
  if (job.response.status !== 200) {
    throw new Error(`Job with ID ${jobId} not found`);
  }
  if (job.data === undefined) {
    throw new Error(`Job with ID ${jobId} returned no data`);
  }
  return job.data;
}

export async function getJobReportByJobId(client: Client<paths>, jobId: string): Promise<string> {
  const job = await client.GET('/api/jobs/{jobId}/json-report', {
    params: {
      path: {
        jobId,
      },
    },
  });
  if (job.response.status !== 200) {
    throw new Error(`Job with ID ${jobId} not found`);
  }
  if (job.data === undefined) {
    throw new Error(`Job with ID ${jobId} returned no data`);
  }
  return job.data;
}

export async function pollForJobStatus(
  client: Client<paths>,
  testController: vscode.TestController,
  test: vscode.TestItem,
  jobId: string
) {
  while (true) {
    try {
      const jobDetails = await getJobStatusByJobId(client, jobId);

      if (jobDetails.status === JobStatus.success) {
        test.busy = false;
        const testRun = testController.createTestRun(new vscode.TestRunRequest([test]));
        testRun.appendOutput(
          `Run completed successfully. See details here: ${jobUri(jobDetails).toString()}`
        );
        testRun.passed(test, jobDetails.duration * 1000);
        testRun.end();

        // Automatically display the report
        // Kontrol job
        if (jobDetails.kind === JobKind.kontrol) {
          if (jobDetails.children && jobDetails.children.length > 0) {
            for (const childJob of jobDetails.children) {
              const report = await getJobReportByJobId(client, childJob.id);
              if (report) {
                const reportUrl = jobReportUri(childJob).toString();
                createAuthenticatedWebview(
                  reportUrl,
                  `jobReport-${childJob.id}`,
                  `Job ${childJob.id.slice(0, 6)} Report`
                );
              }
            }
          }
        }
        // Foundry job
        else if (jobDetails.kind === JobKind.foundry) {
          const report = await getJobReportByJobId(client, jobDetails.id);
          if (report) {
            const reportUrl = jobReportUri(jobDetails).toString();
            createAuthenticatedWebview(
              reportUrl,
              `jobReport-${jobDetails.id}`,
              `Job ${jobDetails.id.slice(0, 6)} Report`
            );
          }
        }

        console.log('testRun.passed: ', jobDetails.duration * 1000);
        break;
      }

      if (
        jobDetails.status === JobStatus.failure ||
        jobDetails.status === JobStatus.processing_failed
      ) {
        test.busy = false;
        const testRun = testController.createTestRun(new vscode.TestRunRequest([test]));
        testRun.failed(
          test,
          new vscode.TestMessage(
            `Run failed. See run details here: ${jobUri(jobDetails).toString()}`
          ),
          jobDetails.duration * 1000
        );
        testRun.end();
        break;
      }

      if (jobDetails.status === JobStatus.cancelled) {
        test.busy = false;
        const testRun = testController.createTestRun(new vscode.TestRunRequest([test]));
        testRun.errored(
          test,
          new vscode.TestMessage(
            `Run was cancelled. See run details here: ${jobUri(jobDetails).toString()}`
          ),
          jobDetails.duration * 1000
        );
        testRun.end();
        break;
      }
    } catch (error) {
      test.busy = false;
      const testRun = testController.createTestRun(new vscode.TestRunRequest([test]));
      testRun.errored(test, new vscode.TestMessage(`Error fetching job status: ${error}`));
      testRun.end();
      break;
    }
    await new Promise(resolve => setTimeout(resolve, KAAS_JOB_POLL_INTERVAL));
  }
}

export async function fetchComputeJobs(
  client: Client<paths>,
  testController: vscode.TestController
) {
  const allJobs: [components['schemas']['IJob'], vscode.TestItem][] = []; // List of all discovered computed jobs

  const orgsResponse = await client.GET('/api/orgs');
  const orgs = orgsResponse.data ?? [];
  for (const org of orgs) {
    const orgItem = testController.createTestItem(org.name, org.name);
    const orgName = org.name;
    const jobsResponse = await client.GET('/api/orgs/{organizationName}/jobs', {
      params: { path: { organizationName: orgName }, query: { page: 1, per_page: 10 } },
    });
    const jobs = jobsResponse.data ?? [];
    for (const job of jobs) {
      const name = jobName(job);
      const jobItem = testController.createTestItem(job.id, name, jobUri(job));
      allJobs.push([job, jobItem]);
      orgItem.children.add(jobItem);
    }
    testController.items.add(orgItem);
  }
  const testRunRequest = new vscode.TestRunRequest(
    allJobs.map(([_, item]) => item),
    []
  );
  const testRun = testController.createTestRun(testRunRequest);

  for (const [job, testItem] of allJobs) {
    if (job.status === 'success') {
      testRun.passed(testItem, job.duration * 1000);
    } else if (job.status === 'cancelled') {
      testRun.errored(
        testItem,
        new vscode.TestMessage(`Job ${jobName(job)} was cancelled`),
        job.duration * 1000
      );
    } else {
      testRun.failed(
        testItem,
        new vscode.TestMessage(`Job ${jobName(job)} failed`),
        job.duration * 1000
      );
    }
  }
  testRun.end();
}

export async function getLatestJobStatusFor(
  client: Client<paths>,
  organizationName: string,
  vaultName: string,
  profileName: string
): Promise<components['schemas']['IJob']> {
  const job = await client.GET('/api/orgs/{organizationName}/vaults/{vaultName}/jobs', {
    params: {
      path: {
        organizationName,
        vaultName,
      },
      query: {
        profile: profileName, // TODO: Look like the endpoint filtering does not work
        page: 1,
        per_page: 1,
      },
    },
  });
  if (job.response.status !== 200) {
    throw new Error(
      `Failed to fetch jobs for organization ${organizationName} and vault ${vaultName}: ${job.response.statusText}`
    );
  }
  if (job.data === undefined) {
    throw new Error(`No jobs found for organization ${organizationName} and vault ${vaultName}`);
  }
  for (const jobItem of job.data) {
    return jobItem;
  }
  throw new Error(
    `No jobs found for profile ${profileName} in organization ${organizationName} and vault ${vaultName}`
  );
}

function jobName(job: components['schemas']['IJob']): string {
  return `${job.kind}/${job.type}/${job.repo}`;
}

export function jobUri(job: components['schemas']['IJob']): vscode.Uri {
  return vscode.Uri.parse(
    `${getKaasBaseUrl()}/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}`
  );
}

export function jobReportUri(job: components['schemas']['IJob']): vscode.Uri {
  return vscode.Uri.parse(
    `${getKaasBaseUrl()}/app/organization/${job.organizationName}/${job.vaultName}/job/${job.id}/report`
  );
}

export function jobCacheUri(job: components['schemas']['IJob']): vscode.Uri | undefined {
  if (job.cacheHash) {
    return vscode.Uri.parse(
      `${getKaasBaseUrl()}/app/organization/${job.organizationName}/${job.vaultName}/cache/${job.cacheHash}`
    );
  } else {
    return undefined; // No cache found
  }
}
