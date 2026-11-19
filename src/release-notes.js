// Template-based release-notes generator — PURE logic, NO LLM.
// Groups Done issues by type and renders Markdown (for the UI) or ADF
// (Atlassian Document Format, for creating a Confluence page via REST).
const DONE_STATUSES = new Set(['Done', 'Closed', 'Resolved']);

/** Split Done issues into features / fixes / other. Non-Done issues are excluded. */
export function groupIssuesByType(issues) {
  const groups = { features: [], fixes: [], other: [] };
  for (const issue of issues ?? []) {
    if (!DONE_STATUSES.has(issue.status)) continue;
    if (issue.type === 'Story' || issue.type === 'Epic' || issue.type === 'Feature') {
      groups.features.push(issue);
    } else if (issue.type === 'Bug') {
      groups.fixes.push(issue);
    } else {
      groups.other.push(issue);
    }
  }
  return groups;
}

function renderMarkdown(version, groups) {
  const lines = [`# Release Notes — ${version}`, ''];
  const sections = [
    ['Features', groups.features],
    ['Bug Fixes', groups.fixes],
    ['Other Changes', groups.other],
  ];
  let any = false;
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    any = true;
    lines.push(`## ${title}`, '');
    for (const i of items) lines.push(`- ${i.key}: ${i.summary}`);
    lines.push('');
  }
  if (!any) lines.push('No changes shipped in this release.', '');
  return lines.join('\n');
}

function renderAdf(version, groups) {
  const content = [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: `Release Notes — ${version}` }] },
  ];
  const sections = [
    ['Features', groups.features],
    ['Bug Fixes', groups.fixes],
    ['Other Changes', groups.other],
  ];
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: title }] });
    content.push({
      type: 'bulletList',
      content: items.map((i) => ({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `${i.key}: ${i.summary}` }] }],
      })),
    });
  }
  if (!content.some((n) => n.type === 'bulletList')) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: 'No changes shipped in this release.' }] });
  }
  return JSON.stringify({ type: 'doc', version: 1, content }, null, 2);
}

/** @param {object} opts { version:string, issues:[], format:'markdown'|'adf' } */
export function generateReleaseNotes({ version, issues, format = 'markdown' }) {
  if (!version) throw new Error('generateReleaseNotes: version is required');
  const groups = groupIssuesByType(issues);
  if (format === 'markdown') return renderMarkdown(version, groups);
  if (format === 'adf') return renderAdf(version, groups);
  throw new Error(`generateReleaseNotes: unsupported format "${format}" (use "markdown" or "adf")`);
}
