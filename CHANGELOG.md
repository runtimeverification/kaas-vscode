# Change Log

All notable changes to the "kaas-vscode" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### New Features

- Optimize validation checks to run once per workspace before test execution instead of per test.
- Improve the user experience.

### Bug Fixes

- Fix test execution in multi-workspace setups to use correct workspace folder and git information.
- Fix `--match-test` flag to use correct regular expression for function names.
- Fix test run timer not stopping when jobs complete successfully or fail.
- Fix error handling when clicking on non-executable test container nodes.
- Fix displaying the contract and test names in the test explorer.

## [0.0.9] - July 24 2025

### New Features

- Add RV Logo.
- Add kaas link to test output.
- Better dirty git detection.
- Automatically link vault on running a test.
- Display `View Job Details`, `View Report`, and `View Cache` under the test items.
- Support to configure `kaas-vscode.baseUrl` in settings.

### Bug Fixes

- Fix running the kontrol tests.

## [0.0.6] - Jun 11 2025

### Updating docs

- Initial release of K as a Service (KaaS) extension.
