/**
 * Which messages a native speaker reads first (docs/translating.md, "A native speaker's read").
 *
 * Tier 1 is what most people see most, and what customers see: the frame, signing in, the issue
 * list, an issue's page with its comments and history, the inbox and its emails, boards' basics,
 * and the help desk's portal, form, tracking page and emails. It's sized to an hour, counted in
 * words, since a message is one word or forty: 600 messages of the catalog's average length (7.5
 * English words) is 4,500 words, so a reader comparing English with their language reads about
 * 75 English words a minute (READING_PACE). Tier 1's messages are short, so it holds more of them.
 * Tier 2 is the rest of the everyday pages; tier 3, administration, the importers, and the
 * problems people rarely meet.
 *
 * A key's place comes from its prefix, never from a list of keys, so a key added later lands where
 * its neighbours are: the longest prefix below that the key starts with (segment by segment) wins,
 * else its first segment's, else tier 2. A prefix is a component's (`issues.issueHistory` is
 * IssueHistory.tsx's) or the server's place for a kind of email, so a prefix's pieces, which a page
 * joins, are read together, as docs/translating.md asks.
 */

/** Areas in the order a reader meets them: the sheet sorts by tier, then by this order, then by key. */
export const AREAS = [
  // Tier 1: what most people see most, and what customers see.
  { tier: 1, where: 'Menus and frame', prefixes: ['app.shell', 'ui', 'common', 'api.client', 'loadingLine.plain', 'loadingLine.named'] },
  { tier: 1, where: 'Signing in', prefixes: ['app.auth'] },
  { tier: 1, where: 'Issue list', prefixes: ['page.issues', 'issues.issueList', 'issues.queryBar', 'server.query', 'count.issues', 'loadingLine.issues'] },
  { tier: 1, where: 'Issue page', prefixes: ['page.issue', 'issues.fieldPanel', 'issues.api', 'workflow.workflowBar', 'loadingLine.issue', 'loadingLine.fields'] },
  { tier: 1, where: 'Comments and history', prefixes: ['issues.issueHistory', 'editor.richField', 'issues.mentionField', 'boards.history', 'server.access', 'loadingLine.history'] },
  { tier: 1, where: 'Inbox', prefixes: ['page.inbox', 'loadingLine.inbox'] },
  { tier: 1, where: 'Notification emails', prefixes: ['server.notify', 'server.mail'] },
  { tier: 1, where: 'Boards', prefixes: ['page.boards', 'page.board', 'loadingLine.boards', 'loadingLine.board'] },
  { tier: 1, where: 'Portal', prefixes: ['page.portal', 'loadingLine.yourRequests', 'loadingLine.request'] },
  { tier: 1, where: 'Help form', prefixes: ['page.help', 'helpdesk.pow', 'loadingLine.form'] },
  { tier: 1, where: 'Tracking page', prefixes: ['page.track', 'loadingLine.yourRequest'] },
  { tier: 1, where: 'Help desk emails', prefixes: ['server.helpdesk', 'server.portal', 'server.portalAccount', 'server.portalPasskeys', 'server.portalPassword'] },

  // Tier 2: the rest of the everyday pages.
  { tier: 2, where: 'Issue page', prefixes: ['page.issue.source', 'issues', 'attachments', 'vcs.issueCode', 'vcs.why', 'vcs.note', 'builds.note', 'server.command', 'loadingLine.files', 'loadingLine.issueCommits'] },
  { tier: 2, where: 'New issue', prefixes: ['page.newIssue'] },
  { tier: 2, where: 'Editor and writing help', prefixes: ['editor', 'writing'] },
  { tier: 2, where: 'Digest email', prefixes: ['server.mail.digest'] },
  { tier: 2, where: 'Stopping emails', prefixes: ['page.unsubscribe'] },
  { tier: 2, where: 'Boards', prefixes: ['board', 'page.sprintPlanning', 'loadingLine.backlog'] },
  { tier: 2, where: 'Portal', prefixes: ['helpdesk.portalPasskeys', 'page.notMe', 'loadingLine.passkeys'] },
  { tier: 2, where: 'Help desk requests', prefixes: ['helpdesk.requestCard', 'helpdesk.requestCcs', 'count.days', 'count.hours', 'count.minutes'] },
  { tier: 2, where: 'Plan', prefixes: ['plan', 'page.plan', 'count.openIssues', 'loadingLine.plan', 'loadingLine.levelling', 'loadingLine.whatIf', 'loadingLine.booked', 'loadingLine.costs', 'loadingLine.baselines'] },
  { tier: 2, where: 'Reports', prefixes: ['reports', 'page.reports', 'count.workingDays', 'loadingLine.report'] },
  { tier: 2, where: 'Dashboard', prefixes: ['page.dashboard', 'loadingLine.yourDashboard', 'loadingLine.yourDashboards'] },
  { tier: 2, where: 'Timesheet and days away', prefixes: ['page.timesheet', 'away', 'loadingLine.timesheet', 'loadingLine.daysAway'] },
  { tier: 2, where: 'Whiteboards', prefixes: ['whiteboards', 'page.whiteboard', 'page.whiteboards', 'loadingLine.whiteboard', 'loadingLine.whiteboards'] },
  { tier: 2, where: 'Knowledge base', prefixes: ['articles', 'page.articles', 'loadingLine.articles', 'loadingLine.articleHistory', 'loadingLine.version'] },
  { tier: 2, where: 'Assistant and suggestions', prefixes: ['assistant', 'page.assistant', 'decide', 'page.suggestions', 'loadingLine.conversations', 'loadingLine.suggestions', 'loadingLine.suggestionIssues'] },
  { tier: 2, where: 'Profile', prefixes: ['page.profile', 'identity.passkeys', 'identity.twoFactor', 'notifications', 'page.passkeySetup', 'page.confirmEmail', 'server.emails', 'server.passkeys', 'server.passkeySetup', 'loadingLine.profile', 'loadingLine.twoFactor', 'loadingLine.emailSettings', 'loadingLine.pushSettings', 'loadingLine.yourSubscription', 'loadingLine.yourSubscriptions', 'loadingLine.link'] },
  { tier: 2, where: 'Projects', prefixes: ['page.projects', 'page.project', 'roles.builtin', 'loadingLine.project', 'loadingLine.projects'] },
  { tier: 2, where: 'Activity', prefixes: ['page.activity', 'activity', 'loadingLine.activity'] },
  { tier: 2, where: 'Chat', prefixes: ['server.chat', 'page.chatLink', 'loadingLine.chat', 'loadingLine.subscriptions'] },
  { tier: 2, where: 'Public pages', prefixes: ['page.guestPages'] },
  { tier: 2, where: 'Connecting an app', prefixes: ['page.oAuthConsent', 'apps.appFrame', 'apps.appWidgets', 'apps.api', 'loadingLine.appRequest', 'loadingLine.yourProjects', 'loadingLine.app'] },
  {
    tier: 2,
    where: 'Errors',
    prefixes: [
      'problem.notFound', 'problem.forbidden', 'problem.unauthorized', 'problem.validationFailed', 'problem.tooLarge', 'problem.rateLimited',
      'problem.wrongLogin', 'problem.signIn', 'problem.tooManySignIns', 'problem.passwordLoginOff', 'problem.query', 'problem.command',
      'problem.issues', 'problem.comments', 'problem.attachments', 'problem.links', 'problem.tags', 'problem.values', 'problem.votes',
      'problem.portal', 'problem.portalSignIn', 'problem.boards', 'problem.agile', 'problem.time', 'problem.workItems', 'problem.visibility',
    ],
  },

  // Tier 3: administration, the importers, and problems people rarely meet.
  { tier: 3, where: 'Administration', prefixes: ['page.admin', 'count.people', 'loadingLine.people', 'loadingLine.settings'] },
  { tier: 3, where: 'Fields', prefixes: ['page.fields', 'projects.projectFields', 'loadingLine.projectFields', 'loadingLine.projectOwnFields'] },
  { tier: 3, where: 'Project settings', prefixes: ['projects', 'loadingLine.projectPeople'] },
  { tier: 3, where: 'Groups and roles', prefixes: ['groups', 'page.group', 'roles', 'count.groups', 'count.roles', 'loadingLine.group', 'loadingLine.groups', 'loadingLine.projectGroups', 'loadingLine.roles'] },
  { tier: 3, where: 'Rules', prefixes: ['rules', 'page.rules', 'server.rule', 'loadingLine.rules', 'loadingLine.ruleRuns'] },
  { tier: 3, where: 'Workflows', prefixes: ['workflow', 'loadingLine.actions', 'loadingLine.stateMachines'] },
  { tier: 3, where: 'Help desk settings', prefixes: ['helpdesk', 'loadingLine.deskMail', 'loadingLine.mailIn'] },
  { tier: 3, where: 'Webhooks', prefixes: ['page.webhooks', 'loadingLine.webhooks', 'loadingLine.webhookDeliveries'] },
  { tier: 3, where: 'Integrations', prefixes: ['page.integrations', 'loadingLine.integrations', 'loadingLine.integrationDeliveries'] },
  { tier: 3, where: 'Chat settings', prefixes: ['page.chat', 'chat', 'loadingLine.channels', 'loadingLine.chatAccounts', 'loadingLine.projectChannels'] },
  { tier: 3, where: 'Agents and tokens', prefixes: ['page.agents', 'agents', 'loadingLine.agents', 'loadingLine.tools', 'loadingLine.yourTokens', 'loadingLine.yourApps'] },
  { tier: 3, where: 'Apps', prefixes: ['apps', 'loadingLine.apps', 'loadingLine.appRuns', 'loadingLine.appSettings', 'loadingLine.catalogs', 'loadingLine.projectApps'] },
  { tier: 3, where: 'Builds and version control', prefixes: ['builds', 'page.builds', 'vcs', 'server.checks', 'loadingLine.buildSources', 'loadingLine.projectBuilds', 'loadingLine.theirEmails', 'loadingLine.theirLogins', 'loadingLine.yourEmails'] },
  { tier: 3, where: 'Provisioning', prefixes: ['identity', 'loadingLine.scimTokens'] },
  { tier: 3, where: 'Importers', prefixes: ['page.import', 'imports', 'count', 'loadingLine.import'] },
  { tier: 3, where: 'Errors', prefixes: ['problem'] },
];

