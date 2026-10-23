#!/usr/bin/env node
/**
 * Custom GitHub Profile Metrics & Blog Generator for @ScreepCode (Niklas Buse)
 * Zero external dependencies — runs on Node 20+ (built-in fetch & Intl).
 *
 * Generates:
 *  - metrics/base.svg          (Header, Calendar, Activity across all years)
 *  - metrics/languages.svg     (Languages across ALL personal, private & org repos where user contributed)
 *  - metrics/habits.charts.svg (Commit activity per hour of day, day of week & recent language activity)
 *  - metrics/habits.facts.svg  (Coding habits facts: indentation, chars/line, peak hour, peak day, active language)
 *  - metrics/blog.header.svg   (Section title for Blog Posts)
 *  - metrics/blog.post-N.svg   (Individual clickable SVG cards for each blog post)
 *  - Updates README.md with clean layout & individually clickable SVG blog cards
 */

import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.METRICS_TOKEN || process.env.GITHUB_TOKEN;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Berlin';
const RSS_URL = process.env.RSS_URL || 'https://www.niklas-buse.de/rss.xml';
const OUT_DIR = path.resolve(process.cwd(), 'metrics');

if (!TOKEN) {
  console.error('Error: METRICS_TOKEN or GITHUB_TOKEN environment variable is required.');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'User-Agent': 'ScreepCode-Profile-Metrics-Generator',
};

async function githubGraphQL(query, variables = {}, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ query, variables }),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
      }
      return json.data;
    }
    const text = await res.text();
    if (attempt < retries && res.status >= 500) {
      console.warn(`GraphQL HTTP ${res.status} (attempt ${attempt}/${retries}), retrying in 2s...`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`GraphQL HTTP ${res.status}: ${text}`);
  }
}

async function githubREST(endpoint) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    headers: HEADERS,
  });
  if (!res.ok) {
    return null;
  }
  return res.json();
}

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// 1. Fetch User Profile & Multi-Year Contributions
// ---------------------------------------------------------------------------
async function fetchUserData() {
  console.log('Fetching user profile and contribution years...');
  const basic = await githubGraphQL(`
    query {
      viewer {
        id
        login
        name
        avatarUrl(size: 64)
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        issues { totalCount }
        issueComments { totalCount }
        contributionsCollection {
          contributionYears
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                date
                color
              }
            }
          }
        }
      }
    }
  `);

  const viewer = basic.viewer;
  const years = viewer.contributionsCollection.contributionYears;

  const yearAliases = years
    .map(
      (y) => `
      y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${y}-12-31T23:59:59Z") {
        totalCommitContributions
        restrictedContributionsCount
        totalPullRequestReviewContributions
      }`
    )
    .join('\n');

  const yearsData = await githubGraphQL(`
    query {
      viewer {
        ${yearAliases}
      }
    }
  `);

  let totalCommits = 0;
  let totalReviews = 0;
  for (const y of years) {
    const c = yearsData.viewer[`y${y}`];
    if (c) {
      totalCommits += (c.totalCommitContributions || 0) + (c.restrictedContributionsCount || 0);
      totalReviews += c.totalPullRequestReviewContributions || 0;
    }
  }

  let avatarBase64 = '';
  try {
    const avatarRes = await fetch(viewer.avatarUrl);
    if (avatarRes.ok) {
      const buf = Buffer.from(await avatarRes.arrayBuffer());
      avatarBase64 = `data:image/png;base64,${buf.toString('base64')}`;
    }
  } catch (e) {
    console.warn('Could not fetch avatar image:', e.message);
  }

  const allDays = viewer.contributionsCollection.contributionCalendar.weeks.flatMap(
    (w) => w.contributionDays
  );
  const last14Days = allDays.slice(-14);

  return {
    id: viewer.id,
    login: viewer.login,
    name: viewer.name || viewer.login,
    createdAt: viewer.createdAt,
    followers: viewer.followers.totalCount,
    pullRequests: viewer.pullRequests.totalCount,
    issues: viewer.issues.totalCount,
    issueComments: viewer.issueComments.totalCount,
    totalCommits,
    totalReviews,
    avatarBase64,
    last14Days,
  };
}

