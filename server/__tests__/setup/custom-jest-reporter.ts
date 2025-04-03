/**
 * Custom Jest Reporter
 *
 * This reporter adds a detailed summary of failed tests at the end of the test run.
 */

// Use CommonJS format since Jest's reporter system expects it
module.exports = class CustomJestReporter {
  constructor(globalConfig, options) {
    this.globalConfig = globalConfig;
    this.options = options || {};
    this.failedSuites = new Map();
    this.failedTests = 0;
    this.passedTests = 0;
    this.totalTests = 0;
  }

  onRunComplete(_contexts, results) {
    this.totalTests = results.numTotalTests;
    this.passedTests = results.numPassedTests;
    this.failedTests = results.numFailedTests;

    // If there are no failures, just print a nice message
    if (results.numFailedTests === 0) {
      if (results.numTotalTests > 0) {
        // Optional success message could go here
      }
      return;
    }

    // Collect failed tests information
    results.testResults.forEach((testResult) => {
      const failedTestsInSuite = testResult.testResults.filter((test) => test.status === 'failed');

      if (failedTestsInSuite.length > 0) {
        this.failedSuites.set(
          testResult.testFilePath,
          failedTestsInSuite.map((test) => ({
            name: test.fullName || test.title,
            errorMessage: this.formatErrorMessage(test.failureMessages[0])
          }))
        );
      }
    });

    this.printFailureSummary();
  }

  formatErrorMessage(errorMessage) {
    if (!errorMessage) {
      return 'Unknown error';
    }

    // Try to extract the most relevant part of the error message
    const lines = errorMessage.split('\n');

    // If it's an assertion error, get the comparison lines
    const expectedLine = lines.find((line) => line.includes('Expected:'));
    const receivedLine = lines.find((line) => line.includes('Received:'));

    if (expectedLine && receivedLine) {
      return `${expectedLine} ${receivedLine}`;
    }

    // Otherwise, return the first line that's likely the most informative
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip stack trace lines and empty lines
      if (trimmed && !trimmed.startsWith('at ') && !trimmed.startsWith('Error:')) {
        return trimmed;
      }
    }

    // Fallback to first line
    return lines[0] || 'Unknown error';
  }

  printFailureSummary() {
    let testCounter = 0;

    // Print each failed suite and its tests
    this.failedSuites.forEach((tests, suitePath) => {
      const relativePath = suitePath.replace(process.cwd(), '').replace(/^\//, '');
      console.log(`\n\x1b[31m● Failed in: \x1b[1m${relativePath}\x1b[0m`);

      tests.forEach((test) => {
        testCounter++;
        console.log(`  \x1b[31m● ${test.name}\x1b[0m`);
        console.log(`    \x1b[90m${test.errorMessage}\x1b[0m`);
      });
    });

    // Print summary
    if (testCounter > 0) {
      console.log(`\n\x1b[31m${testCounter} failing tests\x1b[0m`);
    }
  }
};