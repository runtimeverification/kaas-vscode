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

export async function getJobReportByJobId(
  client: Client<paths>,
  jobId: string
): Promise<components['schemas']['IJob']> {
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
  return job.data.testsuites;
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
        if (jobDetails.children && jobDetails.children.length > 0) {
          for (const childJob of jobDetails.children) {
            const report = await getJobReportByJobId(client, childJob.id);
            if (report) {
              const panel = vscode.window.createWebviewPanel(
                'report', // Identifies the type of the webview. Used internally
                'Report', // Title of the panel displayed to the user
                vscode.ViewColumn.One, // Editor column to show the new webview panel in
                {} // Webview options
              );

              panel.webview.html = getReportContentHtml(report);
            }
          }
        }
        testRun.passed(test, jobDetails.duration * 1000);
        testRun.end();
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

function jobUri(job: components['schemas']['IJob']): vscode.Uri {
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

function getReportContentHtml(report: components['schemas']['IJob']): string {
  // Extract your dynamic values from the report object
  const totalTests = report.$.tests ?? 0;
  const totalErrors = report.$.errors ?? 0;
  const totalFailures = report.$.failures ?? 0;
  const passingTests = totalTests - totalErrors - totalFailures;

  const passRate = totalTests > 0 ? (passingTests / totalTests) * 100 : 0;
  const duration = report.$.time ? formatDuration(Number(report.$.time) * 1000) : 'N/A';
  const timestamp = report.$.timestamp ?? '';

  const verificationSummary = `<h1>Verification Summary</h1>
  <div class="summary">
    <div>
      <div>Total Tests</div>
      <div><b>${totalTests}</b></div>
    </div>
    <div>
      <div style="color: green;">Passed</div>
      <div style="color: green;"><b>${passingTests}</b></div>
    </div>
    <div>
      <div style="color: red;">Failures</div>
      <div style="color: red;"><b>${totalFailures}</b></div>
    </div>
    <div>
      <div style="color: orange;">Errors</div>
      <div style="color: orange;"><b>${totalErrors}</b></div>
    </div>
  </div>
  <div style="margin-top:2em;">
    <div>Pass Rate: <b>${passRate.toFixed(2)}%</b></div>
    <div class="progress-bar">
      <div class="progress" style="width: ${passRate}%;"></div>
    </div>
  </div>
  <div style="margin-top:2em;">
    <div>Duration: <b>${duration}</b></div>
    <div>Timestamp: <b>${timestamp}</b></div>
  </div>`;

  // Loop over test suites and build HTML for each
  let suitesHtml = `<h1>Test Suites</h1>`;
  const testSuites = report.testsuite ?? [];
  for (const suite of testSuites) {
    const suiteTests = report.$.tests ?? 0;
    const suiteErrors = report.$.errors ?? 0;
    const suiteFailures = report.$.failures ?? 0;
    const suitepassingTests = suiteTests - suiteErrors - suiteFailures;
    suitesHtml += `
    <div class="suite">
      <h2>${suite.$.name}</h2>
      <hr>
      <div class="suite-info">
        <b>Passing:</b> <span style="color:green;">${suitepassingTests}</span> &nbsp; 
        <b>Failures:</b> <span style="color:red;">${suiteFailures}</span> &nbsp; 
        <b>Errors:</b> <span style="color:orange;">${suiteErrors}</span> &nbsp; 
        <b>Time:</b> ${formatDuration(Number(suite.$.time) * 1000)} seconds
      </div>
      <hr>
      <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse; margin-bottom:1em; width:100%;">
        <thead>
          <tr>
            <th>Test Name</th>
            <th>Status</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          ${(suite.testcase ?? [])
            .map(
              (test: any) => `
            <tr>
              <td>${test.$.name}</td>
              <td>
                ${test.failure ? '<span style="color:red;">Failed</span>' : test.error ? '<span style="color:orange;">Passed</span>' : '<span style="color:green;">Passed</span>'}
              </td>
              <td>
                ${test.$.time ? `${formatDuration(Number(test.$.time) * 1000)}` : 'N/A'}
              </td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
  }

  // Build the HTML string with template literals
  return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Formal Verification Report</title>
    <style>
      body { font-family: sans-serif; margin: 2em; }
      .summary { display: flex; gap: 2em; }
      .summary div { padding: 1em; border-radius: 8px; }
      .progress-bar { background: #eee; border-radius: 4px; height: 16px; width: 100%; }
      .progress { background: #4caf50; height: 100%; border-radius: 4px; }
      .suite-info span { margin-right: 3.0em; } /* Add this line */
    </style>
</head>
<body>
    ${verificationSummary}
    ${suitesHtml}
</body>
</html>
`;
}

// Helper function to format milliseconds into human-readable duration
function formatDuration(ms: number): string {
  if (isNaN(ms)) {
    return 'N/A';
  }
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(' ');
}
