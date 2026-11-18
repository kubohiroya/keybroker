/**
 * Review operations the Git Worker sends to GitHub. Clients name an operation and send
 * variables; they never send a document, a pull request node ID or a review node ID.
 */
export const githubReviewDocuments = {
  pullRequestReviewContext: `query PullRequestReviewContext($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name, followRenames: false) {
    databaseId
    pullRequest(number: $number) {
      id
      headRefOid
      pending: reviews(states: [PENDING], first: 5) {
        nodes { id viewerDidAuthor createdAt body commit { oid } comments(first: 1) { totalCount } }
      }
      recent: reviews(last: 30) {
        nodes { id viewerDidAuthor state submittedAt commit { oid } }
      }
    }
  }
}`,
  addPullRequestReview: `mutation AddPullRequestReview($pullRequestId: ID!, $commitOid: GitObjectID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOid}) {
    pullRequestReview { id state commit { oid } pullRequest { id } }
  }
}`,
  addPullRequestReviewThread: `mutation AddPullRequestReviewThread($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $reviewId, path: $path, subjectType: FILE, body: $body}) {
    thread { id path subjectType }
  }
}`,
  submitPullRequestReview: `mutation SubmitPullRequestReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: $event, body: $body}) {
    pullRequestReview { id state submittedAt url commit { oid } }
  }
}`,
  deletePullRequestReview: `mutation DeletePullRequestReview($reviewId: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $reviewId}) {
    pullRequestReview { id }
  }
}`,
} as const;

export type GitHubReviewOperation = keyof typeof githubReviewDocuments;

export function isGitHubReviewOperation(
  value: string,
): value is GitHubReviewOperation {
  return Object.hasOwn(githubReviewDocuments, value);
}

export const pullRequestPublicationStatusDocument = `query PullRequestPublicationStatus($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name, followRenames: false) {
    databaseId
    pullRequest(number: $number) {
      number
      state
      mergedAt
      isDraft
      headRefName
      headRefOid
      headRepository { databaseId }
      baseRefName
      baseRefOid
      reviewDecision
      mergeStateStatus
      mergeable
      statusCheckRollup {
        commit { oid }
        state
        contexts(first: 1) { totalCount }
      }
    }
  }
}`;
