// Shared in-memory data model for the github-core-clone-01 forge.
// Single process, single event loop, no persistence: fresh state per trial.
// Determinism: all ids/numbers from counters, all timestamps from a logical
// clock (fixed epoch + sequence). Never Date.now()/Math.random() here.

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Raw object content, WITHOUT the "<type> <len>\0" header. */
  data: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  /** sha (lowercase hex) -> object. */
  objects: Map<string, GitObject>;
  /** full ref 'refs/heads/main' -> commit sha. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** SHARED issue+PR number counter (GitHub behaviour), starts at 1. */
  nextNumber: number;
  nextCommentId: number;
  nextLabelId: number;
  /** Perf cache: issue number -> serialized GET /issues/{n} response body.
   *  Populated on create/first read, invalidated on PATCH. Body only —
   *  headers are set fresh per response. */
  issueJsonCache: Map<number, Buffer>;
  /** Bumped on ANY ref change (push, contents PUT, merge, branch create).
   *  Git-module caches (advertisement, clone pack) key off this. */
  refsVersion: number;
}

/** Logical-clock epoch: 2025-01-01T00:00:00Z (matches FIXTURE_EPOCH_SEC). */
export const CLOCK_EPOCH_SEC = 1735689600;

export class Store {
  readonly viewerLogin: string;
  /** Keyed by repo NAME only — only the viewer's repos ever exist. */
  readonly reposByName = new Map<string, Repo>();
  /** Creation order — pagination walks this. */
  readonly repoList: Repo[] = [];
  private nextRepoIdVal = 1;
  private seq = 0;
  private clock = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  /** Global creation counter (drives createdSeq). */
  nextSeq(): number {
    return ++this.seq;
  }

  /** Logical clock: epoch + N seconds, one second per call, strictly
   *  increasing. Returns an ISO-8601 string. */
  nowIso(): string {
    this.clock += 1;
    return new Date((CLOCK_EPOCH_SEC + this.clock) * 1000).toISOString();
  }

  /** Same clock as epoch seconds (for git commit author/committer lines). */
  nowEpochSec(): number {
    this.clock += 1;
    return CLOCK_EPOCH_SEC + this.clock;
  }

  nextRepoId(): number {
    return this.nextRepoIdVal++;
  }

  /** Returns null (→ 404) when the owner is not the token's login OR the
   *  repo name does not exist. Foreign owners NEVER 403. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewerLogin) return null;
    return this.reposByName.get(name) ?? null;
  }

  /** Creates a repo owned by the viewer. Returns null on duplicate name
   *  (→ 422). defaultBranch is set at creation, before any commit exists. */
  createRepo(name: string, priv: boolean, description: string): Repo | null {
    if (this.reposByName.has(name)) return null;
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      owner: this.viewerLogin,
      private: priv,
      description,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      issueJsonCache: new Map(),
      refsVersion: 0,
    };
    this.reposByName.set(name, repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(name: string): boolean {
    const repo = this.reposByName.get(name);
    if (!repo) return false;
    this.reposByName.delete(name);
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
    return true;
  }

  /** Allocate the next shared issue/PR number for a repo. */
  allocNumber(repo: Repo): number {
    return repo.nextNumber++;
  }

  allocCommentId(repo: Repo): number {
    return repo.nextCommentId++;
  }

  allocLabelId(repo: Repo): number {
    return repo.nextLabelId++;
  }

  /** Mark a ref change (invalidates git-module caches). */
  touchRefs(repo: Repo): void {
    repo.refsVersion++;
  }
}