// ---------------------------------------------------------------------------
// 2. Fetch All Repositories (Personal + Collaborator + All Orgs) & Commit History
// ---------------------------------------------------------------------------
const REPO_FRAGMENT = `
  fragment RepoFields on Repository {
    nameWithOwner
    isPrivate
    primaryLanguage {
      name
      color
    }
    languages(first: 15, orderBy: { field: SIZE, direction: DESC }) {
      edges {
        size
        node {
          name
          color
        }
      }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 25, author: { id: $userId }) {
            totalCount
            nodes {
              oid
              committedDate
            }
          }
        }
      }
    }
  }
`;

async function fetchRepositoriesAndCommits(userId) {
  console.log('Fetching personal & collaborator repositories...');
  const userReposData = await githubGraphQL(
    `
    query($userId: ID!) {
      viewer {
        repositories(
          first: 100
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          isFork: false
          orderBy: { field: PUSHED_AT, direction: DESC }
        ) {
          nodes {
            ...RepoFields
          }
        }
      }
    }
    ${REPO_FRAGMENT}
  `,
    { userId }
  );

  console.log('Fetching organization repositories...');
  const orgReposData = await githubGraphQL(
    `
    query($userId: ID!) {
      viewer {
        organizations(first: 25) {
          nodes {
            login
            repositories(
              first: 40
              isFork: false
              orderBy: { field: PUSHED_AT, direction: DESC }
            ) {
              nodes {
                ...RepoFields
              }
            }
          }
        }
      }
    }
    ${REPO_FRAGMENT}
  `,
    { userId }
  );

  const repoMap = new Map();
  for (const r of userReposData.viewer.repositories.nodes || []) {
    if (r) repoMap.set(r.nameWithOwner, r);
  }
  for (const org of orgReposData.viewer.organizations.nodes || []) {
    for (const r of org?.repositories?.nodes || []) {
      if (r) repoMap.set(r.nameWithOwner, r);
    }
  }

  const contributedRepos = [];
  const languageMap = new Map();
  const allRecentCommits = [];
  const excludedLanguages = new Set(['XSLT', 'Bru']);

  for (const repo of repoMap.values()) {
    const history = repo.defaultBranchRef?.target?.history;
    const commitCount = history?.totalCount || 0;
    if (commitCount === 0) continue;

    contributedRepos.push({
      nameWithOwner: repo.nameWithOwner,
      commitCount,
    });

    for (const edge of repo.languages?.edges || []) {
      const langName = edge.node.name;
      if (excludedLanguages.has(langName)) continue;
      const prev = languageMap.get(langName) || {
        name: langName,
        color: edge.node.color || '#8b949e',
        size: 0,
      };
      prev.size += edge.size;
      languageMap.set(langName, prev);
    }

    for (const c of history?.nodes || []) {
      allRecentCommits.push({
        repo: repo.nameWithOwner,
        oid: c.oid,
        committedDate: c.committedDate,
        primaryLang: repo.primaryLanguage?.name || null,
        primaryColor: repo.primaryLanguage?.color || '#8b949e',
      });
    }
  }

  allRecentCommits.sort((a, b) => new Date(b.committedDate) - new Date(a.committedDate));
  const recentCommits = allRecentCommits.slice(0, 200);

  console.log('Analyzing recent commit patches for coding habits...');
  let spaceLines = 0;
  let tabLines = 0;
  let totalAddedChars = 0;
  let totalAddedLines = 0;

  const sampleCommits = recentCommits.slice(0, 25);
  const patchResults = await Promise.all(
    sampleCommits.map((c) => githubREST(`/repos/${c.repo}/commits/${c.oid}`))
  );

  for (const detail of patchResults) {
    if (!detail || !Array.isArray(detail.files)) continue;
    for (const file of detail.files) {
      if (!file.patch) continue;
      const lines = file.patch.split('\n');
      for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          const content = line.slice(1);
          const trimmed = content.trim();
          if (trimmed.length > 0) {
            totalAddedChars += trimmed.length;
            totalAddedLines += 1;
            if (content.startsWith('\t')) {
              tabLines += 1;
            } else if (content.startsWith('  ')) {
              spaceLines += 1;
            }
          }
        }
      }
    }
  }

  const languages = Array.from(languageMap.values()).sort((a, b) => b.size - a.size);

  return {
    contributedReposCount: contributedRepos.length,
    languages,
    totalLanguagesCount: languageMap.size,
    recentCommits,
    patchStats: {
      usesSpaces: spaceLines >= tabLines,
      avgCharsPerLine: totalAddedLines > 0 ? (totalAddedChars / totalAddedLines).toFixed(1) : '38.4',
    },
  };
}

