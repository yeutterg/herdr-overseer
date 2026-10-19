'use strict';

// Everything the sidebar knows about PRs and issues comes from two places:
//   1. the pane's git branch, looked up with `gh pr list --head <branch>`
//      (that PR, its state, and the issues it closes), plus an issue number
//      in the branch name itself (fix/138-…, issue-138, gh-138);
//   2. github.com/<owner>/<repo>/(pull|issues)/<n> URLs printed in the pane,
//      which catches PRs and issues an agent created while staying on main.

const { execFile } = require('node:child_process');
const path = require('node:path');

const CLOSED_PR_TTL_MS = 3 * 24 * 3600_000;

function run(cmd, args, cwd, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout.toString());
    });
  });
}

// The checkout containing `cwd`, or null:
//   top            its root
//   common         the shared .git dir, the same for every worktree of a repo
//   branch         current branch ("HEAD" when detached)
//   repo           "owner/name" from the origin remote, when it is on GitHub
//   defaultBranch  origin's default branch
//   ahead, behind  commits relative to origin/<defaultBranch>
//   dirty          number of changed or untracked files
async function gitInfo(cwd) {
  if (!cwd) return null;
  const out = await run('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD', '--git-common-dir'], cwd, 3000);
  if (!out) return null;
  const [top, branch, common] = out.trim().split('\n');
  const [remote, defaultRef, status] = await Promise.all([
    run('git', ['-C', top, 'remote', 'get-url', 'origin'], top, 3000),
    run('git', ['-C', top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], top, 3000),
    run('git', ['-C', top, 'status', '--porcelain'], top, 3000),
  ]);
  const defaultBranch = defaultRef ? defaultRef.trim().replace(/^origin\//, '') : null;
  let ahead = null;
  let behind = null;
  if (defaultBranch) {
    const counts = await run('git', ['-C', top, 'rev-list', '--left-right', '--count', `origin/${defaultBranch}...HEAD`], top, 3000);
    if (counts) [behind, ahead] = counts.trim().split(/\s+/).map(Number);
  }
  return {
    top,
    common: path.resolve(top, common ?? '.git'),
    branch,
    repo: parseRepo(remote),
    defaultBranch,
    ahead,
    behind,
    dirty: status == null ? null : status.split('\n').filter(Boolean).length,
  };
}

function parseRepo(remoteUrl) {
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s*$/.exec(remoteUrl ?? '');
  return m ? m[1] : null;
}

// Branches that never have "their own" PR.
function isTrunk(info) {
  return !info.branch || info.branch === 'HEAD' || info.branch === info.defaultBranch || ['main', 'master'].includes(info.branch);
}

async function prForBranch(info) {
  const out = await run(
    'gh',
    ['pr', 'list', '--head', info.branch, '--state', 'all', '--limit', '1', '--json', 'number,state,isDraft,closedAt,closingIssuesReferences'],
    info.top,
  );
  if (!out) return null;
  try {
    const [pr] = JSON.parse(out);
    if (!pr) return { none: true };
    // A checkout left on a long-merged branch would pin that old PR to every
    // agent working there; only recent ones are news.
    if (pr.state !== 'OPEN' && pr.closedAt && Date.now() - Date.parse(pr.closedAt) > CLOSED_PR_TTL_MS) return { none: true };
    return {
      number: pr.number,
      state: pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase(),
      closes: (pr.closingIssuesReferences ?? []).map((i) => i.number),
    };
  } catch {
    return null;
  }
}

// { state: open|draft|merged|closed, title, head (PRs: the branch) } for a PR
// or issue, or null.
async function refMeta(slug, kind, n) {
  const fields = kind === 'pr' ? 'state,isDraft,title,headRefName' : 'state,title';
  const out = await run('gh', [kind === 'pr' ? 'pr' : 'issue', 'view', String(n), '-R', slug, '--json', fields], undefined);
  if (!out) return null;
  try {
    const m = JSON.parse(out);
    const meta = { state: m.isDraft && m.state === 'OPEN' ? 'draft' : m.state.toLowerCase(), title: m.title };
    if (kind === 'pr') meta.head = m.headRefName ?? null;
    return meta;
  } catch {
    return null;
  }
}

// The default branch GitHub reports for "owner/name", or null.
async function defaultBranch(slug) {
  const out = await run('gh', ['repo', 'view', slug, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], undefined);
  return out ? out.trim() || null : null;
}

// fix/138-foo, 138-foo, issue-138, feat/gh-138_bar → 138. A number has to be
// a whole name segment so v2-fix or feat/2fa don't count.
function issueFromBranch(branch) {
  const m = /(?:^|\/)(?:(?:issues?|gh)[-_]?|#)?(\d{1,6})(?=$|[-_/])/i.exec(branch ?? '');
  return m ? Number(m[1]) : null;
}

const URL_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)/g;

// [{ repo, kind: 'pr'|'issue', n }] in order of last appearance, de-duplicated.
function scanRefs(text) {
  const seen = new Map();
  for (const m of (text ?? '').matchAll(URL_RE)) {
    const ref = { repo: m[1], kind: m[2] === 'pull' ? 'pr' : 'issue', n: Number(m[3]) };
    const key = `${ref.repo}/${ref.kind}/${ref.n}`;
    seen.delete(key);
    seen.set(key, ref);
  }
  return [...seen.values()];
}

module.exports = { run, gitInfo, defaultBranch, parseRepo, isTrunk, prForBranch, refMeta, issueFromBranch, scanRefs };
