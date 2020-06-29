module.exports = {
  "ci": {
    "trackBranches": [
      process.env.CI_BRANCH_DEFAULT,
    ],
    // Allows bundlewatch GitHub Actions workflow to work on: pull_request, or push
    "commitSha": process.env.PR_COMMIT_SHA || process.env.PUSH_COMMIT_SHA,
    "repoBranchBase": process.env.PR_BRANCH_BASE || process.env.PUSH_BRANCH_BASE,
    // Note: During push event, GITHUB_REF is the current branch.
    "repoCurrentBranch": process.env.PR_BRANCH || process.env.GITHUB_REF,
  },
  "files": [
    {
      "path": "dist/*.js",
      "maxSize": "500 kB",
    },
  ]
};