// ---------------------------------------------------------------------------
// 3. Fetch RSS Blog Posts
// ---------------------------------------------------------------------------
async function fetchBlogPosts() {
  console.log(`Fetching RSS feed from ${RSS_URL}...`);
  try {
    const res = await fetch(RSS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const titleMatch =
        block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
        block.match(/<title>([\s\S]*?)<\/title>/);
      const descMatch =
        block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
        block.match(/<description>([\s\S]*?)<\/description>/);
      const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
      const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const categoryMatch = block.match(/<category>([\s\S]*?)<\/category>/);

      const rawLink = (linkMatch ? linkMatch[1].trim() : '').replace(
        'https://www.niklas-buse.de//',
        'https://www.niklas-buse.de/'
      );

      items.push({
        title: titleMatch ? titleMatch[1].trim() : 'Unbenannter Beitrag',
        description: descMatch ? descMatch[1].trim() : '',
        link: rawLink,
        pubDate: pubDateMatch ? new Date(pubDateMatch[1].trim()) : new Date(),
        category: categoryMatch ? categoryMatch[1].trim() : '',
      });
    }
    return items.slice(0, 4);
  } catch (e) {
    console.warn('Failed to fetch RSS feed:', e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. Shared CSS for Classic lowlighter/metrics Look (Dark/Light Adaptive)
// ---------------------------------------------------------------------------
const SHARED_CSS = `
  svg {
    font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif, Apple Color Emoji, Segoe UI Emoji;
    font-size: 14px;
    color: #8b949e;
  }
  h1, h2, h3 {
    margin: 8px 0 2px;
    padding: 0;
    color: #2f81f7;
    font-weight: 400;
  }
  h1 {
    font-size: 20px;
    font-weight: 700;
  }
  h2 {
    font-size: 16px;
  }
  h3 {
    font-size: 14px;
  }
  h1 svg, h2 svg, h3 svg {
    fill: currentColor;
  }
  section > .field {
    margin-left: 5px;
    margin-right: 5px;
  }
  .field {
    display: flex;
    align-items: center;
    margin-bottom: 2px;
    white-space: nowrap;
  }
  .field.wrap, .row {
    flex-wrap: wrap;
  }
  .field svg {
    margin: 0 8px;
    fill: #8b949e;
    flex-shrink: 0;
  }
  .row {
    display: flex;
  }
  .row section {
    flex: 1 1 0;
  }
  .column {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .fill-width, #metrics-end {
    width: 100%;
  }
  .avatar {
    border-radius: 50%;
    margin: 0 6px;
  }
  .calendar.field {
    margin: 4px 0 4px 7px;
  }
  .calendar .day {
    outline: 1px solid rgba(27, 31, 35, 0.04);
    outline-offset: -1px;
  }
  svg.bar {
    margin: 4px 0;
  }
  .field.language {
    margin: 0 8px;
    flex-grow: 0;
  }
  .field.language.details, .field.language.details small {
    display: flex;
    justify-content: space-between;
  }
  .field.language.details small {
    color: #8b949e;
    text-align: right;
  }
  .field.language.details > *, .field.language.details small > * {
    flex: 1 1 0;
  }
  .field.language.details small > :not(:last-child) {
    margin-right: 6px;
  }
  .h-details {
    margin: 0 4px;
    padding-top: 4px;
    font-size: 0.8rem;
    color: #8b949e;
  }
  .chart {
    padding: 0 8px;
  }
  .chart-bars {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    width: 100%;
    margin: 8px 0 4px;
    flex-grow: 1;
    min-height: 72px;
  }
  .chart-bars .entry {
    flex-grow: 1;
    font-size: 10px;
    color: #8b949e;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .chart-bars .entry .value {
    font-size: 8px;
    margin-bottom: 2px;
    min-height: 10px;
  }
  .chart-bars .bar {
    width: 7px;
    background-color: var(--color-calendar-graph-day-bg);
    border: 1px solid var(--color-calendar-graph-day-border);
    border-radius: 5px;
  }
  .chart-bars.horizontal {
    flex-direction: column;
    height: 100%;
    justify-content: center;
  }
  .chart-bars.horizontal .entry {
    align-items: center;
    flex-direction: row;
    width: 100%;
    min-height: 1.25rem;
  }
  .chart-bars.horizontal .entry .name {
    flex-shrink: 0;
    text-align: right;
    width: 34%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chart-bars.horizontal .bar {
    height: 7px;
    width: auto;
    margin: 0 6px;
  }
  .habits .facts {
    margin: 4px 0 0;
    list-style-type: none;
    padding-left: 18px;
  }
  .habits .facts li {
    margin-bottom: 5px;
    display: flex;
    align-items: center;
  }
  .habits .facts li::before {
    content: "•";
    color: #2f81f7;
    font-weight: bold;
    display: inline-block;
    width: 14px;
  }
  code {
    background-color: rgba(139, 148, 158, 0.15);
    display: inline-block;
    border-radius: 6px;
    padding: 1px 5px;
    margin: 0 3px;
    font-size: 85%;
    color: #8b949e;
    font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
  }
  .rss-item {
    display: flex;
    align-items: flex-start;
    padding: 2px 5px;
    margin: 0;
  }
  .rss-item svg {
    margin: 3px 8px 0 3px;
    fill: #8b949e;
    flex-shrink: 0;
  }
  .rss-item .infos {
    flex: 1;
    min-width: 0;
  }
  .rss-item .title {
    font-weight: 500;
    font-size: 14px;
    color: #2f81f7;
    line-height: 1.3;
  }
  .rss-item .meta {
    font-size: 12px;
    color: #8b949e;
    margin-top: 2px;
    line-height: 1.3;
  }
  :root {
    --color-calendar-graph-day-bg: rgba(139, 148, 158, 0.18);
    --color-calendar-graph-day-border: rgba(139, 148, 158, 0.12);
    --color-calendar-graph-day-L1-bg: #0e4429;
    --color-calendar-graph-day-L2-bg: #006d32;
    --color-calendar-graph-day-L3-bg: #26a641;
    --color-calendar-graph-day-L4-bg: #39d353;
  }
`;

function wrapSvg(width, height, innerHtml) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="">
    <defs><style/></defs>
    <style>${SHARED_CSS}</style>
    <foreignObject x="0" y="0" width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" class="items-wrapper">
${innerHtml}
        </div>
        <div xmlns="http://www.w3.org/1999/xhtml" id="metrics-end"></div>
    </foreignObject>
</svg>`;
}

// ---------------------------------------------------------------------------
// 5. Render SVG 1: Base (Header + Calendar + Activity)
// ---------------------------------------------------------------------------
function renderBaseSvg(user, repoCount) {
  const joinedYears = Math.max(
    1,
    Math.floor((Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24 * 365.25))
  );

  const calendarRects = user.last14Days
    .map((day, i) => {
      const count = day.contributionCount || 0;
      let color = 'rgba(139, 148, 158, 0.18)';
      if (count >= 10) color = '#39d353';
      else if (count >= 5) color = '#26a641';
      else if (count >= 2) color = '#006d32';
      else if (count >= 1) color = '#0e4429';
      return `<rect class="day" x="${i * 15}" y="0" width="11" height="11" fill="${color}" rx="2" ry="2"/>`;
    })
    .join('\n                                    ');

  const avatarImg = user.avatarBase64
    ? `<img class="avatar" src="${user.avatarBase64}" width="20" height="20" />`
    : '';

  const html = `            <section>
                <h1 class="field">
                    ${avatarImg}
                    <span>${escapeXml(user.name)}</span>
                </h1>
                <div class="row">
                    <section>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 0a8 8 0 100 16A8 8 0 008 0zm.5 4.75a.75.75 0 00-1.5 0v3.5a.75.75 0 00.471.696l2.5 1a.75.75 0 00.557-1.392L8.5 7.742V4.75z"/>
                            </svg>
                            Joined GitHub ${joinedYears} years ago
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M5.5 3.5a2 2 0 100 4 2 2 0 000-4zM2 5.5a3.5 3.5 0 115.898 2.549 5.507 5.507 0 013.034 4.084.75.75 0 11-1.482.235 4.001 4.001 0 00-7.9 0 .75.75 0 01-1.482-.236A5.507 5.507 0 013.102 8.05 3.49 3.49 0 012 5.5zM11 4a.75.75 0 100 1.5 1.5 1.5 0 01.666 2.844.75.75 0 00-.416.672v.352a.75.75 0 00.574.73c1.2.289 2.162 1.2 2.522 2.372a.75.75 0 101.434-.44 5.01 5.01 0 00-2.56-3.012A3 3 0 0011 4z"/>
                            </svg>
                            Followed by ${user.followers} users
                        </div>
                    </section>
                    <section>
                        <div class="field calendar">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 11" width="210" height="16">
                                <g>
                                    ${calendarRects}
                                </g>
                            </svg>
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M1 2.5A2.5 2.5 0 013.5 0h8.75a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0V1.5h-8a1 1 0 00-1 1v6.708A2.492 2.492 0 013.5 9h3.25a.75.75 0 010 1.5H3.5a1 1 0 100 2h5.75a.75.75 0 010 1.5H3.5A2.5 2.5 0 011 11.5v-9zm13.23 7.79a.75.75 0 001.06-1.06l-2.505-2.505a.75.75 0 00-1.06 0L9.22 9.229a.75.75 0 001.06 1.061l1.225-1.224v6.184a.75.75 0 001.5 0V9.066l1.224 1.224z"/>
                            </svg>
                            Contributed to ${repoCount} repositories
                        </div>
                    </section>
                </div>
            </section>
            <section class="largeable largeable-inline-flex">
                <div class="row">
                    <section>
                        <h2 class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M1.5 1.75a.75.75 0 00-1.5 0v12.5c0 .414.336.75.75.75h14.5a.75.75 0 000-1.5H1.5V1.75zm14.28 2.53a.75.75 0 00-1.06-1.06L10 7.94 7.53 5.47a.75.75 0 00-1.06 0L3.22 8.72a.75.75 0 001.06 1.06L7 7.06l2.47 2.47a.75.75 0 001.06 0l5.25-5.25z"/>
                            </svg>
                            Activity
                        </h2>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z"/>
                            </svg>
                            ${user.totalCommits} Commits
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M2.5 1.75a.25.25 0 01.25-.25h8.5a.25.25 0 01.25.25v7.736a.75.75 0 101.5 0V1.75A1.75 1.75 0 0011.25 0h-8.5A1.75 1.75 0 001 1.75v11.5c0 .966.784 1.75 1.75 1.75h3.17a.75.75 0 000-1.5H2.75a.25.25 0 01-.25-.25V1.75zM4.75 4a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5zM4 7.75A.75.75 0 014.75 7h2a.75.75 0 010 1.5h-2A.75.75 0 014 7.75zm11.774 3.537a.75.75 0 00-1.048-1.074L10.7 14.145 9.281 12.72a.75.75 0 00-1.062 1.058l1.943 1.95a.75.75 0 001.055.008l4.557-4.45z"/>
                            </svg>
                            ${user.totalReviews} Pull requests reviewed
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"/>
                            </svg>
                            ${user.pullRequests} Pull requests opened
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path d="M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
                                <path fill-rule="evenodd" d="M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z"/>
                            </svg>
                            ${user.issues} Issues opened
                        </div>
                        <div class="field">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                <path fill-rule="evenodd" d="M2.75 2.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 01.75.75v2.19l2.72-2.72a.75.75 0 01.53-.22h4.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75zM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.457 1.457 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5z"/>
                            </svg>
                            ${user.issueComments} issue comments
                        </div>
                    </section>
                </div>
            </section>`;

  return wrapSvg(480, 223, html);
}

// ---------------------------------------------------------------------------
// 6. Render SVG 2: Languages (Top 8 across Personal, Private & Org Repos)
// ---------------------------------------------------------------------------
function renderLanguagesSvg(languages, totalLanguagesCount) {
  const topLangs = languages.slice(0, 8);
  const totalTopSize = topLangs.reduce((acc, l) => acc + l.size, 0) || 1;
  const barWidth = 460;

  let currentX = 0;
  const barRects = topLangs
    .map((lang, idx) => {
      const w =
        idx === topLangs.length - 1
          ? Math.max(0, barWidth - currentX)
          : (lang.size / totalTopSize) * barWidth;
      const rect = `<rect mask="url(#languages-bar)" x="${currentX.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8" fill="${lang.color}"/>`;
      currentX += w;
      return rect;
    })
    .join('\n                    ');

  const leftCol = topLangs.filter((_, i) => i % 2 === 0);
  const rightCol = topLangs.filter((_, i) => i % 2 === 1);

  const renderLangItem = (lang) => {
    const pct = ((lang.size / totalTopSize) * 100).toFixed(2);
    return `                        <div class="field language details">
                            <div class="field">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                                    <path fill="${lang.color}" fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8z"/>
                                </svg>
                                ${escapeXml(lang.name)}
                            </div>
                            <small>
                                <div>${formatBytes(lang.size)}</div>
                                <div>${pct}%</div>
                            </small>
                        </div>`;
  };

  const html = `            <section>
                <h2 class="field">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill-rule="evenodd" d="M1.5 2.75a.25.25 0 01.25-.25h12.5a.25.25 0 01.25.25v8.5a.25.25 0 01-.25.25h-6.5a.75.75 0 00-.53.22L4.5 14.44v-2.19a.75.75 0 00-.75-.75h-2a.25.25 0 01-.25-.25v-8.5zM1.75 1A1.75 1.75 0 000 2.75v8.5C0 12.216.784 13 1.75 13H3v1.543a1.457 1.457 0 002.487 1.03L8.061 13h6.189A1.75 1.75 0 0016 11.25v-8.5A1.75 1.75 0 0014.25 1H1.75zm5.03 3.47a.75.75 0 010 1.06L5.31 7l1.47 1.47a.75.75 0 01-1.06 1.06l-2-2a.75.75 0 010-1.06l2-2a.75.75 0 011.06 0zm2.44 0a.75.75 0 000 1.06L10.69 7 9.22 8.47a.75.75 0 001.06 1.06l2-2a.75.75 0 000-1.06l-2-2a.75.75 0 00-1.06 0z"/>
                    </svg>
                    ${totalLanguagesCount} Languages
                </h2>
            </section>
            <section class="column">
                <h3 class="field">Most used languages</h3>
                <svg class="bar" xmlns="http://www.w3.org/2000/svg" width="${barWidth}" height="8">
                    <mask id="languages-bar">
                        <rect x="0" y="0" width="${barWidth}" height="8" fill="white" rx="5"/>
                    </mask>
                    <rect mask="url(#languages-bar)" x="0" y="0" width="0" height="8" fill="#d1d5da"/>
                    ${barRects}
                </svg>
                <div class="row fill-width">
                    <section>
${leftCol.map(renderLangItem).join('\n')}
                    </section>
                    <section>
${rightCol.map(renderLangItem).join('\n')}
                    </section>
                </div>
            </section>`;

  return wrapSvg(480, 175, html);
}

// ---------------------------------------------------------------------------
// 7. Compute Coding Habits Data & Render SVG 3 (Charts) + SVG 4 (Facts)
// ---------------------------------------------------------------------------
function analyzeHabits(recentCommits, patchStats) {
  const hours = new Array(24).fill(0);
  const days = new Array(7).fill(0);
  const recentLangCounts = new Map();

  const hourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  });
  const weekdayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
  });

  const dayNamesShort = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayNamesFull = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  for (const c of recentCommits) {
    const d = new Date(c.committedDate);
    const h = parseInt(hourFmt.format(d), 10) % 24;
    const wShort = weekdayFmt.format(d);
    const dayIdx = dayNamesShort.indexOf(wShort);

    if (!Number.isNaN(h)) hours[h] += 1;
    if (dayIdx !== -1) days[dayIdx] += 1;

    if (c.primaryLang) {
      recentLangCounts.set(c.primaryLang, (recentLangCounts.get(c.primaryLang) || 0) + 1);
    }
  }

  const langActivityEntries = Array.from(recentLangCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const totalLangCommits = langActivityEntries.reduce((acc, [, v]) => acc + v, 0) || 1;

  let peakHour = 0;
  for (let i = 1; i < 24; i++) {
    if (hours[i] > hours[peakHour]) peakHour = i;
  }

  let peakDay = 0;
  for (let i = 1; i < 7; i++) {
    if (days[i] > days[peakDay]) peakDay = i;
  }

  return {
    commitSampleSize: recentCommits.length,
    hours,
    days,
    dayNamesShort,
    peakHourStr: `${String(peakHour).padStart(2, '0')}:00`,
    peakDayStr: dayNamesFull[peakDay],
    langActivity: langActivityEntries.map(([name, count]) => ({
      name,
      pct: Math.round((count / totalLangCommits) * 100),
    })),
    usesSpaces: patchStats.usesSpaces,
    avgCharsPerLine: patchStats.avgCharsPerLine,
  };
}

function barLevelClass(val, maxVal) {
  if (!val || maxVal === 0) return 'var(--color-calendar-graph-day-bg)';
  const ratio = val / maxVal;
  if (ratio >= 0.75) return 'var(--color-calendar-graph-day-L4-bg)';
  if (ratio >= 0.5) return 'var(--color-calendar-graph-day-L3-bg)';
  if (ratio >= 0.25) return 'var(--color-calendar-graph-day-L2-bg)';
  return 'var(--color-calendar-graph-day-L1-bg)';
}

function renderHabitsChartsSvg(habits) {
  const maxHour = Math.max(...habits.hours, 1);
  const maxDay = Math.max(...habits.days, 1);

  const hourBars = habits.hours
    .map((val, h) => {
      const heightPx = val > 0 ? Math.max(6, Math.round((val / maxHour) * 50)) : 4;
      const bg = barLevelClass(val, maxHour);
      return `                        <div class="entry">
                            <span class="value">${val > 0 ? val : ''}</span>
                            <div class="bar" style="height: ${heightPx}px; background-color: ${bg}"></div>
                            ${String(h).padStart(2, '0')}
                        </div>`;
    })
    .join('\n');

  const dayBars = habits.days
    .map((val, d) => {
      const heightPx = val > 0 ? Math.max(6, Math.round((val / maxDay) * 50)) : 4;
      const bg = barLevelClass(val, maxDay);
      return `                            <div class="entry">
                                <span class="value">${val > 0 ? val : ''}</span>
                                <div class="bar" style="height: ${heightPx}px; background-color: ${bg}"></div>
                                ${habits.dayNamesShort[d]}
                            </div>`;
    })
    .join('\n');

  const langBars = habits.langActivity
    .map((item) => {
      const bg = barLevelClass(item.pct, 100);
      const widthPct = Math.max(6, Math.round(item.pct * 0.5));
      return `                            <div class="entry">
                                <span class="name">${escapeXml(item.name)}</span>
                                <div class="bar" style="width: ${widthPct}%; background-color: ${bg}"></div>
                                <span class="value">${item.pct}%</span>
                            </div>`;
    })
    .join('\n');

  const html = `            <section class="habits">
                <h2 class="field wrap">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill-rule="evenodd" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 01-1.484.211c-.04-.282-.163-.547-.37-.847a8.695 8.695 0 00-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.75.75 0 01-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75zM6 15.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75zM5.75 12a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z"/>
                    </svg>
                    Recent coding habits
                    <small class="h-details">(computed from last ${habits.commitSampleSize} commits)</small>
                </h2>
            </section>
            <section class="habits">
                <div class="column chart largeable">
                    <h3>Commit activity per hour of day</h3>
                    <div class="chart-bars">
${hourBars}
                    </div>
                </div>
                <div class="row largeable">
                    <section class="column chart">
                        <h3>Commit activity per day of week</h3>
                        <div class="chart-bars">
${dayBars}
                        </div>
                    </section>
                    <section class="column chart">
                        <h3>Language activity</h3>
                        <div class="chart-bars horizontal">
${langBars}
                        </div>
                    </section>
                </div>
            </section>`;

  return wrapSvg(480, 290, html);
}

function renderHabitsFactsSvg(habits) {
  const topRecentLang = habits.langActivity[0]?.name || 'Kotlin';

  const html = `            <section class="habits">
                <h2 class="field wrap">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill-rule="evenodd" d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 01-1.484.211c-.04-.282-.163-.547-.37-.847a8.695 8.695 0 00-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.75.75 0 01-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75zM6 15.25a.75.75 0 01.75-.75h2.5a.75.75 0 010 1.5h-2.5a.75.75 0 01-.75-.75zM5.75 12a.75.75 0 000 1.5h4.5a.75.75 0 000-1.5h-4.5z"/>
                    </svg>
                    Mildly interesting facts
                    <small class="h-details">(from last ${habits.commitSampleSize} commits)</small>
                </h2>
                <div class="row">
                    <ul class="facts">
                        <li>Uses <code>${habits.usesSpaces ? 'spaces' : 'tabs'}</code> for indentation</li>
                        <li>Has approximately <code>${habits.avgCharsPerLine}</code> characters per line of code written</li>
                        <li>Mostly pushes code around <code>${habits.peakHourStr}</code> (${TIMEZONE})</li>
                        <li>Mostly active on <code>${habits.peakDayStr}</code></li>
                        <li>Recently most active in <code>${escapeXml(topRecentLang)}</code></li>
                    </ul>
                </div>
            </section>`;

  return wrapSvg(480, 155, html);
}

// ---------------------------------------------------------------------------
// 8. Render Clickable Blog Section SVGs (Header + Borderless Vertical Rows)
// ---------------------------------------------------------------------------
function renderBlogHeaderSvg() {
  const html = `            <section>
                <h2 class="field">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                        <path fill-rule="evenodd" d="M2.002 2.725a.75.75 0 01.797-.699C8.79 2.42 13.58 7.21 13.974 13.201a.75.75 0 11-1.497.098 10.502 10.502 0 00-9.776-9.776.75.75 0 01-.7-.798zM2 13a1 1 0 112 0 1 1 0 01-2 0zm.84-5.95a.75.75 0 00-.179 1.489c2.509.3 4.5 2.291 4.8 4.8a.75.75 0 101.49-.178A7.003 7.003 0 002.838 7.05z"/>
                    </svg>
                    Latest blog posts
                </h2>
            </section>`;

  return wrapSvg(980, 34, html);
}

function renderBlogPostCardSvg(post) {
  const dateFmt = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const dateStr = dateFmt.format(post.pubDate);
  const catBadge = post.category ? ` · <code>${escapeXml(post.category)}</code>` : '';

  const html = `            <div class="rss-item" style="padding: 6px 5px;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
                    <path fill-rule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"/>
                </svg>
                <div class="infos">
                    <div class="title">${escapeXml(post.title)}</div>
                    <div class="meta">${escapeXml(dateStr)}${catBadge}</div>
                </div>
            </div>`;

  return wrapSvg(980, 56, html);
}

// ---------------------------------------------------------------------------
// 9. Update README.md
// ---------------------------------------------------------------------------
function generateReadme(posts) {
  const clickablePostRows = posts
    .slice(0, 3)
    .map(
      (post, idx) =>
        `  <a href="${post.link}"><img width="99%" alt="${escapeXml(post.title)}" src="./metrics/blog.post-${idx + 1}.svg" /></a>`
    )
    .join('\n  <br/>\n');

  return `### Hey 👋

Hier ist mein Ort, wo ich meine Projekte veröffentliche oder das ein oder andere mal zerstöre xD

<p align="left">
  <img align="top" width="49%" alt="GitHub Activity & Base Metrics" src="./metrics/base.svg" />
  <img align="top" width="49%" alt="Most Used Languages" src="./metrics/languages.svg" />
</p>

<p align="left">
  <img align="top" width="49%" alt="Coding Habits Charts" src="./metrics/habits.charts.svg" />
  <img align="top" width="49%" alt="Coding Habits Facts" src="./metrics/habits.facts.svg" />
</p>

<p align="left">
  <a href="https://www.niklas-buse.de/blog"><img width="99%" alt="Latest blog posts" src="./metrics/blog.header.svg" /></a>
  <br/>
${clickablePostRows}
</p>
`;
}

// ---------------------------------------------------------------------------
// Main Execution
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const user = await fetchUserData();
  const repoData = await fetchRepositoriesAndCommits(user.id);
  const habits = analyzeHabits(repoData.recentCommits, repoData.patchStats);
  const blogPosts = await fetchBlogPosts();

  console.log('Rendering SVGs...');
  fs.writeFileSync(
    path.join(OUT_DIR, 'base.svg'),
    renderBaseSvg(user, repoData.contributedReposCount),
    'utf8'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'languages.svg'),
    renderLanguagesSvg(repoData.languages, repoData.totalLanguagesCount),
    'utf8'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'habits.charts.svg'),
    renderHabitsChartsSvg(habits),
    'utf8'
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'habits.facts.svg'),
    renderHabitsFactsSvg(habits),
    'utf8'
  );
  fs.writeFileSync(path.join(OUT_DIR, 'blog.header.svg'), renderBlogHeaderSvg(), 'utf8');

  // Remove old blog.svg or stale blog.post-*.svg files
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file === 'blog.svg' || file.startsWith('blog.post-')) {
      fs.unlinkSync(path.join(OUT_DIR, file));
    }
  }

  blogPosts.slice(0, 4).forEach((post, idx) => {
    fs.writeFileSync(
      path.join(OUT_DIR, `blog.post-${idx + 1}.svg`),
      renderBlogPostCardSvg(post),
      'utf8'
    );
  });

  console.log('Updating README.md...');
  const readmePath = path.resolve(process.cwd(), 'README.md');
  fs.writeFileSync(readmePath, generateReadme(blogPosts), 'utf8');

  console.log('Done! Generated files in ./metrics/ and updated README.md.');
}

main().catch((err) => {
  console.error('Fatal error generating profile metrics:', err);
  process.exit(1);
});
