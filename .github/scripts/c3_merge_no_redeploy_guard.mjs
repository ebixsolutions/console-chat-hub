#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function classifyMergeEvent(event, associatedPulls) {
  if (event.ref !== "refs/heads/main" || !event.before || !event.after) {
    return { mode: "normal_deploy", reason: "not_main_push" };
  }
  const match = associatedPulls.find((pr) =>
    pr.number === 12 && pr.merged_at && pr.base?.ref === "main" &&
    pr.head?.ref === "director/ai-abc-c3-long-memory-final-cutover"
  );
  if (!match) return { mode: "normal_deploy", reason: "not_c3_pr12_merge" };
  if (!/^[0-9a-f]{40}$/.test(String(match.head?.sha ?? ""))) throw new Error("c3_pr_head_sha_invalid");
  return {
    mode: "c3_no_redeploy_candidate",
    reason: "C3_VALIDATED_LIVE_RUNTIME_ALREADY_PRESENT",
    pr_number: 12,
    pr_head: match.head.sha,
  };
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "c3-merge-no-redeploy-guard/1.0",
    },
  });
  if (!response.ok) throw new Error(`github_api_failed:${response.status}:${url}`);
  return response.json();
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !sha || !token) throw new Error("github_context_missing");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  const pulls = await githubJson(`https://api.github.com/repos/${repository}/commits/${sha}/pulls`, token);
  const decision = classifyMergeEvent(event, pulls);
  if (decision.mode === "c3_no_redeploy_candidate") {
    const commit = await githubJson(`https://api.github.com/repos/${repository}/git/commits/${decision.pr_head}`, token);
    if (!/^[0-9a-f]{40}$/.test(String(commit.tree?.sha ?? ""))) throw new Error("c3_pr_tree_sha_invalid");
    decision.pr_tree = commit.tree.sha;
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    fs.appendFileSync(output, Object.entries(decision).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  console.log(`C3_MERGE_GUARD_CLASSIFY|mode=${decision.mode}|reason=${decision.reason}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(`C3_MERGE_GUARD_CLASSIFY|result=FAIL|reason=${error.message}`);
    process.exitCode = 1;
  });
}
