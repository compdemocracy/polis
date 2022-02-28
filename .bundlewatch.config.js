module.exports = {
  "ci": {
    "trackBranches": [
      process.env.CI_BRANCH_DEFAULT,
    ],
    // Allows bundlewatch GitHub Actions workflow to work on: pull_request, or push
    "commitSha": process.env.PR_COMMIT_SHA || process.env.PUSH_COMMIT_SHA,
    "repoBranchBase": process.env.PR_BRANCH_BASE || process.env.PUSH_BRANCH_BASE,
    "repoCurrentBranch": process.env.PR_BRANCH || process.env.PUSH_BRANCH,
  },
  "files": [
    {
      "path": "client-admin/dist/*.js",
      "maxSize": "180 kB",
    },
    {
      "path": "client-participation/dist_foo/vis_bundle.js",
      "maxSize": "900 kB",
    },
  ]
};
