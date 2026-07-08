const GITHUB_API = "https://api.github.com";

async function gh<T>(path: string, init?: { method: string; body: object }): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "RemindMe-bot",
      ...(init ? { "Content-Type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
  return res.json();
}

export interface CommitSummary {
  repo: string;
  message: string;
  date: string;
}

export async function recentCommits(days = 7): Promise<CommitSummary[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const repos = await gh<{ full_name: string; name: string; pushed_at: string }[]>(
    "/user/repos?sort=pushed&per_page=10&type=owner"
  );

  const commits: CommitSummary[] = [];
  for (const repo of repos) {
    if (new Date(repo.pushed_at) < since) continue;

    // Empty repos return 409; skip them rather than fail the whole listing.
    const repoCommits = await gh<{ commit: { message: string; author: { date: string } } }[]>(
      `/repos/${repo.full_name}/commits?since=${since.toISOString()}&per_page=20`
    ).catch(() => []);

    for (const c of repoCommits) {
      commits.push({
        repo: repo.name,
        message: c.commit.message.split("\n")[0],
        date: c.commit.author.date,
      });
    }
  }

  return commits.sort((a, b) => b.date.localeCompare(a.date));
}

export async function createIssue(
  repo: string,
  title: string,
  body?: string
): Promise<{ number: number; url: string }> {
  const { login } = await gh<{ login: string }>("/user");
  const issue = await gh<{ number: number; html_url: string }>(
    `/repos/${login}/${repo}/issues`,
    { method: "POST", body: { title, body } }
  );
  return { number: issue.number, url: issue.html_url };
}

export interface OpenItem {
  repo: string;
  type: "pr" | "issue";
  title: string;
  url: string;
}

export async function openItems(): Promise<OpenItem[]> {
  const { login } = await gh<{ login: string }>("/user");

  type SearchResult = {
    items: { title: string; html_url: string; repository_url: string }[];
  };
  // GitHub's search API requires is:issue / is:pull-request to be separate queries.
  const [issues, prs] = await Promise.all([
    gh<SearchResult>(`/search/issues?q=user:${login}+state:open+is:issue&per_page=20`),
    gh<SearchResult>(`/search/issues?q=user:${login}+state:open+is:pull-request&per_page=20`),
  ]);

  const toItem = (type: "pr" | "issue") =>
    (item: SearchResult["items"][number]): OpenItem => ({
      repo: item.repository_url.split("/").pop() ?? "",
      type,
      title: item.title,
      url: item.html_url,
    });

  return [...prs.items.map(toItem("pr")), ...issues.items.map(toItem("issue"))];
}
