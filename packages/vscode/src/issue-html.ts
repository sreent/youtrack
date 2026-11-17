/**
 * An issue as the extension's webview draws it: Ocean's stylesheet (no CSS of the extension's own),
 * loaded from the extension's files, under a policy that lets nothing else in. The words are
 * escaped; the one script, with its nonce, only sends a command back to the extension.
 */
import type { IssueFull } from './a4a';

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function value(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.map(value).join(', ');
  if (typeof v === 'object') return String((v as { name?: unknown; login?: unknown }).name ?? (v as { login?: unknown }).login ?? JSON.stringify(v));
  return String(v);
}

export interface WebviewParts {
  /** The webview's own source, for the policy (webview.cspSource). */
  cspSource: string;
  /** Ocean's stylesheets, as the webview can load them (webview.asWebviewUri). */
  styles: string[];
  nonce: string;
}

export function issueHtml(issue: IssueFull, parts: WebviewParts): string {
  const csp = [`default-src 'none'`, `style-src ${parts.cspSource}`, `font-src ${parts.cspSource}`, `img-src ${parts.cspSource} https:`, `script-src 'nonce-${parts.nonce}'`].join('; ');
  const fields = Object.entries(issue.fields)
    .map(([k, v]) => `<div class="pair"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(value(v))}</dd></div>`)
    .join('');
  const comments = (issue.comments ?? [])
    .map((c) => `<li class="card"><p class="item-about">${escapeHtml(c.by ?? 'someone')}${c.at ? ` · ${escapeHtml(c.at)}` : ''}</p><p class="prose">${escapeHtml(c.text)}</p></li>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
${parts.styles.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join('\n')}
<title>${escapeHtml(issue.id)}</title>
</head>
<body>
<main class="stack">
<div class="page-head"><div class="title-row"><h1><span class="issue-id">${escapeHtml(issue.id)}</span> ${escapeHtml(issue.summary)}</h1></div>
<p class="note">${escapeHtml(issue.project)} · reported by ${escapeHtml(issue.reporter ?? 'someone')} · <a href="${escapeHtml(issue.url)}">open in a4a</a></p></div>
<section class="card"><dl class="facts-list">${fields}</dl>${issue.tags.length ? `<p class="note">Tags: ${issue.tags.map(escapeHtml).join(', ')}</p>` : ''}</section>
<section class="card"><h2>Description</h2><p class="prose">${issue.description ? escapeHtml(issue.description) : '<span class="note">No description yet.</span>'}</p></section>
<section class="card"><h2>A command</h2>
<form class="cluster" id="command"><label class="field inline"><span class="label">Command</span><input name="command" class="mono" placeholder="State Fixed, for me, tag regression" required></label><button type="submit" class="primary">Apply</button></form>
<p class="note" role="status" id="said"></p></section>
${comments ? `<section class="card"><h2>Latest comments</h2><ul class="stack">${comments}</ul></section>` : ''}
</main>
<script nonce="${parts.nonce}">
const vscode = acquireVsCodeApi();
document.getElementById('command').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.elements.command;
  vscode.postMessage({ type: 'command', issue: ${JSON.stringify(issue.id).replace(/</g, '\\u003c')}, text: input.value });
  document.getElementById('said').textContent = 'Applying…';
});
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'said') document.getElementById('said').textContent = e.data.text;
});
</script>
</body>
</html>`;
}
