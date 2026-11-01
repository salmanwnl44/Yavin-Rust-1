import assert from "node:assert/strict";
import test from "node:test";
import { remoteUrlToWeb } from "./remoteUrl.ts";

test("converts an https remote URL, stripping .git", () => {
  assert.deepEqual(remoteUrlToWeb("https://github.com/salmanwnl44/Yavin-git-testing.git"), {
    url: "https://github.com/salmanwnl44/Yavin-git-testing",
    label: "GitHub",
  });
});

test("converts an https remote URL with no .git suffix", () => {
  assert.deepEqual(remoteUrlToWeb("https://gitlab.com/owner/repo"), {
    url: "https://gitlab.com/owner/repo",
    label: "GitLab",
  });
});

test("converts the scp-like SSH shorthand git@host:owner/repo.git", () => {
  assert.deepEqual(remoteUrlToWeb("git@github.com:owner/repo.git"), {
    url: "https://github.com/owner/repo",
    label: "GitHub",
  });
});

test("converts an explicit ssh:// URL, including a non-default port", () => {
  assert.deepEqual(remoteUrlToWeb("ssh://git@bitbucket.org:22/owner/repo.git"), {
    url: "https://bitbucket.org/owner/repo",
    label: "Bitbucket",
  });
});

test("strips basic-auth userinfo from an https URL rather than carrying it into the browser", () => {
  assert.deepEqual(remoteUrlToWeb("https://user:token@github.com/owner/repo.git"), {
    url: "https://github.com/owner/repo",
    label: "GitHub",
  });
});

test("an unrecognized host still converts, with the host itself as the label", () => {
  assert.deepEqual(remoteUrlToWeb("https://git.example.com/owner/repo.git"), {
    url: "https://git.example.com/owner/repo",
    label: "git.example.com",
  });
});

test("a bare local path or an ext:: transport is not a web link", () => {
  assert.equal(remoteUrlToWeb("/home/user/repo.git"), null);
  assert.equal(remoteUrlToWeb("../sibling-repo"), null);
  assert.equal(remoteUrlToWeb("ext::sh -c 'echo hi'"), null);
  assert.equal(remoteUrlToWeb(""), null);
});

test("a file:// URL is not a web link", () => {
  assert.equal(remoteUrlToWeb("file:///home/user/repo.git"), null);
});
