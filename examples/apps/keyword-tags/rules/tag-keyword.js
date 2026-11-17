// A new issue whose summary says the project's keyword gets the app's tag.
const word = String(settings.keyword || '').trim().toLowerCase();
if (word && issue.summary.toLowerCase().includes(word)) {
  apply(`tag ${settings.tag || 'needs-triage'}`);
  log(`"${word}" is in the summary`);
}