/** Where a key nobody placed goes: tier 2, the everyday pages, under its first segment's name. */
const FALLBACK = { tier: 2, where: 'Other pages' };

/** English words a minute, read beside their translation: the pace of 600 average messages an hour. */
export const READING_PACE = 75;

/**
 * Tier 1's most: about an hour at that pace (4,800 words when this was set), with room for keys
 * added later under tier 1's prefixes. A test holds tier 1 to it, so tier 1 can't grow unseen.
 */
export const TIER_ONE_BUDGET = { messages: 850, words: 5200 };

const order = new Map(AREAS.map((a, i) => [a, i]));
const byPrefix = new Map();
for (const area of AREAS) {
  for (const p of area.prefixes) {
    if (byPrefix.has(p)) throw new Error(`tiers: ${p} is placed twice`);
    byPrefix.set(p, area);
  }
}

/** A key's tier, where it shows (a short name a reader knows), and its area's place in the order. */
export function tierOf(key) {
  const parts = key.split('.');
  for (let n = parts.length; n > 0; n--) {
    const area = byPrefix.get(parts.slice(0, n).join('.'));
    if (area) return { tier: area.tier, where: area.where, rank: order.get(area) };
  }
  return { ...FALLBACK, rank: AREAS.length };
}

/** English's words in a message, as a reader counts them: a placeholder is one. */
export const wordsIn = (source) => source.replace(/\{[^{}]*\}/g, ' x ').split(/\s+/).filter(Boolean).length;
