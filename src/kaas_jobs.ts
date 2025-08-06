import { Client } from 'openapi-fetch';
import * as vscode from 'vscode';
import { KAAS_JOB_POLL_INTERVAL, getKaasBaseUrl } from './config';
import { JobStatus, components, paths } from './kaas-api';

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
  jobId: string,
  testRun: vscode.TestRun,
  runningTests: Set<vscode.TestItem>
) {
  while (true) {
    try {
      const jobDetails = await getJobStatusByJobId(client, jobId);

      if (jobDetails.status === JobStatus.success) {
        test.busy = false;
        testRun.appendOutput(
          `Run completed successfully. See details here: ${jobUri(jobDetails).toString()}`
        );
        testRun.passed(test, jobDetails.duration * 1000);

        // Remove this test from running tests and end testRun if no more tests are running
        runningTests.delete(test);
        if (runningTests.size === 0) {
          testRun.end();
        }
        break;
      }

      if (
        jobDetails.status === JobStatus.failure ||
        jobDetails.status === JobStatus.processing_failed
      ) {
        test.busy = false;
        testRun.failed(
          test,
          new vscode.TestMessage(
            `Run failed. See run details here: ${jobUri(jobDetails).toString()}`
          ),
          jobDetails.duration * 1000
        );

        // Remove this test from running tests and end testRun if no more tests are running
        runningTests.delete(test);
        if (runningTests.size === 0) {
          testRun.end();
        }
        break;
      }

      if (jobDetails.status === JobStatus.cancelled) {
        test.busy = false;
        testRun.errored(
          test,
          new vscode.TestMessage(
            `Run was cancelled. See run details here: ${jobUri(jobDetails).toString()}`
          ),
          jobDetails.duration * 1000
        );

        // Remove this test from running tests and end testRun if no more tests are running
        runningTests.delete(test);
        if (runningTests.size === 0) {
          testRun.end();
        }
        break;
      }
    } catch (error) {
      console.warn(`Failed to fetch job status for job ${jobId}: ${error}. Retrying...`);
      // Don't fail the test on network errors - just continue polling
      // The job might still be running and we'll get the status on the next poll
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
