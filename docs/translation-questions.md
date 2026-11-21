# Questions for native speakers

German, Spanish, French and Japanese were each translated, then read again whole by a reviewer who hadn't written it, working from English, the code and [translating.md](translating.md). That reviewer was a model, not a native speaker. The second reads changed 1,371 messages: 502 in German, 316 in Spanish, 299 in French and 254 in Japanese. The same reviewers then translated the 909 messages added since (the server's problems, `problem.*`, and the messages that replaced English the catalogs couldn't say), and those have had no second read. Then 103 more (what the server words for a page: a rule's preview and runs, a commit's note, why a chat subscription stopped) were written in every language by the developers who added them, then read by the reviewers. Each language that came later says at the head of its section how it was written.

What follows is what the reviewers couldn't settle, by language. Each item names its key, says what the catalog says now, and asks the question.

To settle one, change the message in its catalog and take the item off this page. If it's a term, change it everywhere and put it in the language's terms table in [translating.md](translating.md). `pnpm --filter @a4a/web check:words` checks that every message still parses, with English's placeholders.

## German

Terms:

- **An SLA's resolution** is "Erledigung" (`helpdesk.sla.resolution`), as the terms table has it for resolve and resolution. German ITIL says "Lösungszeit" for the time to resolve.
- **A token's scope** is "Scope" (`problem.access.tokenScope`, `problem.tokens.scopeNeeded`). "Berechtigungsumfang" is the German alternative.
- **A person's login** is "der Login", not "Anmeldename".
- **Earned value**: "Erbracht" (`plan.costs.earned`), "Kosteneffizienz" for CPI and "Termineffizienz" for SPI. German uses more than one set of these terms.
- **The navigation's groups** (`app.shell.work`, `build`, `oversee`) are "Arbeiten", "Einrichten" and "Überwachen". "Überwachen" also holds Administration; "Verwalten" may fit better.
- **A board's swimlanes** are "Bahnen" (`page.board.andLanesBy`). Jira's German says "Swimlanes".
- **The vote button** (`issues.moves.vote`) says "Abstimmen". "Dafür stimmen" may say better what it does.

Phrasing:

- `decide.suggestionCard.sameAs`: "Same as" is "Duplikat von", which assumes the suggestion marks a duplicate.
- `helpdesk.sla.atRiskBefore2`: "At risk before" is "Vorwarnzeit".
- `page.dashboard.aQueryIWrite` is "Eigene Abfrage", and `page.reports.datesIChoose` is "Eigener Zeitraum".
- `assistant.talk.aConversationWithAssistant`: "Eine Unterhaltung mit assistant" keeps the agent's name as it is. If German reads it as a word, it's "mit dem Assistenten".
- `page.profile.yourBrowsersLanguage` and its siblings `theServerS` and `useYourBrowserS`: "Die Ihres Browsers: {name}". `apps/web/e2e/german.spec.ts` looks for these words, so change the spec with them.
- **The query parser's "Unexpected …"** is "Unerwartet: „x“". A compiler would say "Unerwartetes Zeichen „x“".
- **"Status" as a plural** ("Mögliche Status", "zwischen zwei Status") is correct, but some readers take it for a singular.
- `problem.rule.writeScript`: "Schreiben Sie in JavaScript, was es tut." "es" is the script; "was sie tut" would be the rule.
- `problem.agents.stop.issueGone` and `otherEndGone`: "ist nicht mehr da". "existiert nicht mehr" is more formal.
- `loadingLine.deskMail`: "Die Post des Helpdesks wird geladen…". "Die E-Mails des Helpdesks" may be plainer.
- `problem.ai.error`, `problem.apps.packageProblem` and `problem.attachments.tooLarge` add a lead-in that English doesn't have ("Beim KI-Dienst ist ein Fehler aufgetreten: {error}"), since what follows is another service's English. Keep them?
- **A commit's author** is "Autor" (`vcs.why.noEmail`, `sharedEmail`, `sharedLogin`, `twoPeople`), as git says. "die Person, die ihn verfasst hat" doesn't assume a gender, but it's long inside these pieces.
- **Telling people**: a rule's preview and its runs say "informieren" (`rules.preview.shown`, `rules.run.told`, `toldNobody`), and a rule's sentence says "benachrichtigen". One word throughout?
- `workflow.scriptRun.posts`: "Es würde einen Kommentar schreiben". "posten" and "anlegen" are the alternatives.

From the read of wave 4's messages (D50 to D55):

- `server.access.issueYouCantSee` and `articleYouCantSee` ("ein Vorgang, den Sie nicht sehen können") stand in for an id inside someone's text, so their case can't be known: the nominative reads wrong after "Siehe" or a preposition.
- **Reading as a GitHub App**: "Nicht mehr als App lesen" (`page.integrations.stopReadingAsTheApp`, `stopReadingAsTheGithub`) can read as "no more than". "Lesen als App beenden" is the alternative. "installieren Sie die App auf dem Repository" (`page.integrations.generateAPrivateKeyInstall`) may be better as "im Repository".
- "ausscheiden", for a person who leaves (`page.integrations.aGithubIntegrationCanRead`), may be too formal; "das Team verlassen" is the alternative.
- `articles.articleTree.limited` is "Eingeschränkt", where the catalog says "beschränkt" elsewhere.
- `board.board.movedTo`, moved to the top of a column, says "nach" twice ("nach In Review ganz nach oben verschoben").
- `problem.ci.giteaIntegrationNeeded` and its GitHub sibling say "Sagen Sie, welche …". "Geben Sie an, …" is more usual in German interfaces.

From the read of D56's and D57's messages (customer groups, and CCs on requests):

- `helpdesk.groups.cantBeGiven` is "{name}: gerade nicht zuweisbar", shortened so its badge fits a phone. Is "zuweisbar" natural to help desk staff?
- `helpdesk.groups.byDomains` "Domains: {domains}" sits beside `byHandOnly` "Nur von Hand" in a group's summary line. Does the pair read clearly?
- `issues.issueHistory.ccRemoved` and `activity.ledgerEntry.stoppedCopyingOn` say someone "hat sich … aus der Kopie genommen". "hat die Kopie … abbestellt" is the alternative.
- `server.helpdesk.copiedOnIt`, "Folgende Personen sind bei Ihrer Anfrage in Kopie …", is slightly off when one address follows.
- `server.helpdesk.cc.stop`, "Bei dieser Anfrage nicht mehr in Kopie sein", is wooden for a link; "Mich bei dieser Anfrage aus der Kopie nehmen" is the alternative.
- **Working hours**: a customer group's say "Arbeitszeiten", the desk's SLA settings (`helpdesk.sla.*`) "Arbeitszeit". One term throughout?
- `helpdesk.groups.addTheGroup` is "Gruppe anlegen", where the button that opens its form says "Gruppe hinzufügen".

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **Whiteboard terms**: a section is "Bereich", the outline "Gliederung", the canvas "Arbeitsfläche" and a note "Notiz" (Miro says "Haftnotiz" and "Frame"). Do they read as a whiteboard's own words?
- **A note's tone**: its legend is "Art" (`whiteboards.noteDialog.tone`) and the plain tone "Neutral" (`whiteboards.tone.plain`; "Einfach" read as "easy" beside "Problem"). The tones mix kinds (Idee, Frage, Problem) with states (Vereinbart, Zurückgestellt): does "Art" hold both?
- `page.whiteboard.lookingNow`, read aloud over the list of who has the whiteboard open, is "Gerade anwesend". "Gerade hier" and "Schauen gerade zu" are the alternatives.
- **Keys**: `page.whiteboard.keys` names them as German keyboards do ("Tabulatortaste", "Leertaste", "Eingabetaste", "Entf", "Umschalt", "Strg"), where the mention fields say "Enter" (`editor.visualEditor.countToMention`). One way throughout?
- `whiteboards.connectDialog.from` and `to`, an arrow's two ends, are "Von" and "Nach". "Zu" is the alternative to "Nach".
- **Issues from chat** are "angelegt", as the catalog makes issues everywhere else (`server.chat.issue.title` "Vorgang anlegen", `create` "Anlegen", `actionTitle` "a4a-Vorgang anlegen", `didMake`). Slack's and Teams' own German say "erstellen". Which reads better inside Slack and Teams?
- **Asana's menus** stay in English ("My settings, Apps, Manage developer apps") in `imports.fromApi.inAsanaMySettingsApps` and `problem.imports.source.tokenRefused`, as ClickUp's do ("Settings, Apps, API Token"), and Asana's token is "Personal Access Token", as the import form's field says. Asana's and ClickUp's German interfaces name them differently.
- `writing.suggestion.changeItFirst`, the label over a suggestion being edited, is "Vorschlag, den Sie vor dem Übernehmen ändern können": long for a label. "Vorschlag bearbeiten" is shorter, but loses "before you accept it".
- **Caps said as English says them**: `problem.ai.writing.limit` "…; öfter antwortet er niemandem" and `server.chat.issue.tooFast` "…; mehr darf eine Person nicht". Natural?
- `whiteboards.convertDialog.preview`, the dry run's button, is "Erst prüfen". "Vorschau" is the usual word, but the button runs the conversion and rolls it back.

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey or a password "meldet Sie an"** (`identity.passkeys.none`, `isAdded`, `removeAbout`, `server.passkeys.ifYouAddedIt`, `server.portalAccount.lead`), as two-factor's "Ihr Passwort allein meldet Sie an" does. "Mit einem Passkey melden Sie sich an" is the more usual German, and some messages now say it so, where the other way read badly (`page.admin.passkeysOff`, `passkeysRemoved`, `identity.passkeys.offInstance`, `page.portal.passwordHelp`, `server.portalAccount.subject`). One way throughout?
- `identity.passkeys.stopped`, the badge on a passkey that may have been copied, is "Gesperrt" (it was "Gestoppt"). a4a stops it rather than anyone locking it: is "Deaktiviert" better?
- **A customer group's people** are "Mitglieder" (`helpdesk.groups.signsIn` "Anmeldung der Mitglieder", `signsInHelp`, `signsInThrough`, `problem.portalSignIn.groupSignsInThrough`), as the group's other messages say, though English says "its people" because some are in it by their domain.
- `helpdesk.portalSignIn.passwordHelp` calls the form's proof of work "Arbeitsnachweis", where the desk's switch for it says "Sicherstellen, dass ein Mensch sie geschickt hat". "Proof of Work" or "Spamschutz des Formulars" are the alternatives.
- **Ways to sign in** are "Arten der Anmeldung" (`helpdesk.portalSignIn.ways`, `oneWay`, `server.portalAccount.lead`), and signing in another way "auf eine andere Art". "Anmeldemethoden" is the usual word in IT.
- `helpdesk.portalSignIn.redirectUri` is "Weiterleitungs-URI"; Microsoft Entra's German says "Umleitungs-URI".
- `page.guestPages.alsoOpenIn`, the heading over a project's plan, reports, boards and whiteboards on the guest page, is "Außerdem in {name} für alle offen". Natural as a heading?
- `identity.passkeys.notAvailable` says "Telefon", as two-factor's messages do; "Smartphone" is the more common word now.

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “{label}{v} aus den Push-Benachrichtigungen entfernen”; `page.admin.resetTwoFactorFor` “Zwei-Faktor zurücksetzen für {name}”. Do they read naturally?
- **An authenticator** (FIDO's) is "der Authenticator, die Authenticators" (`identity.passkeys.onlyThese`, `page.admin.onlySomeAuthenticators`, `problem.passkeys.notListed`), beside the catalog's "Authenticator-App". German security writing says "Authentifikator", plural "Authentifikatoren"; is the English plural's -s acceptable?
- **The authenticators a list allows are "zugelassen"** (`identity.passkeys.onlyThese` "Hier sind nur diese Authenticators zugelassen", `problem.passkeys.notListed`, `noMetadata`, `unattested`), while new passkeys are "angenommen" from them (`page.admin.takeOnlySome`, `authenticatorsSaved`), as a desk "nimmt Passkeys an". One verb throughout?
- **Attestation** is a maker's "Bestätigung" (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`), where the developers wrote "bürgen". "Attestierung" is the technical word.
- **Letting someone off passkeys**: the people table's link is "Befreien" (`page.admin.letOff`), its accessible name "{name} von der Passkey-Pflicht befreien" (`letOffFor`), and the person's line says "von der Passkey-Pflicht befreit" (`letOffPasskeys`, also `problem.passkeys.lastAdmin`, `wouldLockOut`). "Passkey-Pflicht" is coined here; "Ausnahme erlauben" is the alternative.
- **Check runs** are "Check-Runs" (`page.integrations.checksLegend`, `checksOn` "Für jeden Pull Request einen Check-Run namens „a4a“ schreiben"), as GitHub's English interface names them; GitHub's German documentation says "Überprüfungsausführungen". A check's title for ids a4a can't show is "Zu # IDs zeigt a4a keinen Vorgang" (`server.checks.title.unseen`): natural on GitHub?
- **A new request's Cc** is "die Personen in Cc" (`helpdesk.ccSettings.confirm`, `trusts`, `activity.ledgerEntry.requestCcsChanged`, `page.project.copiedOnRequestsNote`), written "Cc" as English and mail programs write it. German usually writes "CC"; "CC-Empfänger" is common but masculine.
- **Dropping someone a new request's Cc held**: the portal's button is "Verwerfen" (`page.portal.dropHeld`, `dropHeldWho`), and what follows says "wird nicht in Kopie gesetzt und erfährt nichts" (`page.portal.heldDropped`, `page.portal.confirm.dropped`). "Ablehnen" is the alternative for the button.
- **Relaying**: the desk's switch is "Allen Beteiligten einer Anfrage weitergeben, was die anderen schreiben" (`helpdesk.ccSettings.relay`), and its email's link "Keine Beiträge anderer zu dieser Anfrage mehr erhalten" (`server.helpdesk.relay.stop`). Natural?
- **A phone** is "Telefon" in this wave too (`app.auth.passkeysAreRequiredOfYou`, `app.auth.thisBrowserCantMakePasskeys`, `page.passkeySetup.notSupported`), which had said "Smartphone": settle it with wave 5's question.
- `server.portalPasskeys.subject`, when a passkey is added, is "Sie melden sich jetzt mit einem Passkey beim Helpdesk an", as the password's mail says it (`server.portalAccount.subject`). "Sie können sich jetzt mit einem Passkey beim Helpdesk anmelden" is clearer; `packages/server/test/portal-passkeys.test.ts` asserts the subject, and its fake SMTP reads it undecoded, so a subject with an umlaut needs the test to decode it.
- `issues.issueHistory.ccAdded`, a held Cc the requester confirmed, is "hat {email} per E-Mail in Kopie gesetzt und dies bestätigt" (it was "…, nach Bestätigung").
- `page.admin.removePasskeysOf`, the accessible name of "Passkeys entfernen", is "Passkeys entfernen für {name}", so it holds the link's words whole (WCAG 2.5.3); "Passkeys von {name} entfernen" is the natural order.
- `page.integrations.accountUser`, a GitHub account's type beside "Organisation", is "Benutzer"; "Persönliches Konto" doesn't assume a gender.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Commit-Status** stays English, like "Check-Run" (`page.integrations.statusesLegend` "Commit-Status bei Pull Requests", `statusesOn`): GitHub's German interface says "Commitstatus", without the hyphen, and the plural works unchanged. "Status" alone would collide with an issue's state.
- `page.group.requirePasskeys` is "Von den Personen dieser Gruppe einen Passkey verlangen", and `page.project.requirePasskeys` "Von allen, die dieses Projekt sehen können, einen Passkey verlangen": the verb-first order of the catalog's other switches. Would "Für die Personen dieser Gruppe …" read more naturally?
- `page.group.requirePasskeysHelp` ends "…, und eine befreite Person braucht keinen.", building on wave 6's "von der Passkey-Pflicht befreit". Should the noun appear here too ("und eine von der Passkey-Pflicht befreite Person braucht keinen")?
- `builds.builds.reportCheck` is "Das Ergebnis jedes Laufs an GitHub melden". Is "melden" the right verb for telling a service, or would "berichten" or "übermitteln" say it better?
- `page.integrations.statusesAudience` says "Ein Status nennt Vorgänge nur mit ihrer ID" — the checks message says "nennt Vorgänge mit ID und Link". Does "mit ihrer ID" read naturally beside it?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` ist “Es kam in eine Suche, der du folgst” — das Zeitform von “folgen”. Sagt es, was Zeit allein tat, oder liest es zu passiv? (“Eine Suche, die du verfolgst, hat ihn jetzt” wäre aktiver.)

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle`, `noArticleWords` und `issuesMatching` folgen den Worten der bereits vorhandenen Gast-Seiten. Natürlich? (`issuesMatching`: “Tickets, die auf … passen” — oder lieber “Tickets zur Abfrage”?)

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` und `linkTo` folgen den vorhandenen Werkzeugnamen. `writing.draftedWithTheAssistant` ist “Diese Worte hat der Assistent entworfen.” — passt “entworfen”, oder eher “formuliert”?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = „Zeichnen“, `page.whiteboard.picture` = „Bild“, `whiteboards.kind.ink` = „eine Zeichnung“): passen die Werkzeugnamen so, oder eher „Skizzieren“ und „Foto“?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = „Homeserver“ — bleibt der Fachbegriff so, wie die Matrix-Welt ihn nutzt?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (Stundenzettel): `page.timesheet.submit` = „Woche einreichen“ und `page.timesheet.sendBack` = „Zurückgeben“ — klingen die Knöpfe natürlich?

Messages added in wave 16 (the script library's page):

- Wave 16 (Skriptbibliothek): `page.rules.library` = „Skriptbibliothek“ und `page.rules.libraryCode` = „Der gemeinsame Code“ — klingen die Bezeichnungen natürlich?

Messages added with the configurable approval rule:

- Die einstellbare Genehmigung: `projects.workTypes.approvalEvery` = „Seine Manager, unter den Managern jedes Projekts, in dem die Woche Arbeit enthält“ — liest sich die lange Beschriftung natürlich?

Messages added in wave 18 (the HR calendar):

- Wave 18 (HR-Kalender): `page.admin.hrCalendar` = „HR-Kalender“ und `problem.absences.fromHr` = „Diese Tage kommen aus dem HR-Kalender...“ — klingt die Erklärung natürlich?

Messages added with the timesheet's personal view:

- Die eigene Sicht: `page.timesheet.bauOrAnythingYouKeep` = „BAU oder was du sonst führst“ und `problem.time.severalPersonalEntries` = „...Ändere sie einzeln.“ — klingen sie natürlich?

Messages added with the queued scripts:

- Die Warteschlange: `rules.ruleForm.runFromTheQueue` = „Aus der Warteschlange ausführen: es darf sich Zeit nehmen und handelt mit dem, was es beim Auslösen der Regel sah“ — liest sich die lange Beschriftung natürlich?

With the posts that change in place:

- Die Beiträge ändern sich an Ort und Stelle – keine neuen Wörter; eine Frage: soll die Änderung im Kanal als „bearbeitet“ erkennbar sein, oder reicht der stille Austausch des Inhalts?

Messages added with the load grid's team:

- Die Lastanzeige: `plan.resources.nothingYet` = „Noch nichts“ neben einer Person ohne geplante Arbeit — passt das knappe Wort?

Messages added with Teams' link unfurling:

- Das Entfalten: `server.chat.issue.isShared` = „hat den Vorgang geteilt“ — passt das Verb auf der Karte?

With the requester's own language:

- Die Sprache der Requester: die E-Mails folgen jetzt der Sprache des Browsers (auf dem Requester gespeichert). Keine neuen Wörter; eine Frage: soll der Portal-Seite ein Sprachwähler sichtbar sein, oder reicht der Browser?

Messages added with SAML for requesters:

- SAML für Requester: `problem.portal.providers.samlNeedsBoth` = „Ein SAML-Provider braucht seine SSO-URL und sein Signaturzertifikat.“ — klingt die Erklärung natürlich?
## Spanish

One Spanish for Spain and Latin America, as [translating.md](translating.md) says. These lean one way:

- "Pulsa" for press leans to Spain.
- `away.words.training` is "Formación". Latin America says "Capacitación".
- `page.agents.runThisInATerminal` says "en un terminal". Latin America says "la terminal".

Terms:

- **The navigation's Build group** (`app.shell.build`), which holds Projects, Rules, Fields and Import, is "Configurar". "Crear" and "Construir" are the alternatives.
- **A project's lead** (`page.project.lead`, `page.projects.lead`) is "Responsable", which is also the word for an assignee. "Responsable del proyecto" or "Líder" may be clearer.
- **A token's scope** is "ámbito" (`problem.access.tokenScope` and its siblings). "permiso" is the alternative.
- **An owned field** is a "campo con dueño".
- **A transition** is "un paso de un estado a otro" (`problem.rule.addTransition`, `twoFromAny`, `twoTransitions`). Its ends (`workflow.machines.from`, `to`) are "Desde" and "Hasta"; "De" and "A" may suit better.

Phrasing:

- `decide.suggestionCard.sure`, `fairlySure` and `unsure` are "seguro", "bastante seguro" and "poco seguro", masculine. What they agree with isn't clear from the page.
- `reports.burndown.added`, `removed`, `takenOut` and `resolved` are masculine, though they describe issues ("incidencias"). Some of these keys are also column headers.
- `chat.chat.subscribedIt`: "lo suscribió {when}" takes "it" for the channel.
- `helpdesk.sla.waitingForReporter` stays "Waiting for reporter". It's an example of a state's name, and states are data, but a Spanish example may serve Spanish teams better.
- `page.issues.forget`: "Olvidar “{name}”", for a saved search.
- **The parser's "Expected …"** is "Falta …", and "Unknown X" is "X no existe".
- `problem.query.missingClosing`: "Falta el {close} de cierre." "el" assumes a paréntesis or a carácter.
- `away.daysAway.addedAway` and `changedAway`: "Added:" and "Changed:" are "Ausencia agregada:" and "Ausencia cambiada:", naming what was added.
- **Worded so as not to guess a gender**: `problem.portal.colleaguesRequest` ("otra persona de tu organización"), `problem.users.deleteYourself` ("No puedes eliminar tu propia cuenta") and `problem.members.leadIsManager` ("le da el rol de gestor").
- **"Your address"** in the help desk's limits (`problem.helpdesk.tooManyFromAddress` and its siblings) is "tu dirección IP", since an email address sits beside it.
- **The issue list's count line** puts the count last ("Incidencias del proyecto BACK y sin resolver: 4"), since the explanation's pieces are plural and wouldn't agree after "1 incidencia". It reads differently from English's "4 issues …".
- `rules.run.scheduled` keeps "worker" in English ("otra instancia tomó el control del worker").
- `rules.run.logged`: a script's log lines are "Escribió en el registro:", and "registro" is also the word for a rule's runs.
- **The chat bot's changes** are infinitives after "Hecho:" (`server.command.*`): "Hecho: cambiar State a Fixed; agregar la etiqueta urgent".
- `rules.run.toldOthers`: "Avisó a Anna, Ben y 3 más." "y 3 personas más" may be clearer.
- `rules.preview.actsScheduled`: a rule reaching other issues acts "por" each of them, and one acting on them "sobre" each. Does the difference read?
- `problem.chat.stop.disconnectedBy`: in "{name} lo desconectó.", "lo" is a connection the sentence never names.

From the read of wave 4's messages (D50 to D55):

- `articles.visibleTo.letEveryoneSeeIt` and its issue twin, "Que lo vea todo el mundo", aren't infinitives, as buttons are meant to be. "Mostrarlo a todo el mundo" is the alternative.
- `page.project.keyFormer`: "Antes usaba {keys}." Is "usaba" clear under the "Clave" heading, or is "Claves anteriores: {keys}." better?
- **The board's moves**: "la mueven un puesto" (`board.board.chooseACardSId`, `dragACardToAnother`) matches the backlog. "una posición" may be more usual.
- `problem.vcs.githubApp.answered`, `problem.imports.source.answeredSaying` and `problem.chat.stop.teamsAnswered`: "{host} respondió {status}". "respondió con {status}" reads more naturally.
- "leer como GitHub App", in 11 messages (`page.integrations.readAsAGithubApp` and its family): "como" in the sense of "in the capacity of".
- `projects.projectFields.everyone` is "Todos", a short checkbox label, where the catalog says "Todo el mundo" elsewhere.

From the read of D56's and D57's messages (customer groups, and CCs on requests):

- `page.portal.copiedByYou` and `copiedByTheTeam`, "en copia por ti" and "en copia por el equipo", are terse; "puesto en copia" would guess the person's gender.
- `issues.issueHistory.publicAColleagueWroteIt`, "público: lo escribió alguien del grupo de clientes", doesn't say "of the requester": the fuller form is too long for a badge.
- `helpdesk.groups.agents` (and `noAgents`, `cantBeGiven`), "Quién recibe sus solicitudes nuevas": "recibir" is vague, and "A quién se asignan…" is longer than its badge allows.
- `page.portal.groupSeesIt`, "{group} ve esta solicitud.": or "Los miembros de {group} ven…"?
- **"en copia en"** in many messages ("Estás en copia en la solicitud…"): is the double "en" acceptable, or is "en copia de" better?
- `server.helpdesk.copiedOnIt` heads a list of addresses in an email: does "Personas en copia en tu solicitud, que también recibirán las respuestas del equipo:" read well there?
- `helpdesk.groups.byDomains`, "Por {domains}": "Por dominio: {domains}" may be clearer.
- `activity.ledgerEntry.changesWhoIsCopied`, "cambia quién está en copia en una solicitud", is 43 characters on a badge that doesn't wrap.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A note's tones** (`whiteboards.tone.*`, `whiteboards.kind.note`): plain is "Normal" and parked "Aplazada", since "Aparcada", for a topic set aside, leans to Spain. "Simple" and "En pausa" are the alternatives.
- **The whiteboard's keys** (`page.whiteboard.keys`, `keysReading`) are "Enter", "Mayús", "Supr", "Tab" and "Espacio", and the catalog's other keys say "Enter" too. Spain's keyboards print "Intro", and Latin America often says "Shift".
- **An arrow's label** is "Etiqueta" (`whiteboards.connectDialog.label`, `whiteboards.textDialog.label`, `labelArrow`), the catalog's word for a tag as well. "Texto" couldn't be taken for a tag.
- `whiteboards.connectDialog.from` and `to`, an arrow's ends, are "Desde" and "Hasta", as a transition's are. "Origen" and "Destino" may suit an arrow better.
- `page.whiteboard.said.undid`: undoing an add or a removal says "Se ha deshecho lo agregado" or "Se ha deshecho lo quitado". Natural enough when a screen reader says it?
- **ClickUp's List** is "Lista", capitalised as English and ClickUp write it (`imports.fromApi.theListSAddressIn`, `whichTasksAList`, `problem.imports.source.clickupNoList`, `notAClickupList`, and the clickup cases of `problem.apiImports.nothingMatches` and `problem.imports.source.requestRefusedSaying`), so it isn't read as a checklist's "lista". Spanish would usually lower-case it.
- `page.chat.issuesFromMessagesNeed` keeps "Callback ID" as Slack's app settings name the field, as the page keeps "Basic Information". "ID de callback" is the alternative.
- `whiteboards.convertDialog.preview`, "Check first", is "Vista previa": with "Comprobar antes", the dialog's three buttons spilled past a 390px screen.
- `writing.action` and `writing.suggestion.title`: friendlier is "Más cercano". "Más amable" is the alternative.
- `server.chat.issue.withReplies`, the thread's checkbox in Slack's form, is "Agregar las respuestas posteriores, hasta 20", which says "up to" where English says "the first 20".

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- `identity.passkeys.stopped`, the badge on a passkey that may have been copied, is "Bloqueada": "Detenida" read like a person held. Does "Bloqueada" suggest an administrator locked it? "Inutilizada" is the alternative.
- **Vouching**: an identity provider "responde por" an address (`helpdesk.portalSignIn.domainsHelp`, `throughAny`, `throughSome`, `page.portal.ssoDomain`), as `chat.chat.whoVouchesForIt` has it. "Avala" or "garantiza" are the alternatives.
- `helpdesk.portalSignIn.passwordHelp` calls the form's proof of work "la comprobación de que no es un bot", as the help desk's problems do, where the desk's setting says "Comprobar que lo envía una persona". One name for both?
- `helpdesk.portalSignIn.clientSecretHelp` keeps the catalog's "Se guarda sellado" for "Kept sealed". "Se guarda cifrado" is the usual Spanish.
- `page.guestPages.alsoOpenIn`, the heading over what else a project opens to guests, is "También en {name}": "También abierto en {name}" read as if the page itself were open elsewhere. It leaves "open" out.
- `activity.ledgerEntry.changesHowRequestersSignIn`, a ledger badge, is "cambia el inicio de sesión del portal": it names the portal, not the requesters, to stay short.
- **A time in an email**: the passkey emails put "el {when}" before a time Intl writes as "lun, 16 nov, 15:05 CET" (`server.passkeys.added`, `removed`, `copied`, `removedByAdmin`). Does "el lun, 16 nov, 15:05 CET" read well?
- `problem.whiteboards.guestStreams`: a whiteboard open live is "abierta en tiempo real", since "en directo" leans to Spain and "en vivo" to Latin America.
- **OpenID's words** for requesters' providers: "Emisor" (issuer), "documento de descubrimiento" (Microsoft's Spanish says "documento de detección") and "el URI de redirección" (some write "la URI").

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `attachments.attachmentList.stopAttaching` “Detener la subida de {name}”; `notifications.pushSettings.stopPushNotificationsTo` “Quitar {label}{v} de las notificaciones push”. Do they read naturally?
- **A check run** stays "check run", masculine ("los check runs", "un check"), as French and German keep it (`page.integrations.checksOn` and its family, `problem.vcs.checks.needsApp`). GitHub's Spanish documentation says "ejecución de comprobación", which developers rarely say.
- **A pull request names issues** with "nombrar", as commits do (`builds.builds.aBuildThatPassesGoes`), but an id that "names no issue" is one that "no corresponde a ninguna incidencia" (`server.checks.summary.rule`, `unseen`, `unseenMore`, `server.checks.title.unseen`, `page.integrations.checksResolved`). "Mencionar" may be the more usual verb for a pull request.
- **Hearing each other** is "leerse entre sí": "Que todas las personas de una solicitud se lean entre sí" (`helpdesk.ccSettings.relay`, `page.project.copiedOnRequestsNote`, `activity.ledgerEntry.requestCcsChanged`). "Que cada persona reciba lo que escriben las demás" is plainer, and longer.
- `activity.ledgerEntry.changesHowRequestsCopy`, a ledger badge, is "cambia las reglas de copia", short as a badge must be. "Regla" is also a workflow's rule, though the webhook's label (`page.webhooks.label.projectRequestCcsChanged`) says "las reglas de un servicio" too.
- **Holding a new request's Cc** is "retener" (`helpdesk.ccSettings.confirm`), and the headings over those held are "Pendientes de la confirmación de {requester}" (`helpdesk.requestCcs.held`) and "Pendientes de tu confirmación" (`page.portal.heldTitle`). Natural over a list of people?
- **Letting someone off passkeys** is "eximir": the people table's link is "Eximir" (`page.admin.letOff`), and its note is a noun, "con exención de llave de acceso" (`page.admin.letOffPasskeys`), since "exento" would guess a gender. Too formal for a link? "Hacer una excepción" is the alternative.
- `identity.passkeys.passkeysAloneAbout` keeps "phishing" ("ni robarlas mediante phishing"), as banks' warnings do on both sides of the Atlantic. "Suplantación" is the alternative.
- `page.integrations.readThrough`, beside an installation's account, is "repositorios leídos a través de ella: {list}", longer than English's "read here:" to say what was read. `page.integrations.accountUser`, a badge, is "usuario"; GitHub's Spanish documentation says "cuenta personal".
- `helpdesk.portalPasskeys.notMeAdded` and the added case of `server.portalPasskeys.subject` are one sentence, "Se agregó una llave de acceso para iniciar sesión en el servicio de asistencia", for English's "A passkey was added to your help desk sign-in" and "A passkey now signs you in to the help desk".
- `helpdesk.portalPasskeys.stopped` is "Bloqueada", as `identity.passkeys.stopped` is: wave 5's question above settles both.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Un estado de commit** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): el catálogo escribe "commit" sin traducir en el resto de mensajes; GitLab en español dice "estado de confirmación". ¿Se prefiere "commit"?
- `page.group.requirePasskeys` es "Exigir una llave de acceso a las personas del grupo" y `page.project.requirePasskeys` "…a todo el que pueda ver este proyecto". ¿"a todo el que" o "a todos los que puedan"? ¿"exigir a alguien" o "exigir de"?
- `page.group.requirePasskeysHelp` dice "a partir del siguiente inicio" (sin "de sesión" la segunda vez). ¿Bastaría "desde el siguiente inicio de sesión"?
- `builds.builds.reportCheck` es "Informar a GitHub del resultado de cada ejecución". El catálogo usa "ejecución" para los check runs; para una ejecución de CI, ¿"ejecución" o "corrida" (Latinoamérica)?
- `page.integrations.statusesLastProblem` sigue el patrón de los check runs: "El último estado de commit, {when}, no se pudo escribir: {problem}". ¿Natural?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` es “Entró en una búsqueda que sigues”. ¿Se diría mejor “siguiendo”, o con “apareció en”?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` sigue a sus hermanos (“abierto a invitados”). `issuesMatching` es “Incidencias que coinciden con”: ¿o “que cumplen” o “que encajan con”?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` y `linkTo` siguen los nombres de las herramientas existentes. `writing.draftedWithTheAssistant` es “El asistente redactó estas palabras.” — ¿o “escribió”?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “Dibujar”, `page.whiteboard.picture` = “Imagen”, `whiteboards.kind.ink` = “un dibujo”): ¿natural, o mejor “Trazar” y “Foto”?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = “Homeserver” — ¿se deja el término tal cual, o se dice “servidor de Matrix”?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (parte de horas): `page.timesheet.submit` = “Enviar la semana” y `page.timesheet.sendBack` = “Devolverla” — ¿naturales?

Messages added in wave 16 (the script library's page):

- Wave 16 (biblioteca de scripts): `page.rules.library` = “Biblioteca de scripts” y `page.rules.libraryCode` = “El código compartido” — ¿naturales?

Messages added with the configurable approval rule:

- La aprobación configurable: `projects.workTypes.approvalEvery` = “Sus gestores, entre los gestores de cada proyecto donde la semana tiene trabajo” — ¿natural, pese a lo largo?

Messages added in wave 18 (the HR calendar):

- Wave 18 (calendario de RR. HH.): `page.admin.hrCalendar` = “Calendario de RR. HH.” y el rechazo “Estos días vienen del calendario de RR. HH...” — ¿naturales?

Messages added with the timesheet's personal view:

- La vista personal: `page.timesheet.bauOrAnythingYouKeep` = “BAU, o lo que tú lleves” y el rechazo “...Cámbialas una a una.” — ¿naturales?

Messages added with the queued scripts:

- La cola: `rules.ruleForm.runFromTheQueue` = “Ejecútalo desde la cola: puede tomarse su tiempo y actúa sobre lo que vio cuando su regla se disparó” — ¿natural, pese a lo largo?

With the posts that change in place:

- Las publicaciones cambian en su sitio – sin palabras nuevas; una pregunta: ¿debería verse en el canal que se editó, o basta con el contenido reemplazado en silencio?

Messages added with the load grid's team:

- La carga: `plan.resources.nothingYet` = “Nada aún” junto a una persona sin trabajo planificado — ¿encaja la palabra breve?

Messages added with Teams' link unfurling:

- El despliegue: `server.chat.issue.isShared` = “compartió la incidencia” — ¿encaja el verbo en la tarjeta?

With the requester's own language:

- El idioma del solicitante: los correos siguen ahora el del navegador (guardado en el solicitante). Sin palabras nuevas; una pregunta: ¿la página del portal debería mostrar un selector de idioma, o basta el navegador?

Messages added with SAML for requesters:

- SAML para solicitantes: `problem.portal.providers.samlNeedsBoth` = “Un proveedor SAML necesita su URL de SSO y su certificado de firma.” — ¿natural?
## French

Terms:

- **"Gestionnaire"** is both the Manager role and an app's handler, and the apps page shows both.
- **"Admin"** in a sentence ("Demandez à un admin"). "un administrateur" is more formal.
- **A token's scope** is "portée". "étendue" is the other common choice. Slack's own scopes stay "scopes" (`page.chat.theAppNeedsTheScopes`).
- **"Fichier joint introuvable"** says "Attachment not found", though the section is "Fichiers". An app's package is a "paquet".
- **A declined pull request** is "refusée".

Phrasing:

- `decide.suggestionCard.dismissing`: "Dismissing…" is "Rejet…", beside the button "Ignorer". French has no good noun for ignoring.
- `away.daysAway.fromAMonthAgoOn`: "{v}, à partir d’il y a un mois." is correct, but spoken.
- `chat.chat.hearsOf` ("{name} reçoit : {what}.") and `server.chat.kinds` ("Choix possibles : {kinds}."): read them beside the bot's other lines.
- `assistant.talk.read`: "Read", beside a count, is "Lectures". Whether English means a count or a verb isn't clear.
- `problem.notFound.user` is "Compte {id} introuvable", since "Personne {id} introuvable" can read as "nobody". For a login, it's "Aucune personne n’a l’identifiant {login}".
- **"Your address"** in the help desk's limits is "votre adresse IP", and requests there are "demandes".
- **Worth a second look**:
  - `problem.chat.entraIsNoLink`: "…, qui ne se dissocie pas";
  - `problem.apps.handlerRefused`: "{refusal} C’est ce qu’indique {title}.";
  - `problem.agents.isA4asOwn`: "Ajoutez un agent à part entière, au nom duquel un outil pourra agir.";
  - `problem.notifications.sayWhich`: "« all » à true".
- `decide.suggestionCard.acceptedOf`: "# sur {total} accepté", masculine, since it counts fields and tags together.
- **Loading lines with "ses"** ("Chargement de ses actions…") can leave whose unclear.
- `page.portal.updatedYours` and `updatedTheirs`: "la vôtre · mise à jour", feminine, agreeing with the request.
- `server.helpdesk.changedFrom`: "Votre demande a changé (auparavant {from})", where {from} is a state's name.
- **The parser's "Expected …"** is "Il manque …", which agrees with nothing, and an unexpected token is "Élément « {token} » inattendu".
- `problem.rule.subtaskLinkParent` and `subtaskLinkSubtasks` name the rule form's French options, « son parent » and « ses sous-tâches ».
- `problem.agents.stop.userGone` and `valueGone`: "The {field} it had" is "L’ancienne valeur de {field}".
- **The issue list's count line** puts the count last, "Tous les tickets (les plus récemment mis à jour d’abord) : 4", and "Tous" adds an "all" English doesn't have.
- `rules.preview.actsWhen`: "Elle n’agit sur l’un d’eux qu’au moment où {trigger}." "que lorsque" would need an elision before the trigger's "un ticket…".
- `rules.run.scheduled` keeps "worker", an English loanword ("a repris le worker").
- `problem.chat.stop.membersOnly`: "…et la personne qui l’a abonné ne le gère pas" is correct, "l’" being the channel, but heavy.

From the read of wave 4's messages (D50 to D55):

- `page.integrations.readsAsTheGithubApp` ("lit en tant que GitHub App {app}, installée sur {account}") is a badge a little longer than English's, and badges don't wrap. Check it on a 390px screen.
- `activity.ledgerEntry.rankedOn`: "a classé {issue} sur {str}", where {str} is the board's bare name. "sur le tableau {str}" may read more clearly.
- `page.project.keyFormer`: "Avant, il s’appelait {keys}." uses "s’appeler" for a key, which isn't the project's name.
- "{key} reste à ce projet pour de bon" (`page.project.keyAbout`, `keyRenameAbout`, `problem.projectKeys.taken`) is correct but plain.
- `problem.access.roleDoesNotAllow`: "un rôle qui le permet". Careful French may want "qui le permette".
- `page.integrations.changeTheApp`, "Changer d’application", suggests another app, though the form also takes a new key for the same one. "Modifier l’application" is the alternative.
- `builds.builds.byItsFileSuchAs`: "compté sur tous les workflows du dépôt", or "numéroté sur l’ensemble des workflows du dépôt".

From the read of D56's and D57's messages (customer groups, and CCs on requests):

- `helpdesk.groups.cantBeGiven` is "{name} : ne reçoit pas de demandes": "pour l’instant" was dropped so its badge fits a phone, leaving the badge's clock to say it's for now. Does it still read as "can't be given requests now"?
- **A group's sharing** (`helpdesk.groups.sharingRead`, `sharingComment`, `sharingNone`: "Les membres lisent celles des autres", "Chaque personne voit les siennes"): in a group's summary line "celles" and "les siennes" have nothing to refer to, and at 390px the closed select cuts the longest option. "Non partagées / Partagées en lecture / Partagées en lecture et en réponse" is the alternative.
- `page.portal.copiedByYou` and `copiedByTheTeam`, "par vous" and "par l’équipe", under the heading "En copie": clear enough?
- `helpdesk.groups.byDomains`, "Par {domains}": "Domaines : {domains}" may read better.
- `helpdesk.groups.domains`, "Domaines e-mail": or "Domaines de messagerie"?
- `problem.customerGroups.unknownAgent`, "…l’identifiant d’un membre du projet": could "membre" be read as the Membre role?
- `server.helpdesk.copiedOnIt`, "En copie de votre demande, et destinataires des réponses de l’équipe :", is correct but stiff.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- `whiteboards.tone.agreed` is "Validée" (and "Note, validée" in `whiteboards.kind.note`), where the developers wrote "Convenue". "Validée" can suggest that someone in charge approved it, not that the team agreed; "Actée" is the meeting room's word.
- `whiteboards.tone.plain` is "Simple". "Neutre" may say better that the note has no tone.
- `page.whiteboard.outline` and `whiteboards.outline.title` are "Sommaire", for a list of every element rather than of headings. "Plan", Word's word for an outline, sits close to the Planning page, and "Liste des éléments" is long for the toolbar.
- `page.whiteboard.canvas`, a heading only screen readers hear, is "La zone de dessin", though nothing is drawn freehand. "Le canevas" is what design tools say.
- **Choosing on the canvas** is "sélectionner" (`page.whiteboard.keys`, `page.whiteboard.said.chosen`, `whiteboards.convertDialog.none`), as for text, where the issue list's checkboxes say "Choisir".
- `whiteboards.noteDialog.tone` is "Type" and `whiteboards.cardDialog.what` "Contenu", over their radio buttons, where English says "What it is" and "What it shows". Do they read right there?
- `problem.ai.writing.lineNeeded` and `lineTooLong`: the line to draft from is "une ligne qui servira de base" and "le texte qui sert de base". "Consigne" is shorter, but reads as an order.
- `page.whiteboards.about`: "réfléchit" is weaker than "brainstorms". "Fait du brainstorming" is what French offices say, but it's an anglicism.
- `page.issue.source.from`, "Issu d’un message Slack dans #eng, Acme": or "Créé à partir d’un message…"?
- **Asana's and ClickUp's settings** are named in English (`imports.fromApi.inAsanaMySettingsApps`, `inClickupSettingsApps`, and their cases in `problem.imports.source.tokenRefused`), as YouTrack's and Zendesk's are. Both products also come in French, whose labels their French readers see instead.

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- `identity.passkeys.stopped`, the badge on a passkey that may have been copied, is "Bloquée", where the developers wrote "Arrêtée". "Désactivée" is what passkeys turned off for the instance are, and they come back; "Hors service" is the other choice.
- **"Signs you in"** is "vous connecte" ("elle vous connecte sans mot de passe", `page.portal.passwordHelp`'s "Il vous connecte au portail"), as the recovery codes' "chacun vous connecte une fois" does (`identity.twoFactor.keepTheseNowYourRecovery`). "Signs nobody in" is "ne permet plus de se connecter" (`identity.passkeys.removed`, `mayBeCopied`, `offInstance`, `page.admin.passkeysOff`, `page.notMe.doneAbout`, `ifNotYou`), since "ne connecte personne" read as a calque. Natural?
- `helpdesk.groups.asTheDeskTakes` is "Toute façon acceptée par le centre", an option beside "Uniquement via {name}" under "Connexion de ses membres", kept short for a phone's select. Clear?
- `page.guestPages.alsoOpenIn`, over a guest's links to a project's plan, reports, boards and whiteboards, is "À voir aussi dans {name}". It drops "open"; "Également ouverts dans {name}" is closer to English.
- `helpdesk.portalSignIn.passwordHelp` calls the form's proof of work "la vérification anti-robot du formulaire", the setting being "Vérifier qu’une personne l’a envoyée".
- `server.portalAccount.lead`, for a provider's first sign-in: "Pour la première fois, une session a été ouverte via {provider} sur le portail du centre d’assistance, en tant que {email}." It's passive so that nothing agrees with the reader. Stiff for an email's first line?
- `server.passkeys.added`, `removed`, `copied` and `removedByAdmin` say "le {when}", and {when} is "lun. 16 nov., 15:03 UTC+1".
- `helpdesk.portalSignIn.throughSome`: "que des adresses de {list}", where {list} is bare domains ("de acme.com et acme.fr"), without elision.
- `helpdesk.portalSignIn.save` is "Enregistrer la connexion", under the heading "Connexion des personnes qui font des demandes". Could it read as saving a login? "Enregistrer les façons de se connecter" is clearer, and longer.
- **Requesters, plural,** are "les personnes qui font des demandes", as in D56's messages: long in headings (`page.project.portalSignIn`, `helpdesk.portalSignIn.providers`) and the ledger (`activity.ledgerEntry.portalSignInChanged`).

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “Retirer {label}{v} des notifications push”; `page.admin.askForAPasskeyOf` “Exiger une clé d’accès de {name} à nouveau”. Do they read naturally?
- **Check runs** stay "check run" ("le check run"), as the developers wrote, where GitHub's French documentation says "exécutions de vérifications". A pull request "mentionne" its issues (`server.checks.*`, `page.integrations.checksAudience`), as `page.webhooks.label.pullRequestLinked` says, and an id "ne correspond à aucun ticket", where the developers wrote "nomme".
- `page.integrations.checksNeedPermission` and `problem.vcs.githubApp.cantWriteChecks` quote GitHub's English label with French spacing, "Checks : Read and write". GitHub shows "Checks: Read and write".
- **FIDO** takes "la": "les métadonnées de la FIDO", "Selon la FIDO, {name} n’est pas digne de confiance". "L’Alliance FIDO", or "FIDO" alone, are the other ways.
- **A date that would end a sentence** goes in brackets, so that "nov." and the full stop don't meet: `helpdesk.portalPasskeys.when` ("Ajoutée le 3 nov. (dernière utilisation le 16 nov.)."), `helpdesk.portalPasskeys.notMeWhat`, `page.notMe.what`, `page.notMe.whatPassword`, and `page.admin.metadataInUse` ("Métadonnées de la FIDO utilisées : numéro 82 (lues il y a 3 heures)."). Natural?
- `page.admin.letOffPasskeys` is a noun, "dispense de clé d’accès", so that nothing agrees with the person, among the people table's notes ("avec authentification à deux facteurs · dispense de clé d’accès"). Clear there?
- `activity.ledgerEntry.requestCcsChanged` lists a desk's rules as participles after a colon: "…au plus 5 personnes en copie, le Cc d’une nouvelle demande appliqué aussitôt et seuls les messages de l’équipe transmis". Does the last read as "only the team's messages are sent"?
- **Passkeys alone** is "uniquement": "Se connecter uniquement avec vos clés d’accès" (`identity.passkeys.passkeysAlone`), "Clés d’accès uniquement" in the people table (`page.admin.passkeysAlone`), where the developers wrote "avec vos clés d’accès seules".
- `page.integrations.readThrough` and `nothingReadThroughYet`, beside an installation's account: "utilisée pour lire octo-org/api et octo-org/web", "pas encore utilisée". Clear?
- `server.helpdesk.relay.whyAnswer` and `whyLink`: the people on a request "participent à" it ("d’autres personnes participent à votre demande auprès de {desk}"), since "suivre" is a4a's word for watching.
- `page.portal.confirm.copyThem`, "Mettre en copie les personnes choisies", is long for a button, and wraps at 390px.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Un statut de commit** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): la documentation de GitLab en français dit "statut de commit". Le catalogue garde "commit" (voir `builds.builds.commits`). Cohérent ?
- `page.group.requirePasskeys` est "Exiger une clé d’accès des membres du groupe" et `page.project.requirePasskeys` "…de toute personne pouvant voir ce projet". "Exiger quelque chose de quelqu’un" est le tour correct ; le participe "pouvant voir" est-il naturel dans un libellé ?
- `page.project.requirePasskeysHelp` commence par "À partir de leur prochaine connexion, là où le mot de passe propre à a4a sert à se connecter." Le "là où" se répète dans l’aide du groupe : trop lourd ?
- `builds.builds.reportCheck` est "Signaler à GitHub le résultat de chaque exécution". "Signaler" convient-il pour un compte-rendu automatique, ou "publier" (comme les check runs) dirait-il mieux ?
- `page.integrations.statusesNeedToken` emploie le point-virgule avant "Gitea et Forgejo ont aussi besoin…", comme l’anglais. Lisibilité ?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` est “Il est entré dans une recherche que vous suivez”. À côté de la voix passive, la personne voit-elle que c’est le temps qui l’a fait entrer ?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` suit ses soeurs (“ouvert aux invités”). `issuesMatching` est “Tickets correspondant à” : naturel, ou “qui répondent à” ?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` et `linkTo` suivent les outils existants. `writing.draftedWithTheAssistant` est “L’assistant a rédigé ces mots.” — naturel, ou “a écrit” ?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “Dessiner”, `page.whiteboard.picture` = “Image”, `whiteboards.kind.ink` = “un dessin”): naturel, ou “Tracer” et “Photo” ?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix) : `page.chat.matrixHomeserver` = “Homeserver” — terme conservé tel quel, ou “serveur Matrix” ?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (feuille de temps) : `page.timesheet.submit` = “Envoyer la semaine” et `page.timesheet.sendBack` = “La renvoyer” — naturels ?

Messages added in wave 16 (the script library's page):

- Wave 16 (bibliothèque de scripts) : `page.rules.library` = “Bibliothèque de scripts” et `page.rules.libraryCode` = “Le code partagé” — naturels ?

Messages added with the configurable approval rule:

- L'approbation configurable : `projects.workTypes.approvalEvery` = “Ses gestionnaires, parmi les gestionnaires de chaque projet où la semaine a du travail” — naturel malgré la longueur ?

Messages added in wave 18 (the HR calendar):

- Wave 18 (calendrier RH) : `page.admin.hrCalendar` = “Calendrier RH” et le refus “Ces jours viennent du calendrier RH...” — naturels ?

Messages added with the timesheet's personal view:

- La vue personnelle : `page.timesheet.bauOrAnythingYouKeep` = “BAU, ou ce que vous suivez” et le refus “...Changez-les une par une.” — naturels ?

Messages added with the queued scripts:

- La file : `rules.ruleForm.runFromTheQueue` = “L'exécuter depuis la file : il peut prendre son temps et agit sur ce qu'il a vu quand sa règle s'est déclenchée” — naturel malgré la longueur ?

With the posts that change in place:

- Les messages changent sur place – pas de mots nouveaux ; une question : faut-il montrer dans le canal que c'est une édition, ou le contenu remplacé en silence suffit-il ?

Messages added with the load grid's team:

- La charge : `plan.resources.nothingYet` = “Rien encore” à côté d'une personne sans travail planifié — le mot bref convient-il ?

Messages added with Teams' link unfurling:

- Le dépliage : `server.chat.issue.isShared` = “a partagé le ticket” — le verbe convient-il sur la carte ?

With the requester's own language:

- La langue du demandeur : les courriels suivent désormais celle du navigateur (gardée sur le demandeur). Pas de mots nouveaux ; une question : la page du portail devrait-elle offrir un choix de langue, ou le navigateur suffit-il ?

Messages added with SAML for requesters:

- SAML pour les demandeurs : `problem.portal.providers.samlNeedsBoth` = “Un fournisseur SAML a besoin de son URL SSO et de son certificat de signature.” — naturel ?
## Japanese

Terms:

- **The navigation's groups**: `app.shell.oversee` is 監督. It holds Activity, Agents and tokens, Webhooks, Integrations, Chat and Administration, and 監督 may read as a supervisor; 運用 is the alternative. `app.shell.build` is 構築, for Projects, Rules, Fields and Import. Is it natural?
- **Earned value** is アーンドバリュー in headings and 出来高 for amounts (`plan.costs.earned`).
- **Field types**: enum is 選択リスト, string is 1行テキスト, and owned is 担当者付きリスト (`problem.fields.onlyEnumBecomesOwned`, `problem.ci.notABuildField`).
- **A work item** is 作業記録. The import pages say 作業項目 for other trackers' work items.
- **A second factor** is 2つ目の要素 (`problem.twoFactor.noPassword`).

Phrasing:

- **関係者** are those who always see an issue or an article: "visible to nobody else" is 「閲覧可能：関係者のみ」 (`issues.issueHistory.visibleTo`), and a limit to them alone 「閲覧者を、常に閲覧できる関係者のみに限定しました。」 (`issues.visibleTo.itSLimitedToNow`, `articles.visibleTo.limitedNow`). Does 関係者 fit them: an issue's reporter and assignee, an article's author, the project's managers, administrators?
- `page.fields.aPlainFact` (a value's neutral colour) is 中立, and `page.projects.blank` (a project template) is 白紙.
- `builds.builds.isPausedBuildsItS`: "refused politely" is 受け付けを断られ.
- **Free text moved to the end**: `problem.apps.catalogUnreadable` (「…問い合わせてください。エラー：{error}」), `problem.workflow.ruleRefusesInItsWords` and `problem.query.invalid`. Does it read naturally?
- **"Your address"** in the help desk's limits (`problem.helpdesk.tooManyFromAddress` and its siblings) is お使いのIPアドレス. The readers are customers.
- `problem.ai.declined` is 応じませんでした, and `problem.roles.stillGiven` counts 「{n}件のユーザーやグループ」.
- `rules.ruleCard.partNoLongerReads`: the rule parts' names (必須条件, 関連する課題の条件, 対象, 通知先, Webhookの呼び出し) were chosen without checking every label in the rule form.
- `activity.ledgerEntry.pullRequestState` uses nouns (「プルリクエストのマージ」); in the history, declined is 却下済み.
- `away.daysAway.addedAway` and `changedAway` are one sentence each: 「追加しました：{whenWords}はあなたが不在のため、…」.
- `server.helpdesk.changedFrom` and `changedPlain`: "Your request has changed" is 「リクエストの状態が変わりました」.
- **A rule's choices in the rule form's Japanese labels**, not English words: `problem.rule.subtaskLinkParent` (「親課題」), `subtaskLinkSubtasks` (「サブタスク」), `saySchedule` and `sayTrigger`.
- **The parser's lines**: 「予期しない「{token}」があります。」, 「閉じかっこ「)」がありません。」, and has: as 「has:の属性「{name}」は存在しません。」.
- **The chat bot's lines** keep spaces around commands and no 。 after a command that ends a line, so the commands copy cleanly (`server.chat.help`).
- **The issue list's count line** shows two colons when its explanation starts with one: 「5件の課題：プロジェクト：BACK、未解決」. Brackets would read 「5件の課題（プロジェクト：BACK、未解決）」.
- `rules.preview.actsScheduled`: does について against に対して carry English's "for each of them" (issues it reaches) against "on each of them"?
- `rules.preview.outside` and `rules.run.leftOutside`: "leaves it alone" is 実行されません and 実行しませんでした. 手を付けません is more colloquial.
- `problem.rule.wouldDoNothing` and `wouldRefuse` end on the quoted refusal (「…：「{refusal}」」) with no 。, since the refusal brings its own punctuation. Acceptable?
- `builds.note.*` have no 。, as English has no full stop, since they sit as notes beside a status.

From the read of wave 4's messages (D50 to D55):

- `articles.articleTree.limited` is 限定公開. Does it read as "limited to some people", or as YouTube's "unlisted"? 閲覧制限 is the alternative.
- 「GitHub Appとして読み取る」 (`page.integrations.readAsAGithubApp` and its family): would 「GitHub Appとしてアクセス」 read more naturally?
- 「異動や退職」 for a person who leaves (`page.integrations.aGithubIntegrationCanRead`, `aPersonSTokenStopsWorking`).
- The board's drop text (`board.board.dropItToMoveToAt` and its siblings) puts the state between the column and の (「Done（Fixedとして）のBACK-19の上に移動」), which may read awkwardly to a screen reader user.

From the read of D56's and D57's messages (customer groups, and CCs on requests):

- `helpdesk.requestCcs.nobody` and `page.portal.nobodyCopied`, "CCはいません。…", treat CC as people. 「CCに追加された人はいません。」 is more explicit, but repeats in the longer message.
- `issues.issueHistory.publicSomeoneCopiedWroteIt`, 「公開：CCの人が記入」, is conversational; CC先 or CCに追加された人 are the alternatives.
- **Kept from the group** (`helpdesk.requestCard.keepFromGroup`, `page.portal.keepPrivate`, `keepFromMyGroup`, `ui.changes.keptFromGroup`) is built on 「{group}に非公開」. 「{group}には非公開にする」 may flow better.
- **SLA time**: 計算 (as the catalog says 営業時間で計算) or 計測, as support tools often say?
- `helpdesk.groups.cantBeGiven`, 「現在は割り当てられません」: 「割り当て不可」 is shorter, but the catalog never uses 不可.
- `page.unsubscribe.what`'s `cc` case, 「CCとして受け取っている、このリクエストに関するメール。」: the comma between the two modifiers may read stiffly.
- `helpdesk.groups.sharingNone`, 「各自が自分のリクエストだけを見る」, where its sibling options say 閲覧できる.
- `server.helpdesk.copiedOnIt` is 「リクエストのCC（チームの返信も届きます）：」, where a company writing to a customer might say 「CCに追加された方（チームからの返信もお送りします）：」.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **Connect** on a whiteboard draws an arrow, so it's 「矢印でつなぐ」 (`page.whiteboard.connect`, `whiteboards.connectDialog.*`, `page.whiteboard.said.connected`), with 始点 and 終点 for the arrow's ends; 接続 stays for networks and accounts. Is つなぐ natural on a toolbar, or would 線でつなぐ or コネクター read better?
- **A whiteboard's name is quoted**, 「ホワイトボード「{name}」を作成しました」 (`activity.ledgerEntry.whiteboardCreated` and its siblings, `issues.issueHistory.madeFromWhiteboard`, `page.whiteboard.deleteTitle`), though English has no quotes and the catalog writes ダッシュボード{name} and ロール{name} without them. Should every name people give be quoted the same way?
- `writing.help` is 文章作成サポート, where 執筆サポート read as writing a manuscript. Does it fit a comment's field?
- **Asana's and ClickUp's menus** are named in English (`imports.fromApi.inAsanaMySettingsApps`, `inClickupSettingsApps`, `problem.imports.source.tokenRefused`): My settings, Apps, Manage developer apps. Asana has a Japanese interface: should they say マイ設定、アプリ… as Redmine's and Zendesk's say their Japanese labels?
- **The chat bot names itself a4a**, never 私 (`server.chat.issue.notInChannel`, `onlyChannels`), and keeps a space after 「/invite @a4a」 so the command copies cleanly, while `server.chat.linkedSlack` writes 「/a4a helpと送ると」 without one.
- `whiteboards.convertDialog.relation` is 「{from}から見た{to}との関係」, so the link phrase chosen under it (depends on) reads in its direction. Too heavy for a label?
- `whiteboards.tone.plain` is 標準 beside アイデア, 合意済み, 質問, 問題 and 保留: is 通常 better? A note's kind puts its tone in brackets, 「付箋（問題）」, since 「問題の付箋」 reads as "the note in question".

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **Sign out everywhere** is 「すべてのセッションからログアウト」 (`page.notMe.signMeOut`, `server.passkeys.signOutEverywhere`, `page.notMe.doneAbout`), as `page.profile.yourPasswordIsChangedAnd` says it, and "a4a signs you out everywhere" is 「a4aがすべてのセッションを終了します」. Many services say 「すべてのデバイスからログアウト」, but a4a ends sessions, not devices. Which reads better to someone an alarming email just reached?
- **A passkey's badges**: `identity.passkeys.synced` is 同期済み, and `identity.passkeys.stopped` (a passkey that may have been copied, stopped for good) is 使用停止. Do they read as "a synced passkey" and "no longer works"?
- `server.passkeys.copied` says the sign count went back as 「a4aが記録している値より古いカウント値で、このパスキーが使われました」. Is it clear to someone who doesn't know authenticators count?
- `server.passkeys.thisWasntMe`, the email's button, is 「心当たりがない」. Would 「心当たりがありません」 or 「自分ではない」 read better on a button?
- **Vouch for** is 保証する (`helpdesk.portalSignIn.domainsHelp`, `throughAny`, `throughSome`). Does "the provider guarantees the address" read to an administrator as OpenID Connect's verified email?
- `helpdesk.portalSignIn.providerAbout` counts desks with 件 (「2件のデスクで提供中」), the counter for things; would つ be more natural for desks?
- `page.notMe.what` is a noun phrase with the time in brackets, 「a4aアカウントannaのパスキー「MacBook」（3時間前）」, under a heading that says what happened. Natural, or should it be a sentence?
- `page.guestPages.noSuchBoard`, `noSuchProject` and `noSuchWhiteboard` keep the issue page's 「ゲストに公開されている、そのような…はありません。」 (`page.guestPages.thereSNoSuchIssue`). 「この…は存在しないか、ゲストには公開されていません。」 reads more naturally, for all four at once.
- `helpdesk.portalSignIn.passwordHelp` names "the form's proof of work" by the form's own setting, 「人が送信したことを確認する」. Clear, or would プルーフ・オブ・ワーク be expected?

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **“Just now” is 数秒前** (`ui.badges.justNow`, was たった今), worded as a relative time so it takes the particle one does: 「{when}に追加」 can't say 「たった今に追加」. Natural, for under 45 seconds?
- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “{label}{v}をプッシュ通知から削除”; `page.admin.askForAPasskeyOf` “{name}の免除を取り消す”; `page.admin.letOffFor` “{name}のパスキーを免除する”. Do they read naturally?
- **What people write on a request** is 書き込み in the relay's emails and the desk's switch: 「{name}様がリクエストに書き込みました。」, 「{name}様の書き込み：」 (`server.helpdesk.relay.lead`, `wrote`, `stop`, `whyAnswer`, `helpdesk.ccSettings.relay`). In a company's email it may read like a forum post: コメント (the tracker's word) or 返信 (the portal's) are the alternatives.
- **An email's Cc and a request's CC** are one word in Japanese. Where they differ, the email's is 「メールのCC」 and whom the requester put there 「CCに入れた人」 (`helpdesk.ccSettings.confirm`, `page.portal.heldNote`, `page.portal.confirm.title`, `server.helpdesk.confirmCopied`, `server.helpdesk.heldForYou`), while a4a's copying stays 「CCに追加」. Is the difference clear?
- **Let off** is 免除: 「免除する」 and 「パスキー免除」 in the people table (`page.admin.letOff`, `letOffPasskeys`), with the requirement as its object (「{name}のパスキーを免除し…」, `letOffFor`). Its undo, English's "Ask for a passkey", is 「免除を取り消す」 (`page.admin.askForAPasskey`). Natural?
- **Authenticator** is 認証器, FIDO's Japanese, beside 認証アプリ for authenticator apps, and attestation 「メーカーによる証明（アテステーション）」 (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`). Too technical for an administrator? The fieldset is 「受け付ける認証器」 (`page.admin.onlySomeAuthenticators`).
- **A check run** is チェック実行, as GitHub's Japanese documentation says, and an issue it names is one it 言及する, as the catalog says of commits (`server.checks.*`, `page.integrations.checks*`). Its titles are sentences without 。 (「3件の課題に言及しています」): would noun phrases (「3件の課題に言及」) suit GitHub's checks list better?
- `boards.history.moved` says a board the reader can't see as 「あるボードで…」. Natural in an issue's history?
- **A lane's own order** is 「レーンごとに個別の並び順を使う」 (`page.board.laneOrder` and its siblings), with 並び順 as in 「ボードの並び順」 and ランク付け for ranking. Would 独自の or 専用の read better than 個別の?
- **The relay's and the hold's emails** say 「ほかの方」, 「この方々」 to customers (`server.helpdesk.relay.whyAnswer`, `server.helpdesk.heldForYou`, which keeps `=1` for 「この方」), while the portal's pages keep 「人」 as they did. Consistent enough?
- `page.integrations.appInstallations` counts accounts with 件 (「2件のアカウント」), as wave 5 counts desks. Would つ read better?
- `helpdesk.requestCard.passkeys`, beside the button that removes them, is a label, 「ポータルのログイン用パスキー：2個」, where English has a sentence. Does it read as the requester's passkeys?
- `page.admin.metadataInUse` calls FIDO's BLOB number 「第{no}号」. Is 「No.{no}」 more usual for a serial?

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **コミットステータス** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): GitHubの日本語UIも「コミットステータス」と書きます。チェック実行との対比で自然ですか？
- `page.group.requirePasskeys` は「このグループのメンバーにパスキーを必須にする」、`page.project.requirePasskeys` は「このプロジェクトを見られる全員にパスキーを必須にする」。「必須にする」より「必須とする」のほうが formal でしょうか？
- `page.group.requirePasskeysHelp` の末尾は「免除は管理者が行います。」。主語を示すこの言い方は、他の「管理者が〜します」の文と揃っていますか？
- `builds.builds.reportCheck` は「各実行の結果をGitHubに報告する」。CIの結果を「報告する」でよいか、「通知する」のほうが自然でしょうか？
- `page.integrations.statusesAudience` は「ステータスは課題をIDでのみ示し」— チェック実行の説明は「IDとリンクで示し」です。対比として読めますか？


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` は「フォロー中の検索条件に該当しました」。通知のタイトルとして「該当」は事務的すぎるか、「含まれるようになりました」のほうが自然か。

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` は既存のゲストページの言い方に合わせました。`issuesMatching` は「{query}」に該当する課題」—「に一致する」「を満たす」のほうがいいですか。

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` 系は既存のツール名に合わせました。`writing.draftedWithTheAssistant` は「この文章はアシスタントが下書きしました。」—「作成しました」のほうがいいですか。

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “描く”、`page.whiteboard.picture` = “画像”、`whiteboards.kind.ink` = “手書きの線”): 道具の名前として自然ですか。

Messages added in wave 13 (Matrix chat):

- Wave 13（Matrix）: `page.chat.matrixHomeserver` は「ホームサーバー」— そのままの表記で自然ですか。

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14（タイムシート）: `page.timesheet.submit` = “週を提出”、`page.timesheet.sendBack` = “差し戻す” — 自然ですか。

Messages added in wave 16 (the script library's page):

- Wave 16（スクリプトライブラリ）: `page.rules.library` = “スクリプトライブラリ”、`page.rules.libraryCode` = “共有コード” — 自然ですか。

Messages added with the configurable approval rule:

- 設定可能な承認: `projects.workTypes.approvalEvery` = “その週の作業を含む全プロジェクトのマネージャーのうち、このプロジェクトのマネージャー” — 長いですが自然ですか。

Messages added in wave 18 (the HR calendar):

- Wave 18（HR カレンダー）: `page.admin.hrCalendar` = “HR カレンダー”、拒否の文言 = “この日々は HR カレンダーから...” — 自然ですか。

Messages added with the timesheet's personal view:

- 個人ビュー: `page.timesheet.bauOrAnythingYouKeep` = “BAU、またはあなたが記録するもの”、拒否文 = “...1 件ずつ変更...” — 自然ですか。

Messages added with the queued scripts:

- キュー: `rules.ruleForm.runFromTheQueue` = “キューから実行: 時間をかけてもよく、ルールが発火した時点の内容に作用します” — 長いですが自然ですか。

With the posts that change in place:

- 投稿はその場で変わります（新しい言葉はありません）。質問: チャネルに編集したことを示すべきですか、静かに差し替えるだけで良いですか。

Messages added with the load grid's team:

- 負荷グリッド: 計画のない人の横の `plan.resources.nothingYet` = “まだ何も” — 短い言葉で伝わりますか。

Messages added with Teams' link unfurling:

- 展開: `server.chat.issue.isShared` = “がチケットを共有しました” — カードの動詞として自然ですか。

With the requester's own language:

- 依頼者の言語: メールはブラウザーの言語に従うようになりました（依頼者に保存）。新しい言葉はありません。質問: ポータルに言語の選択を表示すべきですか、ブラウザーだけで十分ですか。

Messages added with SAML for requesters:

- 依頼者向け SAML: `problem.portal.providers.samlNeedsBoth` = “SAML プロバイダーには SSO URL と署名証明書が必要です。” — 自然ですか。
## Portuguese

`pt.json` was written for Brazil in one pass by a model working from English, then edited by a model for natural Brazilian phrasing. It is now Portugal's Portuguese: a third pass, by a model again and not a native speaker, converted every message to Portuguese as Portugal's software writes it (Microsoft's and Google's interfaces in Portugal the model), read part by part in the order people see them: sign-in and the frame, issues, boards, the inbox and its emails, the help desk, the problems, then the rest. No one from Portugal has read it. These are the choices a native speaker should settle.

Terms:

- **Issue is still *item***, as Portuguese teams read it in Jira (Brazil's Portuguese, the only one Jira ships) and in Azure DevOps ("itens de trabalho"). Do teams in Portugal say *item*, or *issue*, *pedido* or *tarefa*?
- **A sprint is masculine** ("o sprint", "um sprint", "Nenhum sprint terminou ainda": `board.*`, `page.sprintPlanning.*`, `server.notify.verb.addedToSprint`, `problem.reports.*Sprint*`), where Brazil's Scrum Guide says "a Sprint". Is masculine what Portugal's teams say?
- **The help desk is a *centro de apoio*** (`page.help.*`, `page.portal.*`, `server.helpdesk.*`, `helpdesk.*`), its requests *pedidos* and whoever asks the *requerente*. *Apoio ao cliente*, *serviço de apoio* and *helpdesk* are the alternatives; *pedido* is also an HTTP request (`api.client.requestFailed`, `problem.tooLarge`).
- **Reporting an issue is *reportar*** ("Reportado por", "quem reportou", `page.issue.reportedBy`, `page.newIssue.reportIt`), as developers in Portugal say it; Microsoft's Portuguese says *comunicar* ("Comunicar um problema").
- **A link between issues is a *ligação*** (`issues.issueLinks.*`, "Ligação adicionada:"), as Azure DevOps' Portuguese has it, and linking a chat account *associar*; a URL stays a *link*. *Ligação* is also a connection to a server (`board.board.checkTheConnectionAndTry`).
- **Merged is *integrado*** (`issues.issueHistory.linkedPullRequestState`, `vcs.*`); Microsoft's Portuguese says *intercalar*, and developers often say *fazer merge*.
- **A branch is masculine, a build stays *build*** ("o branch", "o build": `problem.ci.*`, `builds.*`). Microsoft's Portuguese says *ramo* and *compilação*; many teams in Portugal say "a build". Which?
- **A role is a *função*** (`roles.*`, `page.profile.youRe`, `problem.access.*`), as Microsoft 365's and Google Workspace's Portuguese say it, and the manager a *gestor*. Does *função* read as "function" anywhere, and is *papel* better?
- **An app is an *aplicação*** (feminine), as Microsoft and Google say it; Apple says "a app". A GitHub App keeps its name (`problem.vcs.githubApp.*`).
- **A tag is an *etiqueta*** (`decide.suggestionCard.tag*`, `problem.tags.*`), while the command language keeps `tag urgent`. Do teams say *tag*?
- **Uploading is *carregar*** ("A carregar {name}…", `editor.richField.uploading`), as Google Drive's and OneDrive's Portuguese say it, which is also "Loading" ("A carregar o plano…"). Is *enviar* clearer for an upload?
- **The browser is the *browser***, as Microsoft's Portuguese says it (`page.profile.yourBrowsersLanguage`, `app.auth.thatSignInRanOut`); Google says *navegador*.
- **A timer is a *temporizador*** (`issues.workLog.*`, `problem.time.timerNotFound`).
- **A person's handle is their *nome de utilizador*** (`app.auth.login`, `problem.users.loginTaken`), which makes "Use o nome de utilizador da pessoa" long; *login* is the alternative.
- **Single sign-on is "SSO"** where the sentence already says *iniciar sessão* (`app.auth.singleSignOn`, `page.profile.singleSignOn`), and *início de sessão único (SSO)* in the terms table.
- **Days away**: Sick is *Baixa médica*, Training *Formação* (`away.words.*`).
- **Earned value is *valor ganho* (VG)** (`plan.costs.earned*`, `evAc*`, `evPv*`), as Portugal's project managers say it; the other figures keep the abbreviations Brazil's PMBOK gave them (VP, CR, IDC, IDP, VC, VPR, ONT, ENT, EPT, VNT, "No término"). Do Portugal's teams read these, or EV, PV, AC, CPI and SPI?
- **Provisioning is *aprovisionamento*, a tenant an *inquilino*** (`identity.provisioning.*`, `page.chat.tenant`, `problem.scim.tokenNotFound`), as Microsoft's Portuguese says them.
- **A commit or a pull request is *associado* to an issue** ("associou o pull request #12", `activity.ledgerEntry.linkedPullRequestTo`, `page.integrations.linked`), apart from a link between issues, a *ligação*.

Phrasing:

- **No você**: Portugal's software leaves the reader to the verb, and the catalog does too, so "Pode", "Tem", "Recebeu este e-mail porque…", "Quis dizer…?". *Você* stays where the code hands the reader in as a name: `decide.suggestionCard.you` ("Você aplicou."), `page.portal.you`, `page.track.you`, `page.track.youAsked` ("<t0>Você</t0> escreveu"), and `server.query.you` (the query's "me", after a preposition and alone: "Assignee: você"). Would "Eu" read better in the portal's thread?
- **Clitics where Portugal puts them**: "{who} atribuiu-lhe o item", "{who} fez-lhe uma menção", "{who} reportou o item e atribuiu-lho" (`server.notify.title.*`). Is *atribuiu-lho* too literary for a notification's title?
- **Status lines are "a" + infinitive**: "A carregar o plano…", "A guardar…", "A iniciar sessão…" (`loadingLine.*`, every `*.saving`, `*.loading`).
- **Quotation marks are «…»**, with “…” inside, as Portugal's print and the EU's Portuguese style write them (258 messages, among them `ui.quoted`, which quotes a command, a search, a script's comment or an app's name on a page). Microsoft's and Google's Portuguese often use "…" in their interfaces: which do Portuguese readers expect on a page?
- **Limits** are "Demasiados pedidos em pouco tempo. Tente novamente daqui a 30 s." (`problem.rateLimited`) and "… Tente novamente daqui a 2 minutos." (`problem.helpdesk.tooMany*`, `problem.tooManySignIns`).
- **A day in a sentence takes *a***: "Reportado por Ana a 4/12/2026" (`page.issue.reportedBy`, `ui.badges.onDate`), since Intl's `pt-PT` writes short dates as numbers.
- **The query's count line still puts the count last** ("Itens no projeto SPR, não resolvidos: 4", `issues.queryBar.found*`): 0 is plural now, but the participles after it agree with the issues, not the count.
- **The profile** is "Perfil" in the menu and on its page (`app.shell.yourProfile`, `page.profile.yourProfile`); "O seu perfil" is the alternative.
- **iPhone's own words** are quoted as its Portuguese (Portugal) writes them: "toque em Partilhar, depois em Adicionar ao ecrã principal" (`notifications.pushSettings.onAnIphoneOrIpad`). An iPhone set to Brazil's Portuguese says "Compartilhar" and "Adicionar à Tela de Início".
- **The reader among people**: a list marks the reader "(eu)" (`plan.resources.you`, `page.whiteboard.you`), the people table " · a sua conta" (`page.admin.you`), and the projects table's column of the reader's role "A sua função" (`page.projects.you`).
- **A rule names the issue it acts on** where English says "it": "o item pai", "as subtarefas", "os itens que o item {phrase}" (`rules.words.*`, `rules.ruleForm.*`), and the rule problems quote the same words (`problem.rule.subtaskLinkParent`, `subtaskLinkSubtasks`). Is "o item pai" heavy beside "o pai"?
- **Gender left unguessed** costs length, as it did for Brazil: "quem fez o pedido", "a pessoa responsável", "Este pedido só é visível para si e para a equipa". Check the badges and narrow columns at 390px.

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey is a *chave de acesso*** (`identity.passkeys.*`, `app.auth.signInWithAPasskey`, `server.passkeys.*`), as Microsoft's and Google's Portuguese say it; Apple's says *chave-passe*. Does it stay apart from a *token de acesso* and the portal's *link de acesso*?
- **Through a provider**: buttons say "Iniciar sessão com {name}" (`page.portal.signInThrough`), as the team's sign-in does, and the desk's settings, its history and sentences "através de {name}" (`helpdesk.portalSignIn.through`, `helpdesk.groups.throughAlone`, `activity.ledgerEntry.signInThrough`). One throughout?
- **Vouching**: a requesters' provider *confirma* an email (`helpdesk.portalSignIn.throughAny`, `throughSome`, `domainsHelp`), and a requester is told the provider "não é aceite para endereços como o seu" (`page.portal.ssoDomain`). *Garantir* or *responder por* are nearer "vouch for".
- **OpenID Connect's words**: "Emissor", "ID do cliente", "Segredo do cliente", "URI de redirecionamento" and "documento de descoberta" (`helpdesk.portalSignIn.*`, `problem.portalSignIn.issuer*`, `providerUnreachable`). Would administrators rather read "issuer", or *deteção* for discovery?
- `identity.passkeys.stopped`, the red badge on a passkey that may have been copied, is "Bloqueada"; "Parada" and "Suspensa" are the alternatives.
- `page.guestPages.alsoOpenIn`, the heading over a project's plan, reports, boards and whiteboards on a guest's page, is "Também aberto em {name}". "Também em {name}" is shorter.
- **The passkey emails' time** is in brackets, "… da sua conta do a4a, ana (quarta, 18/11, 14:03 WET)." (`server.passkeys.added`, `removed`, `removedByAdmin`, `copied`): it begins with a weekday, which *a* reads wrong before ("a sábado").
- **Signing out everywhere** is "Terminar todas as sessões" (`page.notMe.signMeOut`, `server.passkeys.signOutEverywhere`); "Terminar sessão em todo o lado" is the alternative.

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “Remover {label}{v} das notificações push”; `page.admin.askForAPasskeyOf` “Pedir chave de acesso a {name} de novo”; `page.admin.removePasskeysOf` “Remover chaves de acesso de {name}”; `page.admin.resetTwoFactorFor` “Repor dois passos de {name}”; `page.admin.sendALinkTo` “Enviar link a {name} para adicionar uma chave de acesso”. Do they read naturally?
- **A lane's own order** is "Cada raia tem a sua própria ordem" (`page.board.laneOrder*`), keeping the board's *raia*, and a card's moves in its issue's history are "colocou o item acima de BACK-31 no quadro Platform board" (`boards.history.moved`). Would "moveu o item para cima de" read better?
- **A check run stays *check run*** ("o check run": `page.integrations.checks*`, `server.checks.*`, `problem.vcs.checks.needsApp`), as GitHub's pages name it and as the catalog keeps commit, branch and pull request; GitHub's Portuguese documentation, Brazil's, says *execução de verificação*. A pull request *cita* the issues it names ("Cita 3 itens"), as a commit does.
- **A held Cc**: the desk's switch is "Reter as pessoas em Cc de um pedido novo até quem fez o pedido as confirmar" (`helpdesk.ccSettings.confirm`), the headings "À espera da confirmação de {requester}" and "À espera da sua confirmação" (`helpdesk.requestCcs.held`, `page.portal.heldTitle`), and dropping someone "Descartar", who then "ficou de fora" (`page.portal.dropHeld`, `heldDropped`, `confirm.dropped`). The email's field stays "Cc" ("as pessoas em Cc"), as Outlook names it. Is *reter* right, or *pôr em espera*?
- **Relaying** is *transmitir*, "o centro de apoio transmite o que cada pessoa escreve" (`helpdesk.ccSettings.relay`, `server.helpdesk.relay.*`, the `relay` case of `page.unsubscribe.what`). *Reencaminhar* is the alternative, but the emails aren't forwards.
- **An authenticator** is an *autenticador*, which its maker *atesta*: "O fabricante desta chave de acesso não a atestou" (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`, `unknownMaker`); *garantir* or *certificar* are the alternatives. The allowlist is "Só alguns autenticadores", "Aceitar novas chaves de acesso só dos autenticadores selecionados" (`page.admin.onlySomeAuthenticators`, `takeOnlySome`), and FIDO is feminine, as its alliance is: "os metadados da FIDO" (`page.admin.metadata*`).
- **Letting someone off** passkeys is *dispensar*: the button "Dispensar", and "com dispensa de chave de acesso" in the people table (`page.admin.letOff*`, `problem.passkeys.lastAdmin`, `wouldLockOut`); *isentar* is the alternative. Requiring them is "Pedir chave de acesso ao iniciar sessão", "Aos administradores", "A todos os que iniciam sessão com palavra-passe" (`page.admin.requireAPasskey`, `requireOf*`), as two-factor's "Pedir também…" says it, and in a sentence they're *obrigatórias* (`app.auth.passkeysAreRequiredOfYou`, `identity.passkeys.requiredOfYou`).
- **An account with no password** is "Só chaves de acesso" in the people table and "Iniciar sessão só com chaves de acesso" on the profile (`page.admin.passkeysAlone`, `identity.passkeys.passkeysAlone`), and its setup link "um link para adicionar uma chave de acesso" (`page.admin.sendALink*`, `page.passkeySetup.*`, `server.passkeySetup.*`), apart from the portal's *link de acesso*.
- **A passkey provider** is a *gestor de chaves de acesso* (`identity.passkeys.keepASpare`, `problem.passkeys.spareFirst`, `server.passkeySetup.leadFirst`), as a password manager is a *gestor de palavras-passe*. Do Portugal's phones say *fornecedor de chaves de acesso*?
- **Forgejo's and Gitea's settings** are named as their Portuguese pages name them, "em Aplicações" (`builds.builds.forgeKeepsToken`, `tokenTooWide`); an instance in English says "Applications".
- **The emails' time** is in brackets again, "… foi removida (quarta, 18/11, 14:03 WET)" (`server.passkeys.passwordRemoved`, `server.portalPasskeys.lead`, `removedByTeam`), since it begins with a weekday.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Um estado de commit** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): o catálogo escreve "commits" sem traduzir; a documentação do GitLab em português também diz "estado do commit". Fica "estado de commit"?
- `page.group.requirePasskeys` é "Exigir uma chave de acesso às pessoas do grupo" e `page.project.requirePasskeys` "…a toda a gente que possa ver este projeto". "Exigir a alguém" está correto; "a toda a gente que possa" é subjuntivo natural num rótulo?
- `page.project.requirePasskeysHelp` começa "A partir do próximo início de sessão, para quem entra com a palavra-passe do próprio a4a." O "para quem" em cadeia com a frase nominal: natural?
- `builds.builds.reportCheck` é "Comunicar ao GitHub o resultado de cada execução". "Comunicar" num interruptor: natural, ou "reportar"?
- `page.integrations.statusesTurnedOn` segue os check runs: "Estados de commit ativados: cada pull request recebe um na próxima vez que mudar." O plural "Estados de commit ativados" está claro (ativados é o interruptor, não os estados)?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` é “Entrou numa pesquisa que segue”. É a ordem natural em português, ou diria “passou a constar numa pesquisa que segue”?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` segue as irmãs (“aberto a convidados”). `issuesMatching` é “Itens que correspondem a”: natural, ou “que cumprem”?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` e `linkTo` seguem as ferramentas existentes. `writing.draftedWithTheAssistant` é “O assistente redigiu estas palavras.” — ou “escreveu”?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “Desenhar”, `page.whiteboard.picture` = “Imagem”, `whiteboards.kind.ink` = “um desenho”): natural, ou “Traçar” e “Foto”?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = “Homeserver” — mantém-se o termo, ou “servidor Matrix”?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (folha de horas): `page.timesheet.submit` = “Enviar a semana” e `page.timesheet.sendBack` = “Devolvê-la” — naturais?

Messages added in wave 16 (the script library's page):

- Wave 16 (biblioteca de scripts): `page.rules.library` = “Biblioteca de scripts” e `page.rules.libraryCode` = “O código partilhado” — naturais?

Messages added with the configurable approval rule:

- A aprovação configurável: `projects.workTypes.approvalEvery` = “Os seus gestores, entre os gestores de cada projeto onde a semana tem trabalho” — natural, apesar de longo?

Messages added in wave 18 (the HR calendar):

- Wave 18 (calendário de RH): `page.admin.hrCalendar` = “Calendário de RH” e a recusa “Estes dias vêm do calendário de RH...” — naturais?

Messages added with the timesheet's personal view:

- A vista pessoal: `page.timesheet.bauOrAnythingYouKeep` = “BAU, ou o que registar” e a recusa “...Mude-as uma a uma.” — naturais?

Messages added with the queued scripts:

- A fila: `rules.ruleForm.runFromTheQueue` = “Executar a partir da fila: pode levar o seu tempo e age sobre o que viu quando a regra disparou” — natural, apesar de longo?

With the posts that change in place:

- As publicações mudam no sítio – sem palavras novas; uma pergunta: deve ver-se no canal que foi editada, ou basta o conteúdo trocado em silêncio?

Messages added with the load grid's team:

- A carga: `plan.resources.nothingYet` = “Nada ainda” ao lado de quem não tem trabalho planeado — a palavra breve serve?

Messages added with Teams' link unfurling:

- O desdobrar: `server.chat.issue.isShared` = “partilhou a tarefa” — o verbo assenta na carta?

With the requester's own language:

- A língua do requerente: os emails seguem agora a do navegador (guardada no requerente). Sem palavras novas; uma pergunta: a página do portal deve mostrar um seletor de língua, ou o navegador basta?

Messages added with SAML for requesters:

- SAML para requerentes: `problem.portal.providers.samlNeedsBoth` = “Um fornecedor SAML precisa do seu URL de SSO e do seu certificado de assinatura.” — natural?
## Korean

Korean was translated in one pass, from English, the code and [translating.md](translating.md), by a model working alone, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Its messages were checked by machine for what a catalog must keep (every placeholder, tag, select case and `#`, Korean's one plural category) and read in a browser through the sign-in page, the issues, an issue, the inbox and the profile.

Terms:

- **Issue** is 이슈, as Jira's Korean and Korean developers say it. Jira Cloud's newer Korean calls work items 작업 항목; a4a keeps 이슈. Right for a tracker in 2026?
- **Watch, watchers** are 지켜보기 and 지켜보는 사람, plain and long. Jira's Korean, as far as the translator recalls, says 주시 or 관찰자; Korean websites say 관심 등록. Which does a Korean team expect on an issue's watch button?
- **Inbox** is 수신함, as Notion's and Asana's Korean say, rather than 받은 편지함, which reads as an email client's.
- **Roles**: 관리자 is the administrator, so a project's manager is 매니저, and member and viewer are 멤버 and 뷰어, as Google Drive's and Slack's Korean give roles. 구성원 and 보기 전용 are the alternatives.
- **Triage** is 트리아지, a loanword: 분류 reads as a category.
- **Knowledge base** is 지식 베이스 (Zendesk's Korean) and an article 문서; Jira Service Management's Korean says 기술 자료.
- **Committed** (a sprint's commitment) is 확정, to keep 커밋 for version control.
- **Digest** is 요약 메일, though 요약 alone is an issue's summary, as in Jira's Korean.
- **CC** is 참조, as Korean mail clients say it: 참조에 추가, 참조에서 제외.
- **Revoke** is 폐기 for a token, and 승인 취소 for an app you allowed (승인한 앱).
- **Workflow actions** (an issue's buttons) are 동작, since 작업 is already work and tasks.
- **Login** (a person's handle) is 로그인 ID. Korean websites say 아이디.
- **The navigation's groups**: 작업 (Work), 결정 (Decide), 구성 (Build) and 운영 (Oversee). 결정 holds only Suggestions; is 검토 better?
- **Planning**: what-if is 가상 계획, levelling 평준화, slack 여유 시간, critical path 주 경로 (Microsoft Project's Korean), earned value 획득 가치, booked 배정.

Phrasing:

- **Register**: statements are 합니다체 and what's asked of the reader is "-세요", as Google's and Microsoft's Korean mix them. The help desk's pages and emails, which customers read, use the same, with "{name}님" and "보내 드립니다". Should they be softer ("-해 주세요" throughout) or more formal ("-하십시오")?
- **Particles after values** are written both ways in the catalog, 을(를), 이(가), 은(는), (으)로, and a4a chooses the one a value needs after Hangul or a digit ("BACK-12를", "민준이"). After a Latin word both stay ("Anna을(를)"): should a4a guess a Latin word's end by its sound (ID 아이디, Done 던), or is both ways what Korean readers expect there? The subject's is written 이(가), not (이)가.
- **"You"** is 나 in notification titles ("Ada이(가) 나에게 할당했습니다", "나를 멘션했습니다"), as a list's filter says 나에게 할당됨; Facebook's and Slack's Korean say 회원님. Does 나 read naturally in a title addressed to the reader?
- **The ledger and an issue's history** draw the actor's name, then a verb phrase in the polite past with no particle: "**Ada** BACK-12을(를) 변경했습니다". Would the terse 개조식 ("변경함") read better in a log?
- **A rule's sentence** lists its actions as nouns joined by Korean's list ("Assignee anna 적용, “확인하세요” 댓글 작성 및 웹훅 호출."). Do verbs read better?
- **A webhook's events** are nouns ("이슈 생성"), joined into "{join} 시" by Intl's "or" list (" 또는 "). The form's checkboxes say the same nouns, as labels of their own (`page.webhooks.label.*`).
- **The board's drag announcements** (`board.board.dropItTo*`) are long sentences for a screen reader: "여기에 놓으면 BACK-1을 Done 열(Fixed)로 옮기고 Anna에게 할당합니다".
- **"Did you mean"** in a problem is "혹시 “{guess}”인가요?"; on the issue list's query bar it is "이런 뜻인가요? {el}".
- A rule run's whom-it-told list ends "및 다른 3명" (`rules.run.toldOthers`), since Korean's list puts 및 before the last item.

Typography and layout:

- **Line breaks**: the browser breaks Korean between any two syllables (CSS `word-break: normal`), so a word can split across lines ("선택하/세요"). Korean typesetting breaks at spaces (`word-break: keep-all`), which would be Ocean's to set for `:lang(ko)`; it isn't set, since a long unspaced word could then push past a phone's width.
- **Fonts**: the container's shots use WenQuanYi Zen Hei. Judge spacing with Noto Sans KR, Apple SD Gothic Neo or Malgun Gothic.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard's note** is 메모 (`page.whiteboard.addNote`, `whiteboards.kind.note`), as the catalog says a dashboard's note, and short on the toolbar. Whiteboard apps' Korean says 스티커 메모 or 스티키 노트. Which do Korean teams expect?
- **Undo and redo** on a whiteboard are 실행 취소 and 다시 실행 (`page.whiteboard.undo`, `redo`, `said.undid`, `said.redid`), as editors say them; undoing an agent's change or an import stays 되돌리기. Does "이동을 실행 취소했습니다" read naturally, or is "이동을 되돌렸습니다" better?
- **The outline** is 개요 (`page.whiteboard.outline`, `whiteboards.outline.title`), as Google Docs' Korean says a document's; a section is 섹션, and an arrow's label 레이블 (`whiteboards.textDialog.label`). 아웃라인 and 라벨 are the alternatives.
- **Converting** is 이슈로 만들기 (`page.whiteboard.convert`, `whiteboards.convertDialog.title`). A preview's lines are in the present (`whiteboards.convertDialog.wouldMake` "이슈가 됩니다: …", `wouldLink` "링크됩니다: …") beside the result's past (`made` "BACK-12가 되었습니다: …"). Clear as a preview?
- **Zero**: `activity.ledgerEntry.whiteboardConverted` and `page.whiteboard.said.converted` say "링크 0개" where English says "no links", since their plurals keep `other` alone. Should they keep English's `=0`?
- **A chat thread's replies** are 답글 (`page.issue.source.replies`, `server.chat.issue.withReplies`), as Slack's Korean says them, kept apart from the help desk's 답장.
- **The bot names itself** in `server.chat.issue.notInChannel` and `onlyChannels` ("a4a가 #eng에 참여하고 있지 않습니다"), where English says "I'm not in" and the bot's other lines leave the subject out, so the reader doesn't take it for themselves.
- `issues.watching.commented` and `wroteTheMessage` are 댓글 작성자 and 원본 메시지 작성자, nouns beside 보고자 and 담당자 under a watcher's name.
- `page.whiteboard.you` is "{name}(나)" in the list of who's looking (`page.whiteboard.lookingNow`, 지금 보는 사람). Natural?

Edited for natural phrasing:

A second pass, by a model again, read the catalog as Korean software rather than as a translation: sign-in and the frame, the issues and an issue, boards, the inbox and its emails, the help desk, then the ledger, query problems, projects, dashboards and articles, and across the rest the patterns below. It changed about 600 messages. These are what it couldn't settle:

- **The sign-in form's name** (`app.auth.a4aLogin`, `a4aOrLogin`, `login2`) is "a4a 계정", "a4a 또는 {name} 계정", "{name} 계정", as Google's Korean says "Google 계정 사용", so the page reads "a4a 계정을 사용하세요" and a4a chooses the particle. Is 계정 right for a directory's credentials ("Corp LDAP 계정")?
- **"I've kept them: continue"** after recovery codes and a mailbox secret (`app.auth.iVeKeptThemContinue`, `helpdesk.helpdeskMail.iVeKeptIt`) is "보관 완료", as Korean apps say "입력 완료". Does it read as the reader's acknowledgment, not a status?
- **Acting as the reader** is "내 계정으로" (`ui.who.throughTheApiAs`, `activity.ledgerEntry.fromAs`, `page.profile.teamsAndSlackAccountsThat`, `page.chatLink.*`, `agents.oAuthApps.*`), and as itself "자체 계정으로" (`ui.who.overMcpAsItself`, `activity.ledgerEntry.throughTheApiAsItself`). The catalog said "나로", which reads as the speaker. Is "내 계정으로" what Korean teams say, or "나 대신"?
- **Two clauses** were joined with English's colon in about 180 messages; they're two sentences or one with a connective now (`rules.ruleCard.itSOffItDoes` "꺼져 있어 다시 켤 때까지 아무것도 하지 않습니다.", `problem.customerGroups.groupNotFound`, `builds.builds.*`, `page.integrations.*`). A status label keeps its colon ("꺼짐:", "일시 중지됨:", `identity.twoFactor.offYourPasswordAloneSigns`, `page.webhooks.itIsPausedNothingIs`). Is that where Korean draws the line?
- **What the help desk asks of a customer** is "-어 주세요" on its form and request page (`page.help.aLineWhatYouWere`, `page.help.whatYouDidWhatYou`, `page.help.weVeEmailedALink`) and "-세요" elsewhere. Softer throughout the portal and its emails?
- **An email's footer** is a sentence: `server.mail.why` "{because} 받는 메일입니다." with each `server.notify.because.*` a clause ("이슈를 지켜보고 있어서"), and `server.mail.whySubscribed`, `server.mail.digest.why` the same. Korean services often write "~하여 발송된 메일입니다". Which reads better in a team's tool?
- **An issue's meta line** puts the date last, after a comma: "보고자: Anna, 2026년 11월 16일", "헬프데스크 요청자: Anna, …" (`page.issue.reportedBy`, `page.issue.askedByThroughTheHelp`). The date is a value inside each message, so it can come first. Natural as it is?
- **Asking in words** is "자연어로 묻기" (`issues.queryBar.askInWords`, `issues.languageField.askInWords`), its field "할 일을 문장으로 입력" (`issues.commandBar.sayWhatToDoIn`), and the history's channel "자연어 요청으로" (`issues.issueHistory.askedInWords`). 자연어 is what Korean AI products say; does it read too technical beside "말로"?
- **A name a4a can't show** is "알 수 없는 사용자" (`issues.issueHistory.someone`, `page.guestPages.someone`, `activity.ledgerEntry.someone`, `page.dashboard.someone`), where the catalog said 누군가. `server.notify.someone` keeps 누군가, since a notification's title reads "누군가가 변경했습니다".
- **Paging on the guest pages** is "더 최근" and "더 이전" (`page.guestPages.newer`, `older`). Korean boards say 이전/다음 for pages; is newer/older better kept?
- **An SLA policy's summary** reads "모든 요청: 첫 응답 1h 이내, 해결 8h 이내. 기한 2h 전부터 위험으로 표시합니다." (`helpdesk.sla.atRiskBefore`, `firstResponseIn`, `resolvedIn`). The durations are a4a's own short forms; is "1시간" expected there?
- **Reading versus viewing**: access is "보다" in what this pass touched (`page.profile.roleViewer` "뷰어(보기만 가능)", `page.admin.aViewerReads`, `page.issue.youCanReadSIssues`) and on whiteboards (`page.whiteboards.about`, `noneAbout`, `projectHelp`, `page.whiteboard.readOnly`), and still "읽다" elsewhere (`problem.access.signInFirst`, `projects.peopleAndAccess.youReadCommentOnAnd`, `roles.words.read`), while a4a reading an API stays "읽다" (`page.integrations.*`, `imports.*`). One verb for access throughout?

Edited for natural phrasing, second round:

A third pass, by a model again, read whole what the second only swept: the plan, rules, reports, integrations, imports, apps, webhooks, agents, workflow, builds, version control, whiteboards, roles, groups, identity, and their problems. It changed 584 messages. These are what it couldn't settle:

- **Choosing** is "선택하세요" in these parts, and "고르세요" in 22 messages elsewhere (`page.plan.chooseAProjectToSee`, `page.reports.chooseABoardWithSprints`, `page.oAuthConsent.chooseAtLeastOneProject`, `problem.ai.issueNeeded`, …). Korean software mostly says 선택; should the catalog say it everywhere?
- **A form's labels** name what goes in, where English chains its sentence ("And tell", "And call a webhook", "apply"): `rules.ruleForm.andTell` "알릴 대상", `andCallAWebhook` "호출할 웹훅", `apply` "적용할 명령", `and` "추가 조건", `in` "대상 필드". The query beside them is "다음 쿼리에 일치" (`rules.ruleForm.itMatches`, `itsParentMatches`, `aChangeWouldMakeAn`, …), since "다음에 일치" also reads as "matches next time". Does the form still read as one rule?
- **A rule card's last run** puts when and where in parentheses: "마지막 동작(3분 전, BACK-12): Priority, State." (`rules.ruleCard.lastActed`, `lastFailed`, `lastRan`, `lastRan2`, `lastRefusedAChange` with `rules.ruleCard.by` ": Anna의 변경"). Natural, or "3분 전 BACK-12에서 동작: …"?
- **An app's install line** names who installed it as the subject: "3분 전 Anna이(가) 카탈로그에서 설치했습니다." (`apps.appsSection.itsRulesActAsInstalled`, which words the line with the installer and without). Without a name it reads "3분 전 설치했습니다". Is "설치됨" better there?
- **A what-if's lead** moves the replaced assignee before the new one: "BACK-1을 Ben 대신 Anna이(가) 맡으면, 계획이 2일 늦게 끝납니다." (`plan.timeline.ifDoes`, `insteadOf`, whose space now trails it). Clear?
- **Copied things are named so a4a can choose the particle** in the copy button's status: `page.integrations.theUrl` "웹훅 주소", `builds.builds.theUrl` "빌드 수신 주소", `page.webhooks.theCheck` "서명 확인 코드" ("웹훅 주소를 복사했습니다"). Are the names right for what is copied?
- **A mapping's date fields** are "생성됨", "업데이트됨", "해결됨" (`imports.mappingTable.whenCreated`, `whenUpdated`, `resolved`), as YouTrack's Korean names them. The tally's counts are messages of their own now (`imports.mappingTable.created`, `updated`: "생성됨 12"), so the fields could say "생성일", "업데이트일", "해결일" without reading as a date beside a count. Which does the field list want?
- **A count widget** reads "이슈 12개" with the number bold and "이슈" the link (`reports.widgets.issueCount`), where English shows the number first. Does a dashboard read better as "12건"?
- **Never** is "만료 없음" in the expiry select (`page.agents.never`, `agents.agentAccounts.never`), and "없음" under "마지막 사용" and "만료일" (`page.agents.neverUsed`, `neverExpires`, `agents.agentAccounts.neverUsed`, `neverExpires`, `agents.oAuthApps.never`), where one message said "없음" in all three, and before that "안 함", which read as "won't" beside a date. Right in each place?
- **An agent's facts** say "동작 계정: 내 계정(토큰 사용)" (`page.agents.worksFor`, `youWithItsToken`). Natural for "Works for: you, with its token"?
- **The load window's spans** are "2주", "1개월", "3개월", "계획 종료일까지" (`plan.loadWindow.*`), where they said "한 달" and "분기". Is "분기" what a planner expects?
- **Plan badges and status**: `reports.burndown.onTrack` "계획대로", `ahead` "앞서 있음", `plan.costs.onSchedule` "일정대로 진행 중입니다.", `plan.gantt.done` "완료율" (a column header that said "완료"). As Korean planning tools say them?
- **An import's progress** puts the total first, in Korean's order: "지금까지 약 100개 중 이슈 12개를 읽었습니다." (`page.import.issuesReadSoFar`, `ofAbout`, whose space now trails it), and the undo "이슈 3개를 제거했습니다. 1개는 남았습니다." (`page.import.issuesTakenAway`, `stayed`). Clear?

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **Removing**: a passkey is 삭제 (`identity.passkeys.remove`, `removeTitle`, `page.admin.removePasskeys`, `server.passkeys.removed`), as Google's and Apple's Korean delete one, and an identity provider for requesters is 제거 (`helpdesk.portalSignIn.remove`, `removeTitle`), as the catalog removes apps and integrations. One verb for both?
- **"Everywhere"** is 모든 기기에서 (`page.notMe.signMeOut`, `doneAbout`, `server.passkeys.signOutEverywhere`, `notYou`), as Korean services say "모든 기기에서 로그아웃", though a4a ends every session, and the profile says "모든 세션에서 로그아웃되었습니다" (`page.profile.yourPasswordIsChangedAnd`). Does 기기 mislead where two browsers share a computer?
- `server.passkeys.thisWasntMe`, the mail's button, is "본인이 한 일이 아님". Korean services write "본인이 아닙니다", or Toss's "내가 아니에요". Which reads as the reader's own answer?
- `server.passkeys.copied` says "이미 지나간 사용 횟수로 사용된 것을 a4a가 확인했습니다" for "used with a count it had already passed". WebAuthn's Korean docs say 서명 카운터: should the mail name it?
- **A passkey's notes** beside its badge are 개조식, as the catalog's other fragments beside a name are: `identity.passkeys.mayBeCopied` "복사되었을 수 있어 아무도 로그인할 수 없음", `elsewhere` "{host}용으로 만들어져 여기서는 로그인할 수 없음". Natural there?
- **A provider as a way to sign in** is "{name} 계정" in the desk's settings, a customer group and the ledger (`helpdesk.portalSignIn.through`, `helpdesk.groups.throughAlone` "{name} 계정만", `helpdesk.groups.signsInThrough`, `activity.ledgerEntry.signInThrough`, `problem.portalSignIn.groupSignsInThrough`), as the terms table says a form's credentials, and the portal's button is "{name}(으)로 로그인" (`page.portal.signInThrough`), as the team's sign-in page says it. Do they read as one way?
- **OpenID Connect's words** for an administrator: "발급자(Issuer)" (`helpdesk.portalSignIn.issuer`; 발급자 in `problem.portalSignIn.issuerNotUrl`, `issuerShape`, `providerUnreachable`), "클라이언트 ID", "클라이언트 시크릿", "리디렉션 URI" and "디스커버리 문서", mostly as Microsoft Entra's Korean names them. Is 발급자 what an administrator looks for, or Issuer, as most providers' consoles show it? The redirect URI's copy button then says "리디렉션 URI을(를) 복사했습니다", both ways after a Latin word.
- **The emailed link** is "이메일 링크" as a way's name (`activity.ledgerEntry.signInByLink`, `problem.portal.linksOff`, `problem.portalSignIn.oneWayAtLeast`), "이메일로 보내는 링크" on the desk's checkbox (`helpdesk.portalSignIn.link`), and "이메일로 받은 링크" to a requester (`page.portal.wayLink`). One name throughout?
- **The register for requesters**: the mails about their sign-in say "보내 드립니다", "알려 주세요" and, once, the honorific "처음 로그인하셨습니다" (`server.portalAccount.lead`, `why`, `server.portalPassword.why`), where the portal's pages say "로그인했습니다" (`page.portal.signedInWith`), as `page.portal.signedInAs` does. Should the pages take the honorific too, or the mail drop it?
- `page.notMe.ifNotYou` asks where English tells: "본인이 하지 않았다면 모든 기기에서 로그아웃하세요." for "If this wasn't you, a4a signs you out everywhere…", since the button under it does that. Right?
- **A guest's pages**: the project's other open pages are under "{name}에서 함께 공개된 항목" (`page.guestPages.alsoOpenIn`), and a missing one reads "게스트에게 공개된 보드 중에 이 보드는 없습니다" (`noSuchBoard`, `noSuchProject`, `noSuchWhiteboard`), as an issue's does. Natural?
- `page.admin.letPeopleUsePasskeys` is a sentence, "사용자가 패스키로 로그인할 수 있게 합니다.", as its two-factor neighbour (`page.admin.askEveryoneWhoSignsIn`) is. Should both be short labels, such as "패스키 로그인 허용"?
- `helpdesk.portalSignIn.providerAbout` counts desks with 개 ("헬프데스크 3개에서 제공"), as the catalog counts projects, and `page.project.portalSignInNote` repeats its heading's "로그인 방법" ("요청자가 자기 요청을 보는 포털에 로그인하는 방법"). Would 곳 read better, and a shorter note?

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **“Just now” is 몇 초 전** (`ui.badges.justNow`, was 방금), worded as a relative time so it takes the particle one does: “{when}에 링크를 보냄” can't say “방금에”. Natural, for under 45 seconds?
- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “푸시 알림에서 {label}{v} 제거”. Do they read naturally?
- **A check run** is 체크 (`page.integrations.checksLegend` "풀 리퀘스트 체크", `checksOn`, `server.checks.*`, `problem.vcs.checks.needsApp`), as Korean developers say GitHub's checks; GitHub Docs' Korean says 검사 실행. Its title is 개조식, as GitHub lists it beside "a4a" (`server.checks.title.named` "이슈 3개 언급", `unresolved` "언급한 이슈 중 2개 미해결"). 체크, 체크 런 or 검사?
- **An authenticator**, what makes a passkey, is 인증기 (`page.admin.onlySomeAuthenticators` "일부 인증기만 허용", `findAnAuthenticator`, `identity.passkeys.onlyThese`, `problem.passkeys.notListed`), kept apart from 인증 앱; Microsoft's Korean says 인증자. Its maker's attestation is "제조사의 증명" (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`), and a passkey provider is 패스키 공급자 (`identity.passkeys.keepASpare`, `server.passkeySetup.leadFirst`), where Apple's and Google's Korean name a password manager (암호 관리자, 비밀번호 관리자). Right for an administrator and for the profile?
- **Letting someone off** required passkeys is 면제 (`page.admin.letOff`, `letOffFor` "{name}을(를) 패스키 요구에서 면제", `letOffPasskeys` "패스키 면제", `problem.passkeys.lastAdmin`). Natural?
- **An account with no password** is "패스키만" in the people table (`page.admin.passkeysAlone`, under it `linkRunsOut` "패스키 추가 링크 3일 후 만료"), and "패스키만으로 로그인" on the profile (`identity.passkeys.passkeysAlone`); the administrator's link is "패스키 추가 링크" (`page.admin.sendALinkTo`, `server.passkeySetup.subjectAgain`). Clear?
- **An email's Cc** is 참조, as Korean mail clients name the field, which is also a request's word for copying: "새 요청 메일의 참조(Cc)" (`helpdesk.ccSettings.confirm`, the only place with "(Cc)"), "이 요청을 만든 이메일의 참조" (`helpdesk.requestCcs.heldNote`). A held one waits, "확인 대기 중" (`helpdesk.requestCcs.held`, `page.portal.heldTitle`), held is 보류 on the desk's settings, and dropping one is "추가 안 함" (`page.portal.dropHeld`). Does "메일의 참조" read as the email's field rather than the request's copies?
- **Relaying** is 전달, and what others write is 글 ("요청 참여자 모두에게 서로의 글 전달", `helpdesk.ccSettings.relay`, `page.project.copiedOnRequestsNote`, `page.unsubscribe.what`'s `relay`), beside the team's 답변 and a requester's 답장. The relay mail names its writer with 님 ("{name}님이 요청에 글을 남겼습니다", `server.helpdesk.relay.lead`, `wrote` "{name}님이 남긴 글:"), since requesters, people copied and colleagues are all outside the team. Right?
- **The register of the portal's passkey mails**: the reader's acts take the honorific ("직접 추가하셨다면 따로 하실 일은 없습니다", "로그인하신 후", `server.portalPasskeys.ifItWasYou`, `lead`, `signInAndAddAgain`), as `server.portalAccount.lead` does, and asks are "-어 주세요" (`server.portalPasskeys.notYou`); the team's passkey mails (`server.passkeys.*`, `server.passkeySetup.*`) take neither. `server.helpdesk.heldForYou` ends its sentence with a colon before the names ("참조에 넣으신 2명은 확인해 주시기 전까지 아무것도 받지 않습니다:"). Consistent enough?
- **A lane's own order** is "레인마다 순서를 따로 유지" (`page.board.laneOrder`, `laneOrderOn`, `laneOrderTurnedOn`), and "레인별 순서" in its help. A card's move in an issue's history reads "Platform board에서 BACK-31 위로 옮겼습니다", and "보드에서" where the reader no longer sees the board (`boards.history.moved`, "on a board"). Is "어느 보드에서" better there?
- `page.admin.metadataInUse` says "번호 {no}" for FIDO's BLOB ("사용 중인 FIDO 메타데이터: 번호 87, 3시간 전 읽음."), since "87번" would read as a count of times. Clear?

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **커밋 상태** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): GitHub 한국어 UI도 "커밋 상태"라고 씁니다. "체크"와 구분되어 자연스러운가요?
- `page.group.requirePasskeys`는 "이 그룹의 사람들에게 패스키 요구"입니다. 다른 스위치 라벨처럼 명사로 끝나는데, "패스키 필수"처럼 더 짧게 할 수도 있습니다. 어느 쪽이 낫나요?
- `page.group.requirePasskeysHelp`는 "Single Sign-on과 디렉터리 계정은 계속 공급자 소관이며"라고 씁니다. "소관"은 문서체 느낌인데, "계속 공급자가 관리하며"가 나을까요? (카탈로그의 SSO 표기는 "SSO"입니다.)
- `builds.builds.reportCheck`는 "각 실행의 결과를 GitHub에 보고"입니다. "보고"가 자연스러운가요, "전송"이나 "알리기"는 어떨까요?
- `page.integrations.statusesLastProblem`은 "마지막 커밋 상태를 작성하지 못했습니다({when}). 오류: {problem}"로 check run 문장과 같은 꼴입니다. 괄호 안 시간 표기가 자연스러운지도 check run 질문과 함께 살펴주세요.


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn`은 “팔로우하는 검색에 포함되었습니다”입니다. 알림 제목에서 “포함”은 기계적으례 들리나요, “해당하게 되었습니다”가 나은가요?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle`는 기존 게스트 페이지의 표현을 따랐습니다. `issuesMatching`은 “{query}”에 해당하는 이슈” — “일치하는”이 더 자연스러운가요?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` 계열은 기존 도구 이름을 따랐습니다. `writing.draftedWithTheAssistant`는 “어시스턴트가 이 문장의 초안을 썼습니다.” — “작성했습니다”가 더 자연스러운가요?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “그리기”, `page.whiteboard.picture` = “그림”, `whiteboards.kind.ink` = “낙서”): 자연스러운가요?

Messages added in wave 13 (Matrix chat):

- Wave 13(Matrix): `page.chat.matrixHomeserver` = “홈서버” — 자연스럽나요?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14(시간 기록): `page.timesheet.submit` = “주 제출”, `page.timesheet.sendBack` = “반려” — 자연스럽나요?

Messages added in wave 16 (the script library's page):

- Wave 16(스크립트 라이브러리): `page.rules.library` = “스크립트 라이브러리”, `page.rules.libraryCode` = “공유 코드” — 자연스럽나요?

Messages added with the configurable approval rule:

- 설정 가능한 승인: `projects.workTypes.approvalEvery` = “그 주의 작업이 있는 모든 프로젝트의 관리자 중 이 프로젝트의 관리자” — 길지만 자연스럽나요?

Messages added in wave 18 (the HR calendar):

- Wave 18(HR 달력): `page.admin.hrCalendar` = “HR 달력”, 거부 문구 = “이 날짜들은 HR 달력에서...” — 자연스럽나요?

Messages added with the timesheet's personal view:

- 개인 보기: `page.timesheet.bauOrAnythingYouKeep` = “BAU, 또는 당신이 기록하는 것”, 거부문 = “...하나씩 바꾸세요.” — 자연스럽나요?

Messages added with the queued scripts:

- 대기열: `rules.ruleForm.runFromTheQueue` = “대기열에서 실행: 시간이 걸려도 되며, 규칙이 발동했을 때 본 내용에 작용합니다” — 길지만 자연스럽나요?

With the posts that change in place:

- 게시물은 제자리에서 바뀝니다 – 새 문구는 없습니다. 질문: 채널에서 편집했음을 보여주어야 할까요, 아니면 조용히 바뀌는 것으로 충분할까요?

Messages added with the load grid's team:

- 부하: 계획된 업무가 없는 사람 옆의 `plan.resources.nothingYet` = “아직 없음” — 짧은 말로 자연스럽나요?

Messages added with Teams' link unfurling:

- 펼침: `server.chat.issue.isShared` = “님이 이슈를 공유했습니다” — 카드의 동사로 자연스럽나요?

With the requester's own language:

- 요청자의 언어: 이메일이 이제 브라우저의 언어를 따릅니다(요청자에 저장). 새 문구는 없습니다. 질문: 포털 페이지에 언어 선택기를 보여줘야 할까요, 브라우저로 충분할까요?

Messages added with SAML for requesters:

- 요청자용 SAML: `problem.portal.providers.samlNeedsBoth` = “SAML 제공자에는 SSO URL과 서명 인증서가 필요합니다.” — 자연스럽나요?
## Simplified Chinese

The whole catalog was translated in one pass by a model, working from English, the code, [translating.md](translating.md) and the other catalogs, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Everything below is open.

Terms:

- **你 and 您**: 你 everywhere, and 您 on the help desk's pages for requesters (the form, the portal, a request's page), in their emails, and on the unsubscribe page, which team members reach from their emails too. Is 您 right there?
- **问题 for issue** is Jira's. 事项 and 工作项 (Feishu's, PingCode's) or GitHub's 议题 are the alternatives; 问题 also means "problem", so no problem says it.
- **经办人 for assignee** is Jira's, and keeps 负责人 for a project's lead. Many Chinese tools say 负责人 or 处理人 for the assignee.
- **冲刺 for sprint** is Jira's. Chinese agile teams often say 迭代.
- **智能体 for agent**, as Chinese AI products say it now; 代理 reads as a proxy.
- **分诊 for triage**, borrowed from medicine as English borrowed it. 预审 or 分类 are the alternatives.
- **经理 for the manager role** reads as a job title. 管理者 sits too close to 管理员 (administrator); 项目经理 is longer.
- **休假 for days away**, sick days included. 请假 or 不在岗 are the alternatives.
- **The plan's words** are the project management ones Chinese PMP courses teach: 挣值, 成本绩效指数, 资源平衡, 浮动时间, 基线, 关键路径. What-if is 模拟, and its button 「假如……」.
- **令牌 for token**, 密钥 for a webhook's or an app's secret, 投递 for a delivery, 两步验证 for two-factor sign-in (双重身份验证 and 双因素认证 are the alternatives).
- **The navigation's groups**: 工作, 决策, 配置, 系统 (`app.shell.work`, `decide`, `build`, `oversee`). Build was 构建, which is CI's build, and Oversee 总览, which reads as an overview page; 配置 and 系统 are what a Chinese admin console groups such pages under. Natural?
- **Age** in the reports (`reports.moreReports.*`) is 时长; **velocity** is 速度.

Phrasing:

- **Spaces around values**: the catalog spaces a placeholder as the Latin name, id or number it usually holds (「由 {name} 添加」), so a person named in Chinese reads 「以 王芳 身份」. See below.
- **Intl's own spacing**: dates, durations and lists come from Intl unspaced (「2.5小时」, 「Anna Schmidt和Vera Viewer」) beside the catalog's 「3 个问题」. Acceptable side by side?
- **Free text moved to the end**, after 错误：, 原因： or 回复： (`problem.apps.catalogUnreadable`, `problem.workflow.ruleRefusesInItsWords`, `problem.imports.source.answeredSaying`). Does it read naturally?
- **The desk's name in quotes**: `server.helpdesk.whyAnswer`, `whyLink` and `server.portal.lead` quote it, 「您向“BACK 的服务台”提交了请求」, so the plain 「服务台」 reads too.
- **A rule's sentence**: 「当创建问题时，如果问题匹配 Type: Bug，则应用 Assignee anna。」 Conditions on linked issues say 「通过“{v}”链接的问题」 (`rules.words.*Linked*`, `rules.preview.actsOn`), where they said the heavier 「与它存在“{v}”关系的问题」. With an English phrase in the quotes (「通过“depends on”链接的问题」), does it read?
- **The board's drop lines** (`board.board.dropItTo*`): 「放下即可将 BACK-1 移到 Done（设为 Fixed），并将它指派给 anna」, read by a screen reader as a card moves; it was 「放下以将…」.
- **Examples for the assistant** are Chinese (「把这些移到 Review，并指派给 anna」, 「本周无人处理的严重 Bug」); examples of the query and command languages stay as written.
- **The issue list's count line** says 「4 个问题：项目 SPR、未解决」, joining the query's parts with 、.
- **Traditional Chinese readers**: a browser asking for zh-TW or zh-HK gets this catalog, since a4a matches a language by its first part, and most such browsers list zh as well. Is Simplified better than English for them, or should a4a match only zh, zh-CN and zh-Hans until it has a Traditional catalog?

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard's note is 便签** (`whiteboards.kind.note`, `page.whiteboard.addNote`), as Feishu's and Tencent Docs' whiteboards say it, kept apart from 备注, a dashboard's or an internal note. 便利贴 and Microsoft's 便笺 are the alternatives.
- **A section is 分区** (`whiteboards.kind.section`, `page.whiteboard.group` 「放入分区」), and **an arrow's label 标注** (`whiteboards.connectDialog.label`, `whiteboards.textDialog.labelArrow`), since 标签 is a tag. 框架 (Miro's frame) and 文字 are the alternatives.
- **"Make issues" is 转为问题** (`page.whiteboard.convert`, `whiteboards.convertDialog.title`), and its button counts with 创建 (「创建 3 个问题」, `whiteboards.convertDialog.go`); an issue from a chat message is 从消息创建问题 (`server.chat.issue.*`). Should one verb serve both?
- **The tones** (`whiteboards.tone.*`, drawn as badges on notes): 普通, 想法, 已商定, 疑问, 痛点, 暂缓. Question and problem can't be 问题, which is an issue: is 痛点 right for a problem, or 难点 or 障碍? And 暂缓 for parked, or 搁置?
- **A thread is 话题** (`server.chat.issue.thread`, the label in Slack's modal, and `page.issue.source.replies`), as Feishu says it. Slack's own Chinese says 消息列.
- **Whiteboard names are quoted** in sentences, as rules' and baselines' names are: 「创建了白板“Q3 规划”」 (`activity.ledgerEntry.whiteboard*`, `issues.issueHistory.madeFromWhiteboard`, `page.whiteboard.deleteTitle`). A dashboard's delete title doesn't quote its name (「删除仪表板 {name}？」): should one way win?
- **Zero is a count**: `activity.ledgerEntry.whiteboardConverted` and `page.whiteboard.said.converted` read 「创建了 0 个问题和 2 个链接」, where English says "no issues".
- `page.issue.source.from` now reads 「来自 Slack 消息（Acme · #eng）」, and a watcher's reason `issues.watching.wroteTheMessage` 「发送了来源消息」. Clear enough?

Edited for natural phrasing:

- **请 in a fix**: problems and notices that ask the reader to act now say 请 (「请稍后重试。」, 「请联系管理员。」, 「请先保存，之后才能插入图片和文件。」), across `problem.*`, `app.auth.ask*`, `attachments.api.*`, `editor.*`, `notifications.push.*`. The catalog had none where English has no "please", which read as orders. Is it now too polite anywhere, such as a form's own hint (`page.oAuthConsent.chooseAtLeastOneProject`, 「请至少选择一个项目。」)?
- **A time before its verb**: 「3分钟前更新」, 「11月16日报告」 (`page.guestPages.updated`, `page.guestPages.reported`, `page.whiteboards.row`, `notifications.pushSettings.added`, `page.webhooks.added`, `agents.agentAccounts.roleAdded`). With a date from another year it reads 「2025年11月16日更新」: fine?
- **Who reported a guest page's issue**: `page.guestPages.by` is 「{name} 」 before the time (「BACK-1 · 语言 · 王芳 3分钟前报告」). The space after a Chinese name is the catalog's rule for names; does it read?
- **项目键 for a project's key** (`page.project.key`, `page.projects.key`, `page.project.keyRename`, `problem.projectKeys.*`): 键 alone read as a key-value's or a keyboard's. Jira's Chinese says 关键字 in places; is 项目键 what teams say? An imported issue's key in another tracker is 编号 (`problem.imports.noKeyColumn`, 「编号列」).
- **Someone, as a name**: an author or actor whose name is gone is 未知用户 (`page.guestPages.someone`, `issues.issueHistory.someone`, `page.issue.someone`, `activity.ledgerEntry.someone`, `page.dashboard.someone`); in a notification's title it is 有人 (`server.notify.someone`, 「有人 发表了评论」). Right?
- **The language picker's first option**, 「跟随浏览器（简体中文）」 (`page.profile.yourBrowsersLanguage`), as Chinese apps say 跟随系统. The time zone's stays 「服务器时区（…）」.
- **Newer and older** on the guest pages are 上一页 and 下一页 (`page.guestPages.newer`, `older`): they page through issues newest first. Is losing "newer/older" acceptable?
- **The unsubscribe page says 退订** (`page.unsubscribe.stopThem`, `stopped`, `stopTheseEmails`), as Chinese mail does; a request's requester 「已退订此请求的邮件」 (`helpdesk.requestCard.theyStoppedEmailsAboutIt`).
- **The editor's Visual mode is 富文本** (`editor.richField.visual`), beside Markdown. 可视化 was literal; 所见即所得 is the alternative.
- **The consent button says 授权** (`page.oAuthConsent.allow`), as the terms table's "allow (an app)" does, and 「请求以你的身份访问 a4a」 (`page.oAuthConsent.asksToWorkInA4a`) for "asks to work in a4a as you".
- **A workflow's action is still 动作** (`workflow.actions.*`, `problem.workflow.action*`, `problem.command.action*`). Chinese tools often say 操作 for a button that runs a command; it is left as it was. Should it change everywhere?
- **The profile's sections**: 「基本信息」 for "You" (`page.profile.you`), 「登录方式」 for "Signing in" (`page.profile.signingIn`), and the role line 「你是管理员，可以更改所有内容。」 (`page.profile.youRe` with `roleAdmin`, `roleMember`, `roleViewer`).
- **Webhook events as clauses**: 「服务台请求新增抄送」, 「从项目中移除成员」 (`page.webhooks.someoneIsCopiedOnARequest`, `someoneIsTakenOutOf`, `aGroupIsTakenOut`), for English's passives, read before 时 in a webhook's line (`page.webhooks.when2`). The form's checkboxes say the same, as labels of their own (`page.webhooks.label.*`).

Edited for natural phrasing, second round:

- **Something that runs shows 已启用**, beside 已暂停, and its button says 重新启用 (`page.webhooks.sends`, `page.integrations.takesDeliveries`, `builds.builds.takesBuilds`, `page.webhooks.turnItBackOn`, `page.integrations.turnItBackOn`, `builds.builds.takeBuildsAgain`). English says "sends", "takes deliveries", "takes builds": would 发送中 or 接收中 read better on the badge?
- **A time first in a card's line**: 「3分钟前收到最新投递」, 「3分钟前收到最新构建」, 「3分钟前登录过」, 「3分钟前使用过」, 「3分钟前由 Ada 连接」 (`page.integrations.lastDelivery`, `builds.builds.lastBuild`, `page.admin.last`, `identity.provisioning.used`, `page.chat.connectedBy`). Would a label read better here, 「最近投递：3分钟前」, 「上次登录：3分钟前」?
- **A pull request that is open is 开放中** (`vcs.issueCode.open`), beside 已合并 and 已关闭, as GitLab's Chinese says it; it was 已打开. 打开 or 待合并?
- **Another tracker is 其他工具** (`page.import.anotherTracker`, `imports.fromApi.readFromAnotherTracker`, `page.import.fromTheOtherTrackerS`), where it was the literal 其他跟踪器. 其他问题跟踪工具 is longer.
- **Who vouches for a chat subscription is 订阅人** (`chat.chat.whoVouchesForIt`): the column shows who subscribed the channel, whose access the subscription reads with, and "vouches" is lost. 担保人 is literal.
- **A channel in the picker** reads 「Acme 的 #eng（Slack）」 (`chat.chat.on2`), for "#eng, Acme on Slack".
- **The administration page's roles** read 「管理员（可更改所有内容）、成员（可查看并更改问题）和查看者（仅可查看）」 (`page.admin.anAdministratorChangesEverything`, `aMemberReadsAndChanges`, `aViewerReads`, joined in `page.admin.rolesATokenNeverDoes`), since Intl joins three clauses with 、 and 和. Natural?
- **A role's permissions** say 「发表评论」 for "comment on them" and 「管理项目的设置与人员并查看其中所有问题」 for managing (`roles.words.commentOnThem`, `changeItsSettingsAndPeople`), so a list reads 「查看项目的问题、发表评论、报告问题、更改问题和记录工时」 without 问题 at every step.
- **An account's state** under 账号状态 is 正常 or 已封禁 (`page.admin.access`, `page.admin.allowed`), for English's Access: Allowed or Banned.
- **Triage's rungs** are 关闭, 仅建议 and 自动执行 (`projects.triage.off`, `suggests`, `acts`), which read in 「分诊：仅建议」 (`page.project.triage`).
- **How webhook deliveries work** is 投递说明, with 签名, 至少送达一次, 重试 and 其他请求头 as its terms (`page.webhooks.howDeliveriesWork`, `signed`, `atLeastOnce`, `retried`, `alsoSent`).
- **A field's type** says 单行文本 and 多行文本 for "a line of text" and "text", as Chinese forms do (`projects.projectFields.aLineOfText`, `text`).
- **Provisioning is 预配**, Microsoft's word, under the heading 用户预配 (`identity.provisioning.provisioning`). 同步 or 自动配置 are the alternatives.
- **An import's mapping table** heads its columns 「来源：YouTrack」, 「BACK 中的对应项」 and 「匹配方式」, with chips 「按表头匹配」, 「手动选择」 and 「未匹配」 (`imports.mappingTable.in`, `becomesIn`, `how`, `foundFromItsHeader`, `chosen`, `nothingHereYet`).

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey is 通行密钥** (`identity.passkeys.*`, `page.profile.passkeys`, `app.auth.signInWithAPasskey` 「使用通行密钥登录」), as Apple's, Google's and Microsoft's Chinese say it, counted with 个. 密钥 is also a webhook's secret and a provider's client secret (`helpdesk.portalSignIn.clientSecret` 「客户端密钥」): does 通行密钥 read apart? Some Chinese sites keep "Passkey".
- **Ways to sign in are named 「…登录」**, as Chinese sign-in options are: the desk's choices 邮件链接登录, 密码登录 and 通过 {name} 登录 (`helpdesk.portalSignIn.link`, `password`, `through`), and the ledger's 「将 BACK 请求人的门户登录方式改为：邮件链接登录、密码登录和Okta 登录」 (`activity.ledgerEntry.signInByLink`, `signInByPassword`, `signInThrough`, `portalSignInChanged`). The portal's list ends in a provider's bare name, so it names things: 「密码、邮件中的登录链接或 Okta」 (`page.portal.wayPassword`, `wayLink`, `elsewhere`).
- **Identity providers for requesters are 供请求人使用的身份提供商** (`helpdesk.portalSignIn.providers`, `noProviders`, `problem.portalSignIn.providersForManagers`, `tooManyProviders`): plain, but long in a sentence. 请求人身份提供商 is shorter.
- **A provider vouches by 确认** (`helpdesk.portalSignIn.throughAny`, `throughSome`, `domainsHelp`, `page.portal.ssoDomain`): 「由提供商确认邮箱」. 担保 is literal; 验证 is the alternative.
- **The OpenID Connect fields** are 颁发者（Issuer）, 客户端 ID, 客户端密钥, 重定向 URI and 发现文档 (`helpdesk.portalSignIn.issuer`, `clientId`, `clientSecret`, `redirectUri`, `problem.portalSignIn.issuerNotUrl`, `providerUnreachable`). Microsoft's Chinese says 客户端密码 for the secret, and many providers' Chinese consoles keep Issuer in English.
- **Signing out everywhere is 在所有设备上退出登录** (`page.notMe.signMeOut`, `doneAbout`, `ifNotYou`, `server.passkeys.signOutEverywhere`, `notYou`), though it ends every session, a second browser's on one device too. 退出所有会话 is exact, but technical.
- **A copied passkey is 已停用** (`identity.passkeys.stopped`, `server.passkeys.copiedSubject`, `problem.passkeys.copied`), since a4a stops it; 已失效 is the alternative. 可能已被复制 keeps a passive, as Chinese security notices say it (`identity.passkeys.mayBeCopied`, `page.notMe.copied`).
- **The sign count** (`server.passkeys.copied`): 「a4a 发现此通行密钥使用时出现了一个此前已经用过的计数」 for "a count it had already passed". Clear to someone who doesn't know a passkey counts?
- **The passkey mails** say what changed without a subject, 「已为你的 a4a 账号添加一个通行密钥」 and 「已从你的 a4a 账号移除一个通行密钥」 (`server.passkeys.addedSubject`, `removedSubject`, `page.notMe.added`, `removed`), and their leads begin with the time as Intl writes it: 「11月16日周一 GMT+8 22:05，通行密钥“…”已添加到你的 a4a 账号 ada。」 (`server.passkeys.added`, `removed`, `removedByAdmin`). The added and removed mails' button is 不是我本人操作 (`server.passkeys.thisWasntMe`). Natural?
- **Face** is 人脸 (`identity.passkeys.none`, `problem.passkeys.notVerified`), as Android and Windows say it; Apple's is 面容.
- **The portal** is 门户 on the team's pages and 服务台门户 where requesters read it (`page.portal.passwordHelp`, `server.portalAccount.lead`).
- **A guest's project page** heads its plan, reports, boards and whiteboards 「{name} 的其他公开内容」 (`page.guestPages.alsoOpenIn`), for "Also open in {name}", and a missing board reads 「找不到这个看板，或该看板未对访客开放。」 (`page.guestPages.noSuchBoard`, `noSuchProject`, `noSuchWhiteboard`), naming it again where the issue's older message says 它.

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `notifications.pushSettings.stopPushNotificationsTo` “从推送通知中移除 {label}{v}”; `page.admin.askForAPasskeyOf` “为 {name} 取消豁免”; `page.admin.removePasskeysOf` “为 {name} 移除通行密钥”; `page.admin.sendALinkTo` “发送链接，让 {name} 添加通行密钥”. Do they read naturally?
- **A lane's own order is 每个泳道单独排序** (`page.board.laneOrder`, `laneOrderOn`, `laneOrderTurnedOn`), beside 按看板排序 for the board's (`page.board.laneOrderTurnedOff`, `laneOrderHelp`). 泳道独立排序 is the alternative.
- **A card's moves in its issue's history** name the issue, 「在 Platform board 上将此问题移到了 BACK-31 上方」 (`boards.history.moved`), as [translating.md](translating.md) asks, where the history's older lines say 将它 (`issues.issueHistory.movedItFromTo`, `putItInSprint`, `tookItOutOfSprint`). Should one way win?
- **A check run is 检查运行**, and a check 检查, as GitHub's Chinese docs say them (`page.integrations.checks*`, `problem.vcs.checks.needsApp`, `problem.vcs.githubApp.cantWriteChecks`). On GitHub a check reads 「提到 2 个问题」 or 「提到的问题中有 1 个未解决」, and an id with no issue a4a may show 「没有对应可在此显示的 a4a 问题」 (`server.checks.*`). Clear to a developer? A suspended installation's badge is 已暂停 (`page.integrations.installationSuspended`), the word a paused integration shows on the same page.
- **A held CC waits for its requester's 确认**: the desk's switch reads 「新请求邮件中的抄送人须经请求人确认后才抄送」 (`helpdesk.ccSettings.confirm`), the headings 「等待您确认」 and 「等待 {requester} 确认」 (`page.portal.heldTitle`, `helpdesk.requestCcs.held`), and dropping one is 不抄送 (`page.portal.dropHeld`, `heldDropped`, `page.portal.confirm.dropped`). The email's Cc line is 新请求邮件中的抄送人 throughout, and the acknowledgement 回执邮件: is 回执 understood, or would 确认收到的邮件 be clearer?
- **Relaying is 转发, and what anyone writes on a request is 回复** (`helpdesk.ccSettings.relay` 「让请求的所有参与者都能收到彼此的回复」, `server.helpdesk.relay.*`, `page.unsubscribe.what`'s `relay`, `activity.ledgerEntry.requestCcsChanged`), the requester's own words too: 「Ana Kim 在 Bo Li 的请求中发表了回复。」 留言 is the alternative.
- **An authenticator is 认证器**, as FIDO's and W3C's Chinese say it, kept apart from 身份验证器应用, the app that shows codes (`page.admin.onlySomeAuthenticators` 「仅限部分认证器」, `takeOnlySome`, `identity.passkeys.onlyThese`, `problem.passkeys.notListed`). Attestation is a maker's 证明 and a maker 厂商 (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`, `unknownMaker`, `untrustedMaker`); FIDO's "revoked" is 已撤销 (`page.admin.revoked`), the catalog's word for a token. Do they read apart?
- **Letting someone off passkeys is 豁免**, and taking it back 取消豁免 (`page.admin.letOff`, `letOffFor`, `letOffPasskeys` 「已豁免通行密钥要求」, `askForAPasskey`, `requireNote`, `problem.passkeys.lastAdmin`, `wouldLockOut`). 免除 is the alternative.
- **"Sign in with a code instead"** (`app.auth.noDeviceCanMakeOne`) says 「改用密码和验证码登录」, since 验证码登录 alone reads as signing in by a texted code.
- **An account with passkeys alone** is 仅限通行密钥 in the people table (`page.admin.passkeysAlone`, beside 仅限令牌), 仅用通行密钥登录 on the profile (`identity.passkeys.passkeysAlone`) and 不设密码 on the form that adds someone (`page.admin.passkeysAloneChoice`). The passkey provider that syncs a spare is 通行密钥管理器, as a password manager is 密码管理器 (`identity.passkeys.keepASpare`, `problem.passkeys.spareFirst`, `server.passkeySetup.leadFirst`).
- **The setup link is 添加通行密钥的链接** (`page.admin.sendALinkTo`, `addedLinkMailed`, `server.passkeySetup.subjectAgain`), and its page's title 添加通行密钥 (`page.passkeySetup.title`). Its time left comes from Intl as 「3天后」, so the people table's line takes a space before it, 「添加通行密钥的链接 3天后过期」 (`page.admin.linkRunsOut`), and the link's page puts it after a comma, 「此链接仅可使用一次，3天后过期。」 (`page.passkeySetup.until`). Fine?
- **The portal signs a requester out with 退出门户登录** (`helpdesk.portalPasskeys.notMeDoneAbout`, `server.portalPasskeys.notYou`), where the team's pages say 在所有设备上退出登录.
- **The page behind the acknowledgement's link** reads 「您就“{summary}”发给 {desk} 的邮件抄送了以下人员。」 (`page.portal.confirm.lead`), with the desk's name unquoted, as the portal's pages say it; the desk's emails quote theirs, 「“BACK 的服务台”」 (`server.helpdesk.relay.whyAnswer`, `whyLink`).

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **提交状态** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): Gitea 和 GitLab 的中文界面都写“提交状态”。与“检查运行”并列时清楚吗？
- `page.group.requirePasskeys` 是“要求此组成员使用通行密钥”，`page.project.requirePasskeys` 是“要求所有能看到此项目的人使用通行密钥”。“要求……使用通行密钥”的动词结构自然吗？
- `page.group.requirePasskeysHelp` 以“凡使用 a4a 自身密码登录的成员”开头。“凡……的”这种书面结构在帮助文字里合适吗？
- `builds.builds.reportCheck` 是“将每次运行的结果报告给 GitHub”。“报告给”用于自动上报自然吗？
- `page.integrations.statusesNeedToken` 里“Gitea 和 Forgejo 还需要其 /api/v1 地址”中“其”字用法是否清楚（指 Gitea 和 Forgejo 各自的地址）？


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` 是“它进入了你关注的一个搜索”。“进入”在通知标题里自然吗，还是“开始符合你关注的搜索条件”更清楚？

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` 沿用了其他访客页的措辞。`issuesMatching` 是“与…匹配的问题”——用“符合”“符合条件”会不会更自然？

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` 系列沿用了现有工具名。`writing.draftedWithTheAssistant` 是“这些文字由助手起草。”——用“撰写”会不会更自然？

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “画”、`page.whiteboard.picture` = “图片”、`whiteboards.kind.ink` = “随手画的线”): 工具栏上读起来自然吗？

Messages added in wave 13 (Matrix chat):

- Wave 13（Matrix）: `page.chat.matrixHomeserver` = “Homeserver”——保留原文，还是译为“主服务器”更自然？

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14（工时表）: `page.timesheet.submit` = “提交这一周”、`page.timesheet.sendBack` = “退回” ——自然吗？

Messages added in wave 16 (the script library's page):

- Wave 16（脚本库）: `page.rules.library` = “脚本库”、`page.rules.libraryCode` = “共享代码” ——自然吗？

Messages added with the configurable approval rule:

- 可配置的审批: `projects.workTypes.approvalEvery` = “它的管理者，且是该周有工作的每个项目的管理者”——虽然长，读起来自然吗？

Messages added in wave 18 (the HR calendar):

- Wave 18（人事日历）: `page.admin.hrCalendar` = “人事日历”，拒绝说明 = “这些日子来自人事日历...” ——自然吗？

Messages added with the timesheet's personal view:

- 个人视图：`page.timesheet.bauOrAnythingYouKeep` = “BAU，或任何你记录的内容”，拒绝说明 = “请逐条修改...” ——自然吗？

Messages added with the queued scripts:

- 队列：`rules.ruleForm.runFromTheQueue` = “从队列运行：它可以慢慢来，并作用于规则触发时所见的内容” ——虽然长，自然吗？

With the posts that change in place:

- 帖子就地变化，没有新词。问题：应该在频道里标明“已编辑”，还是静静替换内容就好？

Messages added with the load grid's team:

- 负荷格：没有计划工作的人旁边的 `plan.resources.nothingYet` = “还没有” ——简短的词能传达吗？

Messages added with Teams' link unfurling:

- 展开：`server.chat.issue.isShared` = “分享了该问题” ——卡片上的动词自然吗？

With the requester's own language:

- 请求者的语言：邮件现在跟随浏览器的语言（保存在请求者上）。没有新词。问题：门户页面是否应显示语言选择器，还是浏览器就够了？

Messages added with SAML for requesters:

- 请求者的 SAML：`problem.portal.providers.samlNeedsBoth` = “SAML 提供者需要它的 SSO URL 和签名证书。”——自然吗？
## Vietnamese

Translated whole by one model, from English, the code and [translating.md](translating.md), then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"), with no native speaker yet.

Terms:

- **An issue is "vấn đề"**, Redmine's word. It is also everyday Vietnamese for "a problem", so what went wrong is always "lỗi". Would teams rather read "issue" as it is, or "công việc"?
- **There is no tracker's Vietnamese to lean on.** As far as the catalog's writer knows, neither Jira nor YouTrack has a Vietnamese interface; bảng, thẻ and nhãn are Trello's, and the plan's terms (đường găng, đường cơ sở, thời gian dự trữ, giá trị thu được) Vietnamese project management's. Check the whole table in translating.md against what your team says.
- **An assignee is "người được giao"** (16 characters, in a column and on badges). "Người phụ trách" and "người thực hiện" are the alternatives.
- **An agent is "tác nhân"**, as the Vietnamese press writes AI agents. Many developers say "agent"; "tác tử" is the academic word.
- **The help desk is "bộ phận hỗ trợ"**, and its portal "cổng hỗ trợ". IT teams often say "helpdesk".
- **Kept in English**: sprint, backlog, story point, workflow, script, commit, pull request, webhook, token, build ("bản build"), CI, instance and worker (`rules.run.scheduled`), and the code hosts' and chat platforms' own setting names (Signing secret, Messaging endpoint, Personal Access Tokens). Too many?
- **Merge** is "hợp nhất" ("pull request đã hợp nhất"), where developers often say "merge".
- **Subscribe** is "đăng ký" or "đăng ký nhận tin", and "đăng ký" also means signing up.
- **Two-factor sign-in** is "xác thực hai yếu tố"; Google's Vietnamese says "xác minh 2 bước".
- **The navigation's groups** (`app.shell.work`, `build`, `oversee`) are "Làm việc", "Thiết lập" and "Giám sát". "Giám sát" holds Administration too.
- **Smaller terms**: a token's fingerprint is "dấu vân tay", its scope "phạm vi", a secret "khóa bí mật", levelling "cân bằng nguồn lực", a digest "bản tổng hợp", a reaction "biểu cảm" and reacting "bày tỏ cảm xúc", a knowledge base "cơ sở kiến thức" (or "cơ sở tri thức"?), People and access "Người dùng và quyền truy cập", a guard rule "quy tắc chặn".

Phrasing:

- **Tone marks** sit the traditional way (xóa, hủy, hòa, thủy), as Microsoft's and Google's Vietnamese write them. The newer placement (xoá, huỷ) is just as common: one throughout either way.
- **Dates** come from Intl's CLDR: "16 thg 11, 2026" for a short date. Some readers prefer "16/11/2026".
- `problem.ai.error` adds a lead-in English doesn't have, "Dịch vụ AI báo lỗi: {error}", since what follows is another service's English.
- `server.helpdesk.received` greets first ("Chào {name}, chúng tôi đã nhận được yêu cầu của bạn."), where English ends the sentence with the name.
- **The ledger's bylines** say "với tư cách {name}" for "as {name}", "thay mặt {name}" for "for {name}", and "với danh nghĩa riêng" for "as itself". `activity.ledgerEntry.made` is "đã đặt {v} ở chế độ {v2}" ("đã đặt BACK ở chế độ chỉ thành viên xem được").
- **Badges kept short for a phone**: `activity.ledgerEntry.changesWhoIsCopied` "đổi người được CC", `helpdesk.groups.cantBeGiven` "{name}: tạm không nhận yêu cầu", `helpdesk.requestCard.firstResponseDueIn` "phản hồi đầu tiên: còn {span}". Clear enough?
- **The issue list's count line** puts the count first, as English does ("4 vấn đề trong dự án SPR, chưa giải quyết"), and its sort follows a comma (`server.query.sortedBy`, ", sắp xếp theo {sorts}").
- `rules.preview.actsScheduled`: does "chạy cho từng vấn đề" against "tác động lên từng vấn đề" carry English's "for each of them" against "on each of them"?
- **"Your address"** in the help desk's limits is "địa chỉ IP của bạn", since an email address sits beside it.
- **Examples**: plain words for the assistant and the chat bot are Vietnamese ("comment BACK-12 Ổn rồi", "chuyển các vấn đề này sang review và giao cho anna"), and so are example rule names ("Báo tin lỗi nghiêm trọng"); states, fields and the query and command languages stay as typed ("Won't fix", "State Fixed").
- `rules.ruleForm.everyWeekday`, "mỗi ngày làm việc", may read as the plan's working days rather than Monday to Friday.
- **"This instance"** is "Máy chủ này" as a heading (`page.admin.thisInstance`) and "a4a này" in a sentence.
- **Pronouns**: a person is "người đó" or "họ", and a thing is named again rather than "nó". Some sentences read heavy for it ("lịch sử ghi rằng cân bằng nguồn lực đã dời công việc đó").

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard is "bảng trắng"** (`app.shell.whiteboards`, `page.whiteboards.title`), as Zoom's and Teams' Vietnamese say it; teams may just say "whiteboard". "Xóa bảng trắng {name}?" (`page.whiteboard.deleteTitle`) can also read as wiping it clean; the dialog's text then says what goes.
- **Its pieces** (`whiteboards.kind.*`): a note is "ghi chú", as the dashboard's is, a card "thẻ", a text "văn bản", a section "khu vực", an arrow "mũi tên", an element "phần tử", the outline "dàn ý" (`page.whiteboard.outline`, as Google Docs says it) and connecting "nối" (`page.whiteboard.connect`). "Phần" for a section would meet "phần đã chọn", writing help's selection. Is "phần tử" too technical, against "đối tượng", Office's word for shapes?
- **An arrow's label is "chú thích"** (`whiteboards.connectDialog.label`, `whiteboards.textDialog.labelArrow`), since "nhãn" is a tag.
- **Removing an element is "gỡ bỏ"** (`page.whiteboard.remove`, `page.whiteboard.said.removed`), apart from deleting the whiteboard, "xóa": a card taken off leaves its issue as it was. Would a toolbar's "Xóa" read better?
- **A note's tones** (`whiteboards.tone.*`): "Thường", "Ý tưởng", "Đã thống nhất", "Câu hỏi", "Khó khăn" for a problem (an issue is "vấn đề") and "Tạm gác" for parked.
- **Make issues is "Tạo vấn đề"** (`page.whiteboard.convert`, `whiteboards.convertDialog.go`), and a note "trở thành" an issue (`whiteboards.convertDialog.about`).
- **Writing help is "Hỗ trợ viết"** (`writing.help`), drafting "soạn nháp" ("Soạn nháp bài viết từ nội dung này", `writing.draft`), and a suggestion's title names a version ("Bản ngắn gọn hơn", `writing.suggestion.title`). Discard is "Bỏ qua", as dismissing a triage suggestion is.
- **A suggested summary is a "tiêu đề"** (`page.issue.suggestASummary`, `page.issue.aClearerSummary`), since it's the issue's title; summarising a thread is "tóm tắt".
- **ClickUp's List stays "List"** (`imports.fromApi.whichTasksAList`, `problem.imports.source.notAClickupList`), as ClickUp names it, where "danh sách" is any list. A task is "công việc", as the plan's are, and "Personal token" stays English beside "Personal access token" (`imports.fromApi.personalToken`).
- **A Slack thread is "chuỗi tin nhắn"** (`server.chat.issue.thread`, `page.issue.source.replies`), as Gmail's "chuỗi thư"; "luồng" or "thread" are the alternatives.
- **Zero is "0 vấn đề"** in `page.whiteboard.said.converted` and `activity.ledgerEntry.whiteboardConverted` ("Đã tạo 0 vấn đề và 2 liên kết."), where English says "no issues".

Edited for natural phrasing:

A second read, again by a model, edited about 1,430 messages so they read as Vietnamese software rather than as English: the sign-in page, the frame and the profile, the issues, boards, the inbox and its emails, the help desk, the ledger, the query and command problems, projects, dashboards, articles, every other problem, and the plan, reports, rules, the assistant, chat and whiteboards read whole; the administration pages (agents, apps, builds, code hosts, groups, imports, integrations, webhooks) for their clearest tells only. What a native speaker should settle:

- **A fix is a bare imperative.** 418 problems and 102 other messages opened their instruction with "Hãy" ("Hãy thử lại sau một phút."); they now give it bare, as Microsoft's and Google's Vietnamese do ("Thử lại sau một phút."), and keep "hãy" after a leading clause ("Nếu vẫn lỗi, hãy …"). Many Vietnamese apps (banks, shops) write "Vui lòng thử lại." Does a bare instruction read curt? `problem.ai.busy`, `problem.access.signInOrToken`, `app.auth.tryAgainIfItKeeps`, and the rest of `problem.*`.
- **"Unknown X" is "Không tìm thấy X"** (`problem.query.unknownField`, `problem.query.unknownUser`, `problem.values.unknownValue`), and an unknown command "Không có lệnh “x”" (`problem.command.unknown`), where they read "X không tồn tại". "Expected …" is "Thiếu …" (`problem.query.valueAfterHash`), "Unexpected" is "“x” không hợp lệ ở đây" (`problem.query.unexpected`), and "Did you mean" is "Ý bạn là …?" (`issues.languageField.didYouMean`, `problem.query.unknownTag`).
- **"For {name}" is "thay mặt {name}"** in every byline (`ui.who.for`, `issues.issueHistory.for`, `activity.ledgerEntry.throughTheAssistantFor`, `server.notify.agentFor`, `page.agents.nameItAfterTheAgentFor`), since "thay cho" says instead of. Does "e2e thay mặt admin đã báo cáo vấn đề" read right for an agent working with someone's token?
- **A project's key is "mã dự án"** (`page.project.key`, `page.project.keyRename`, `problem.projectKeys.badKey`, `activity.ledgerEntry.renamesAKey`), where it was "khóa dự án", a calque of Jira's "project key". "Mã" now names both a project's key and an issue's id ("mã vấn đề"); "khóa" stays for cryptographic and stored keys.
- **The sign-in card** says "Dùng tài khoản a4a của bạn.", as Google's says "Sử dụng Tài khoản Google của bạn": the form's name ("a4a login") is "tài khoản a4a" now, where it was "tên đăng nhập a4a" (`app.auth.a4aLogin`, `app.auth.a4aOrLogin`, `app.auth.login2`, `app.auth.useYour`).
- **A person's name field is "Họ và tên"** (`app.auth.yourName`, `page.profile.name`, `page.portal.yourName`, `page.help.yourName`), as Vietnamese forms ask, and the profile's first section is "Thông tin cá nhân" (`page.profile.you`), where it was "Bạn". A display name may not be a full name.
- **"You're offline" is "Không có kết nối mạng"** (`app.auth.youReOffline`, `app.shell.youReOfflineWhatS`), as Chrome says it, where it was "Bạn đang ngoại tuyến".
- **Bylines put the person first**: "admin báo cáo ngày 17 thg 11, 2026" on the issue page (`page.issue.reportedBy`, `page.issue.askedByThroughTheHelp`), "vấn đề được Ada báo cáo" in the history (`issues.issueHistory.by`, `issues.issueHistory.whereItWasReported`), "Ada báo cáo 3 ngày trước" on the guest pages (`page.guestPages.by`, `page.guestPages.reported`), "Ada đã sửa …" on an article (`page.articles.by`), "do {name} thêm" for a login (`vcs.people.by`). "Bởi" is gone.
- **Notification kinds are verb phrases** ("Tạo mới", "Bình luận mới", "Đổi trạng thái", "Giao cho ai đó", "Thêm tệp", `notifications.kinds.*`), and the email levels say when they tell ("Khi bạn được nhắc đến, được giao việc, …", `notifications.emailSettings.mentionsAndAssignmentsAndChanges`), with the option itself "Nhắc đến và giao việc".
- **A saved search's issues "khớp" it** ("vấn đề mới khớp “{name}”", `server.mail.whySubscribed`, `page.inbox.becauseYouSubscribedTo`, `notifications.subscriptions.tellMeWhenAnIssue`), where they "mới vào" it.
- **An email's first line** puts the issue in brackets after the title, "{title} ({id}: {summary})" (`server.mail.lead`): "Ada đã bình luận (BACK-12: …)". Natural, or would "ở", "trên" or "tại" before the id read better?
- **The new issue's button is "Báo cáo vấn đề"** (`page.newIssue.reportIt`), since "Báo cáo" alone reads as Reports; its help says "Mô tả điều đã xảy ra …" where it said "Nói …" (`page.newIssue.sayWhatHappenedAndWhat`). Would "Tạo vấn đề" be better?
- **The command bar's words mode**: "Mô tả việc cần làm" for "Say what to do, in words" and "Chuyển thành lệnh" for "Read my words" (`issues.commandBar.sayWhatToDoIn`, `issues.commandBar.readMyWords`); the query field's toggle stays "Hỏi bằng lời".
- **Smaller choices**: a table's name for screen readers is "Danh sách …" (`page.admin.tableOfPeople` and the other `tableOf*`), since "bảng" is a board; "50%" for a report's "Half" (`reports.distribution.half`); "24/7" for "round the clock" (`helpdesk.sla.roundTheClock`); "Gom người yêu cầu" for grouping requesters (`helpdesk.groups.intro`); "Cần bạn xử lý" for "Waiting on you" (`page.suggestions.waitingOnYou`); "Tiêu đề" for the help desk form's "What it's about" (`page.help.whatItSAbout`); "Lưu ở dạng mã hóa" for "Kept sealed" (`page.chat.underBasicInformationA4aChecks`); and the time zone example "Asia/Ho_Chi_Minh" (`helpdesk.sla.anIanaNameSuchAs`).

Edited for natural phrasing, second round:

A third read, again by a model, read message by message, in their pages, the parts the second only checked for their clearest tells (`page.agents`, `agents`, `apps`, `builds`, `vcs`, `imports`, `page.import`, `page.integrations`, `page.webhooks`, `identity`, `roles`, `groups`, `page.group`, `page.admin`, `page.fields`, `projects`, `page.oAuthConsent`, `api`), and the labels it only skimmed in `page.newIssue`, `page.timesheet`, the help desk's form and tracking page, `editor`, `attachments`, `writing`, `decide`, `plan`, `page.sprintPlanning`, `away`, `reports`, `rules`, `workflow`, `assistant`, `chat` and `whiteboards`. It changed 642 messages: labels that named what a field holds rather than describing it, status lines that say what was done, and pieces that read wrong in the sentence a page joins them into. What a native speaker should settle:

- **A token's scopes are "Quyền" on its page** (`page.agents.whatItMayDo`, `page.agents.may`, `agents.agentAccounts.whatItMayDo`, `agents.agentAccounts.may`, `agents.oAuthApps.may`, `page.oAuthConsent.may`), and where it reaches "Áp dụng cho", its column "Dự án" (`page.agents.whereItMay`, `page.agents.where`, `agents.agentAccounts.whereItMay`, `agents.oAuthApps.where`, `page.oAuthConsent.where`), where "Phạm vi" named both. The problems still say "phạm vi" for a scope (`problem.access.tokenScope`, `problem.tokens.scopeNeeded`), as GitLab's Vietnamese does. Should the page say "Phạm vi" for the scopes too?
- **"As a GitHub App" is "với tư cách GitHub App"** (`page.integrations.readAsAGithubApp`, `page.integrations.asAGithubApp`, `page.integrations.readsAsTheGithubApp`, `page.integrations.savedA4aReadsAsThe`, `problem.vcs.githubApp.onlyGithub`), the table's word for "as", where "dưới dạng" said "in the form of". Developers may rather say "dùng GitHub App".
- **Taking someone out is "Gỡ … khỏi …"** (`projects.peopleAndAccess.takeOut`, `projects.peopleAndAccess.takeOutOf`, `groups.projectGroups.takeOut`, `groups.projectGroups.takeOutOf`, `page.group.takeOut`, `page.group.takeOutOf`, `page.webhooks.aGroupIsTakenOut`, `page.webhooks.someoneIsTakenOutOf`), where it was "Đưa … ra", and the ledger says "đã xóa {who} khỏi {project}" (`activity.ledgerEntry.tookOutOf2`, `activity.ledgerEntry.tookOutOf3`). One verb for both?
- **Who installed an app** comes first, as a byline puts the person: "Ada đã cài đặt 3 ngày trước, từ danh mục.", and without a name "Đã cài đặt 3 ngày trước." (`apps.appsSection.itsRulesActAsInstalled`, which words the line with the installer and without), where it said "Được Ada cài đặt …". Does it read right as a line on its own?
- **An import's targets and counts** are apart now: a column maps to "Ngày tạo", "Ngày cập nhật", "Ngày giải quyết" (`imports.mappingTable.whenCreated`, `whenUpdated`, `resolved`), and the tally counts "Đã tạo", "Đã cập nhật" (`imports.mappingTable.created`, `updated`). Right as the column's choices?
- **Another tracker's time** is "bản ghi thời gian" for a time entry (`count.timeEntries`, `imports.fromApi.itsTimeEntries`, `imports.mappingTable.workItems`), where it was "mục thời gian", beside "bản ghi công việc" for a worklog and "mục công việc" for a work item. Would "thời gian đã ghi" for all three read better?
- **An import's steps** are "Lấy vấn đề", "Ghép cột", "Kiểm tra", "Nhập" and "Xem kết quả" (`page.import.bringTheIssues`, `page.import.mapIt`, `page.import.checkIt`, `page.import.importIt`, `page.import.readWhatItDid`), and the page "Nhập dữ liệu" (`page.import.import2`). "Ghép cột" against "Ánh xạ", the technical word?
- **A paused build source** answers and ignores what it's sent: "bản build gửi đến vẫn được phản hồi nhưng bị bỏ qua, không ghi lại ở đâu" (`builds.builds.isPausedBuildsItS`), for English's "refused politely".
- **Badges**: a webhook that sends is "đang hoạt động" (`page.webhooks.sends`), beside an integration's "nhận lượt gửi" (`page.integrations.takesDeliveries`); a rule's are "gửi thông báo", "gọi webhook" and "script" (`rules.ruleCard.tellsPeople`, `rules.ruleCard.callsOut`, `rules.ruleCard.aScript`); an agent of its own "danh nghĩa riêng" (`agents.agentAccounts.actsAsItself`). Clear enough on their own?
- **A field's kinds** lose English's article ("lựa chọn từ danh sách", "số nguyên", "người dùng", `projects.projectFields.aChoiceFromAList2` and the other `projects.projectFields.a*`), as they stand alone in a select, a cell or after a name in brackets.
- **Your place in a project** reads "Bạn là thành viên trong dự án này, vì là thành viên của Backend: bạn được xem, bình luận và thay đổi vấn đề của dự án." (`projects.peopleAndAccess.youAreRoleHere`, `projects.peopleAndAccess.asOneOf`, `projects.peopleAndAccess.youReadCommentOnAnd`): "thành viên" twice when a group makes you a member.
- **A role's help** reads "Mọi người trong nhóm có vai trò tối thiểu là thành viên: được phép xem vấn đề của dự án, bình luận, …" (`roles.words.isAtLeastRoleWhoMay`, `roles.words.commentOnThem`).
- **A week with nothing logged** is a sentence of its own: "Tuần từ Thứ Hai đến Chủ Nhật: chưa ghi thời gian nào trên tổng số 40 giờ làm việc." (`page.timesheet.yourWeekFromToNothingLogged`), where "0 giờ" stood in for "nothing" in the logged week's sentence. Natural?
- **Hidden action columns are "Thao tác"** (`vcs.people.whatYouCanDo`, `projects.peopleAndAccess.change`, `projects.projectFields.change`, `groups.projectGroups.change`, `page.group.change`, `away.daysAway.whatYouCanDo`, `chat.chat.changeOrStop`), as Vietnamese admin tables name them.
- **"Never" in a token's table** is a message for each place now: "Không hết hạn" for the expiry choice and under "Hết hạn" (`page.agents.never`, `page.agents.neverExpires`, and `agents.agentAccounts`' two), and "Chưa dùng" under "Lần dùng cuối" (`page.agents.neverUsed`, `agents.agentAccounts.neverUsed`), as the apps' table says it (`agents.oAuthApps.never`), where "Không bao giờ" served all three.
- **Smaller choices**: an app's side panel is "khung bên" (`apps.appsSection.widgetAt`), since "bảng" is a board; a value's badge "huy hiệu" (`page.fields.inOrderTheFirstComes`), where "nhãn hiệu" is a brand; a rule's sample acting for another issue "vì BACK-12" (`rules.ruleCard.for`, `rules.ruleForm.for`); a sprint taken out "Bỏ khỏi sprint" (`reports.burndown.takenOut`); a failed request "Thao tác không thành công (500)" (`api.client.requestFailed`), since "yêu cầu" is a help desk's request; and a plan's window "Hoặc chọn khoảng giữa hai ngày" (`plan.loadWindow.orTheDaysBetweenTwo`), since "mốc" is a milestone.

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey is "khóa truy cập"**, as Google's and Microsoft's Vietnamese say it (`identity.passkeys.*`, `page.profile.passkeys`, `app.auth.signInWithAPasskey`); Apple's says "mã khóa", and developers and the tech press often say "passkey". "Khóa" is also a lock ("phương thức khóa màn hình" in `identity.passkeys.none`), so unlocking a passkey is said as verifying, "hãy xác minh bằng vân tay, …" (`problem.passkeys.notVerified`), not "mở khóa khóa truy cập".
- **The OpenID settings keep their English names**: "Issuer", "Client ID", "Client secret" and "public client" (`helpdesk.portalSignIn.issuer`, `clientId`, `clientSecret`, `clientSecretHelp`), and "tài liệu discovery" (`problem.portalSignIn.issuerNotUrl`, `providerUnreachable`), as providers' consoles show them, where vendors' Vietnamese differ. The redirect URI alone is Vietnamese, "URI chuyển hướng" (`helpdesk.portalSignIn.redirectUri`), as Google's and Microsoft's consoles say it. One way for all of them?
- **A provider vouches for an address: "xác nhận"** (`helpdesk.portalSignIn.domainsHelp`, `throughAny`, `throughSome`, `page.portal.ssoDomain`), beside "xác minh" for its verifying an email (`page.portal.ssoUnverified`). "Bảo đảm" is nearer to vouching, but rare in software.
- **A desk offers a provider: "dùng"** ("2 bộ phận hỗ trợ đang dùng", `helpdesk.portalSignIn.providerAbout`, `added`, `removeAbout`, `problem.portalSignIn.tooManyProviders`), or "cho người yêu cầu đăng nhập bằng …" in a sentence (`problem.portalSignIn.providerInUse`, `problem.customerGroups.providerNotOffered`, `page.portal.ssoRefused`), since "cung cấp" would echo "nhà cung cấp".
- **Through a provider** is "bằng {name}" in a sentence or a button ("Đăng nhập bằng {name}", `page.portal.signInThrough`), as the team's sign-in page says it, and "qua {name}" standing alone as a choice or in a list (`helpdesk.portalSignIn.through`, `helpdesk.groups.throughAlone` "Chỉ qua {name}", `activity.ledgerEntry.signInThrough`). The ledger's ways read "bằng liên kết gửi qua email, bằng mật khẩu và qua Okta" (`activity.ledgerEntry.portalSignInChanged`), and its badge "đổi cách đăng nhập" (`activity.ledgerEntry.changesHowRequestersSignIn`) leaves whose to the line.
- **Signed out everywhere is "đăng xuất mọi phiên"** (`page.notMe.signMeOut` "Đăng xuất mọi phiên của tôi", `page.notMe.doneAbout`, `server.passkeys.signOutEverywhere`), as a changed password's line says it; Google says "đăng xuất khỏi mọi thiết bị".
- **"Set or reset my password" is "Tạo hoặc đặt lại mật khẩu"** (`page.portal.setOrResetPassword`), where setting one is "đặt" elsewhere (`page.portal.setThePassword`): "Đặt hoặc đặt lại" repeats itself. Many sign-in forms say "Quên mật khẩu?".
- **A password for a desk** is "mật khẩu đăng nhập vào {where}" in its emails (`server.portalPassword.subject`, `lead`), since "mật khẩu cho bộ phận hỗ trợ của BACK" could read as the desk's own.
- **The form's proof of work** is named by its setting: "nếu biểu mẫu bật “Xác minh người gửi là người thật”, bước xác minh đó cũng áp dụng khi đăng nhập bằng mật khẩu" (`helpdesk.portalSignIn.passwordHelp`).
- **A copied passkey's count** is "số đếm" ("với số đếm mà khóa đã vượt qua từ trước", `server.passkeys.copied`). Clear to someone who doesn't know WebAuthn?
- **Badges**: a synced passkey is "Đồng bộ", its kind, rather than "Đã đồng bộ", which reads as something done once, and a stopped one "Đã dừng" (`identity.passkeys.synced`, `identity.passkeys.stopped`). "Use a passkey instead", at the code's step, is "Dùng khóa truy cập thay cho mã" (`app.auth.usePasskeyInstead`), naming what it replaces.
- **A guest's pages say "công khai"**, as the guest home does: "Không tìm thấy bảng này trong các dự án công khai" (`page.guestPages.noSuchBoard`, `noSuchProject`, `noSuchWhiteboard`), "Nội dung công khai khác của {name}" over a project's plan, reports, boards and whiteboards (`page.guestPages.alsoOpenIn`), and "với tư cách khách" for as a guest (`page.guestPages.whiteboardReadOnly`).

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `helpdesk.groups.removeMember` “Xóa khỏi nhóm: {email}”; `notifications.pushSettings.stopPushNotificationsTo` “Xóa {label}{v} khỏi thông báo đẩy”; `page.admin.askForAPasskeyOf` “Yêu cầu khóa truy cập lại cho {name}”; `page.admin.sendALinkTo` “Gửi liên kết cho {name} để thêm khóa truy cập”. Do they read naturally?
- **A lane's own order is "thứ tự riêng"**: "Mỗi làn có thứ tự riêng" (`page.board.laneOrder`, `page.board.laneOrderOn`). A card's moves read "đã đặt vấn đề phía trên BACK-31 ở bảng Platform" (`boards.history.moved`): "đặt", since "chuyển lên" would say which way it went, and "ở bảng", so "phía trên … trên bảng" doesn't repeat itself.
- **A check run stays "check run"** (`page.integrations.checksLegend`, `page.integrations.checksOn`, `problem.vcs.checks.needsApp`, `server.checks.summary.rule`), as GitHub names it and as pull request and commit stay; "lượt kiểm tra" is the Vietnamese alternative. An issue it names is "được nêu" (`server.checks.title.unresolved`), and an id that names none "không ứng với vấn đề nào" (`server.checks.title.unseen`).
- **An email's Cc is "dòng Cc"** (`helpdesk.ccSettings.confirm`, `activity.ledgerEntry.requestCcsChanged`), apart from a4a's "CC". A held Cc is "giữ lại", its people "chờ … xác nhận" (`helpdesk.requestCcs.held`, `page.portal.heldTitle`), dropping one "Bỏ qua" (`page.portal.dropHeld`, `page.portal.heldDropped`), and the history's confirmed copy "đã CC {email} qua email, sau khi xác nhận", the requester being who (`issues.issueHistory.ccAdded`).
- **A desk's rules for copies are "quy định CC"** (`activity.ledgerEntry.changesHowRequestsCopy`, `page.webhooks.label.projectRequestCcsChanged`, `page.webhooks.requestCcRulesChange`), since "quy tắc" is a4a's rule. Would "cài đặt CC" read better?
- **Hearing each other is "nhận được trao đổi của nhau"** (`helpdesk.ccSettings.relay`), and relaying "chuyển tiếp" (`page.unsubscribe.what`'s `relay`, `server.helpdesk.relay.stop`). The relay email's reason says "những gì mỗi người viết đều được chuyển tiếp cho những người còn lại" (`server.helpdesk.relay.whyAnswer`, `server.helpdesk.relay.whyLink`), in the passive, since `{desk}` before it already reads "bộ phận hỗ trợ của …".
- **An authenticator is "trình xác thực"** (`page.admin.onlySomeAuthenticators`, `page.admin.takeOnlySome`, `identity.passkeys.onlyThese`), beside "ứng dụng xác thực" for an authenticator app; "thiết bị xác thực" would leave out the password managers that are authenticators too. Its maker's attestation is "chứng thực" (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`), where a provider vouching for an address stays "xác nhận", and FIDO's metadata "siêu dữ liệu", its BLOB "BLOB" (`page.admin.metadataInUse`, `page.admin.metadataFailed`).
- **A passkey provider is "trình quản lý mật khẩu"** (`identity.passkeys.keepASpare`, `problem.passkeys.spareFirst`, `server.passkeySetup.leadFirst`), as Google's is named in Vietnamese, where English says passkey provider; "trình quản lý khóa truy cập" is the literal choice. A security key is "khóa bảo mật" (`app.auth.passkeysAreRequiredOfYou`).
- **An account with passkeys alone** is "Chỉ khóa truy cập" in the people table (`page.admin.passkeysAlone`), "Chỉ đăng nhập bằng khóa truy cập" on the profile (`identity.passkeys.passkeysAlone`) and "Không dùng mật khẩu: …" as it's made (`page.admin.passkeysAloneChoice`). Its setup link is "liên kết thêm khóa truy cập" (`page.admin.linkRunsOut`), handed over with "Chuyển liên kết này cho {name}" (`page.admin.giveThemThisLink`, `page.admin.addedLinkShown`).
- **Letting someone off is "miễn"** (`page.admin.letOff`, `page.admin.letOffPasskeys` "được miễn khóa truy cập", `page.admin.letOffSaid` "Đã miễn: …", `page.admin.askedAgainSaid` "Đã bỏ miễn: …"). "Miễn trừ" is the formal word.
- **A desk that takes passkeys "cho đăng nhập bằng khóa truy cập"** (`problem.portal.passkeysOff`, `helpdesk.portalPasskeys.offDesks`), as one that takes passwords does. A requester's help desk passkey is "khóa truy cập bạn dùng cho bộ phận hỗ trợ" (`helpdesk.portalPasskeys.notMeCopied`, `server.portalPasskeys.subject`, `problem.portalPasskeys.teamPasskey`), since "khóa truy cập của bộ phận hỗ trợ" would read as the desk's own.
- **Smaller choices**: GitHub's account kinds are "cá nhân" and "tổ chức" (`page.integrations.accountUser`, `page.integrations.accountOrganization`), where English says "user"; an installation GitHub says is gone "đã gỡ" (`page.integrations.installationGone`); "họ" stands for one person in "Đã CC 1 người: từ giờ, họ sẽ nhận …" (`page.portal.confirm.copied`), whose plural keeps `other` alone; and `server.portalPasskeys.removedByTeam` keeps `=1`, the one case that names the passkey.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Trạng thái commit** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): catalog giữ "commit" nguyên văn. GitLab tiếng Việt cũng nói "trạng thái commit". Được chứ?
- `page.group.requirePasskeys` là "Yêu cầu khóa truy cập đối với người trong nhóm", `page.project.requirePasskeys` là "…với mọi người xem được dự án này". "Yêu cầu … đối với/với" — giới từ nào đúng hơn?
- `page.project.requirePasskeysHelp` mở đầu "Từ lần đăng nhập tiếp theo, với ai đăng nhập bằng mật khẩu của a4a." Cụm "với ai đăng nhập" đọc có tự nhiên không?
- `builds.builds.reportCheck` là "Báo cáo kết quả của mỗi lần chạy lên GitHub". "lên GitHub" cho hướng truyền đi: tự nhiên không, hay "tới GitHub"?
- `page.integrations.statusesAudience` nói "trạng thái chỉ nêu vấn đề bằng mã" — check run thì "bằng mã và liên kết". Đối chiếu vậy rõ không?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` là “Vưa vào một tìm kiếm bạn theo dõi”. “Vưa vào” có nén rõ không?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` theo các trang khách. `issuesMatching` lá “Vấn đ khơp vôi”: tỳ nhiôn không?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` theo các công cụ sẵn có. `writing.draftedWithTheAssistant` là “Trợ lý đã soạn những lời này.” — hay “viết”?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “Vẽ”, `page.whiteboard.picture` = “Hình ảnh”, `whiteboards.kind.ink` = “một nét vẽ”): tự nhiên chứ?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = “Homeserver” — giữ nguyên từ này hay dịch là “máy chủ Matrix”?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (bảng chấm công): `page.timesheet.submit` = “Gửi tuần” và `page.timesheet.sendBack` = “Trả lại” — tự nhiên chứ?

Messages added in wave 16 (the script library's page):

- Wave 16 (thư viện script): `page.rules.library` = “Thư viện script” và `page.rules.libraryCode` = “Mã dùng chung” — tự nhiên chứ?

Messages added with the configurable approval rule:

- Duyệt có thể cấu hình: `projects.workTypes.approvalEvery` = “Người quản lý của nó, trong số người quản lý của mọi dự án mà tuần đó có việc” — dài nhưng tự nhiên chứ?

Messages added in wave 18 (the HR calendar):

- Wave 18 (lịch nhân sự): `page.admin.hrCalendar` = “Lịch nhân sự” và lời từ chối = “Những ngày này đến từ lịch nhân sự...” — tự nhiên chứ?

Messages added with the timesheet's personal view:

- Góc nhìn cá nhân: `page.timesheet.bauOrAnythingYouKeep` = “BAU, hoặc bất cứ gì bạn theo dõi” và lời từ chối = “...Hãy sửa từng mục một.” — tự nhiên chứ?

Messages added with the queued scripts:

- Hàng đợi: `rules.ruleForm.runFromTheQueue` = “Chạy từ hàng đợi: nó được phép tốn thời gian, và tác động lên những gì nó thấy khi quy tắc kích hoạt” — dài nhưng tự nhiên chứ?

With the posts that change in place:

- Bài đăng thay đổi ngay tại chỗ – không có từ mới. Câu hỏi: có nên cho kênh thấy là đã sửa, hay chỉ cần thay nội dung trong im lặng?

Messages added with the load grid's team:

- Tải: `plan.resources.nothingYet` = “Chưa có gì” cạnh người chưa có việc được lên kế hoạch — từ ngắn có ổn không?

Messages added with Teams' link unfurling:

- Mở rộng: `server.chat.issue.isShared` = “đã chia sẻ vấn đề” — động từ trên thẻ có ổn không?

With the requester's own language:

- Ngôn ngữ của người yêu cầu: email giờ theo ngôn ngữ trình duyệt (lưu trên người yêu cầu). Không có từ mới. Câu hỏi: trang cổng có nên hiện bộ chọn ngôn ngữ, hay trình duyệt là đủ?

Messages added with SAML for requesters:

- SAML cho người yêu cầu: `problem.portal.providers.samlNeedsBoth` = “Nhà cung cấp SAML cần URL SSO và chứng chỉ ký của nó.” — tự nhiên chứ?
## Indonesian

Indonesian was translated in one pass, by a model working from English, the code and [translating.md](translating.md). A second and a third read, by models again, edited it for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it yet.

Terms:

- **Issue** is *isu*. *Tiket* reads as a help desk's, *masalah* as a problem, which a feature request isn't; many teams simply say "issue". Is *isu* what an Indonesian team would write?
- **Help desk** is *layanan bantuan*, since its customers read it too (`app.shell`, `page.portal.*`, `server.helpdesk.*`). IT teams mostly say *helpdesk*: is the plain word right for a team's own pages?
- **Requester** is *pemohon*, which can read as a government form's applicant. *Peminta* and *pelanggan* (a customer, not always right) were the alternatives.
- **Assignee** is *penerima tugas*, as Google's and Microsoft's Indonesian say it. Offices say *PIC*; *penanggung jawab* was the other candidate.
- **Viewer** is *pelihat*, Google Drive's word; *pembaca* reads more naturally, but means a reader of text. **Manager** is *manajer*, **member** *anggota*, **guest** *tamu*.
- **Copied on a request (CC)** is *tembusan*, from Indonesian letters: "menerima tembusan", "tambahkan ke tembusan", "hapus dari tembusan". Email users mostly say "CC" (`helpdesk.requestCcs.*`, `page.portal.copy*`, `server.helpdesk.cc.*`).
- **Field** is *bidang*, Microsoft's word; *kolom* would clash with a board's columns, and many teams just say "field".
- **Login**, the handle a person signs in with, is *nama pengguna*, beside *nama* for their name. Does "Nama pengguna" beside "Nama" on the same form read clearly (`page.admin`, `app.auth`)?
- **Digest** is *ikhtisar*, since an issue's summary is already *ringkasan*.
- **Days away** is *ketidakhadiran*, and **away** *tidak hadir*. *Cuti* is leave, which a sick day or a training isn't; is *ketidakhadiran* too formal for a calendar?
- **Levelling** is *perataan beban*, **slack** *kelonggaran*, **earned value** *nilai hasil (EV)*, **booked** *dialokasikan*. Indonesian project managers often keep the English (float, earned value): which would they read faster?
- **Kept as Indonesian teams say them**: sprint, backlog, story point, velocity, burndown, baseline, milestone, commit, pull request, branch, build, webhook, token, widget, timer and secret. Should any be Indonesian?
- **The navigation's groups**: *Pekerjaan* (Work), *Keputusan* (Decide), *Penyiapan* (Build: projects, rules, fields, import) and *Pemantauan* (Oversee). *Pemantauan* sits beside *pantau*, which is "watch" for an issue's watchers.
- **A guard rule** is *aturan penjaga*, a state machine's **moves** are *langkah*, and **triage** is *triase*, the hospital's word.

Phrasing:

- **Undo** is *Batalkan*, and the history says *membatalkan perubahan* (`issues.issueHistory.undo*`, `activity.ledgerEntry.undidAnAgentSChange`), close to *Batal* for Cancel. Google's Indonesian says *Urungkan*.
- **The history and the ledger carry no tense word**: "Ada mengubah status", not "telah mengubah". Does that read as done?
- **A link's own words are data**: in a rule's sentence, "semua isu yang {v} cocok dengan {query}" takes a link type's English, "semua isu yang depends on cocok dengan …" (`rules.words.allLinkedMatchQuery` and its siblings).
- `server.chat.subscribed`: "{name} menambahkan langganan untuk saluran ini: …" for someone subscribing a channel (the second round's edit; it was "{name} membuat saluran ini berlangganan").
- **The help desk's emails** say *Anda*, with no *Yth.* or *Bapak/Ibu* (`server.helpdesk.*`, `server.portal.*`); the first one greets, "Halo {name}, permintaan Anda sudah kami terima." (`server.helpdesk.received`), where English ends with the name. Is that courteous enough for a company writing to its customers?
- **Your address** in the help desk's limits is *alamat IP Anda* (`problem.helpdesk.tooManyFromAddress` and its siblings), since *alamat* alone could be an email.
- **The issue list's count** joins a search's parts with a comma, as Intl's narrow list does in Indonesian: "4 isu di proyek SPR, belum selesai". *dan* would read more smoothly between two.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard** is *papan tulis* (`app.shell.whiteboards`, `page.whiteboards.*`), KBBI's word and Zoom's, beside *Papan* for boards in the same menu, as French has *Tableaux* and *Tableaux blancs*. Would teams rather read "whiteboard"?
- **A note** on one is *catatan*, the dashboard's word (`whiteboards.kind.note`, `page.whiteboard.addNote`). *Catatan tempel* (a sticky note) would set it apart, at a longer toolbar button.
- **Its other pieces**: a section is *bagian*, OneNote's word (`whiteboards.kind.section`); the outline *kerangka*, Google Docs' (`page.whiteboard.outline`); connecting two elements *hubungkan*; the canvas *kanvas*.
- **Make issues** is *Jadikan isu* on the toolbar and the dialog's title (`page.whiteboard.convert`, `whiteboards.convertDialog.title`), and *Buat # isu* on the dialog's button (`whiteboards.convertDialog.go`). Is *Jadikan* clear without its object, the notes?
- **A note's tones**, badges on the canvas (`whiteboards.tone.*`): *Biasa*, *Ide*, *Disepakati*, *Pertanyaan*, *Masalah*, *Ditunda*. Is *Ditunda* right for "parked", and *Disepakati* short enough?
- `page.whiteboard.delete` is *Hapus papan tulis*, though English says "Delete", since the toolbar's Remove (`page.whiteboard.remove`) is *Hapus* too. Redo is *Ulangi*, beside the catalog's *Batalkan* for undo.
- **Reading a whiteboard** is *membaca*, as for a project's readers (`page.whiteboard.readOnly`, `page.whiteboards.about`). *Melihat* may suit a canvas better.
- **Summary**: an issue's title and the assistant's summary are both *ringkasan*, so *Sarankan ringkasan* (`page.issue.suggestASummary`) sits beside *Ringkas* (`page.issue.summarise`). Clear enough?
- **Writing help's buttons** are verbs, *Persingkat*, *Perjelas*, *Buat lebih formal*, *Buat lebih ramah* (`writing.action`), and its suggestions' titles adjectives, *Lebih singkat*, *Lebih jelas* (`writing.suggestion.title`). A selection is *teks terpilih* (`writing.selected` and its siblings).
- **A chat thread** is *utas*, as Discord's and X's Indonesian say it (`server.chat.issue.thread`, `page.issue.source.replies`); an issue's own thread stays *diskusi* (`page.issue.longThreadSummarised`).
- **ClickUp's List** stays "List", as ClickUp names it (`imports.fromApi.whichTasksAList`, `problem.imports.source.clickupNoList`), since *daftar* reads as any list; ClickUp's personal token is *token pribadi* (`imports.fromApi.personalToken`), while Asana's stays "personal access token", as the catalog keeps Jira's.

Edited for natural phrasing:

A later read, again by a model and not a native speaker, edited 1,039 messages so they read as Indonesian software rather than as English translated: the sign-in page and a4a's frame, the issues and an issue, boards, the inbox and its emails, the help desk and its portal, the ledger, the query's and commands' problems, projects, dashboards, articles, and then parts of the rest (the plan, rules, days away, files, the editor, the assistant, the other problems, administration and fields). The rest of the catalog (reports, integrations, webhooks, apps, imports, builds, version control, chat, whiteboards, roles and groups) had only the sweeps below. What it chose that a native speaker should check:

- **"Anda" left out** where the page says whose it is: "Profil" (`app.shell.yourProfile`), "Memuat kotak masuk…" (`loadingLine.inbox` and its siblings), "Ponsel hilang?" (`app.auth.lostYourPhoneTypeOne`), "Bahasa browser: {name}" (`page.profile.yourBrowsersLanguage`), "Semua sudah dibaca" (`page.inbox.youReUpToDate`). Do any now read as if nobody's?
- **Acting for someone is "atas nama"**, not "untuk": "e2e atas nama Ada" (`issues.issueHistory.for`, `ui.who.for`, `activity.ledgerEntry.throughTheAssistantFor` and its siblings, `server.notify.agentFor`, `assistant.changeCard.for`), and an agent with its own token acts "atas nama sendiri" (`ui.who.overMcpAsItself`, `agents.agentAccounts.actsAsItself`). Is "atas nama sendiri" natural, or would *sebagai dirinya sendiri* be clearer?
- **"On its own" is "otomatis"** in the history and the ledger (`issues.issueHistory.onItsOwn`, `issues.issueHistory.anAppOnItsOwn`, `activity.ledgerEntry.onItsOwn`, `assistant.toolRun.assistantOnItsOwn`), and *secara mandiri* for an agent's own change (`problem.agents.onlyAgentsOwnChange`). `ui.who.onItsOwn` keeps *dengan sendirinya*, since `ui.who.automation` before it is *otomatisasi*.
- **Plain words for the assistant are "kalimat biasa"**: "Tanya dengan kalimat biasa" (`issues.queryBar.askInWords`, `issues.languageField.askInWords`), "Tulis perintah dengan kalimat biasa" (`issues.commandBar.sayWhatToDoIn`), "lewat kalimat biasa" (`issues.issueHistory.askedInWords`), and the button "Ubah jadi perintah" (`issues.commandBar.readMyWords`). *Bahasa sehari-hari* or *bahasa alami* are the alternatives.
- **Due is "tenggat" everywhere**, no longer sometimes *jatuh tempo*, which reads as a bill's: "tenggat 2 jam lagi" (`helpdesk.sla.dueIn`, `helpdesk.sla.atRiskDueIn`, `helpdesk.requestCard.firstResponseDueIn`), "terlambat 3 hari: tenggatnya 16 Nov" (`plan.gantt.daysLateWasDue`, `plan.timeline.wouldBeDaysLate`), "menandai target penyelesaian terlampaui" (`issues.issueHistory.slaBreached` and its siblings).
- **The profile's own section is "Info pribadi"**, Google Account's heading, for English's "You" (`page.profile.you`); `notifications.emailSettings.youHaveNoEmailAddress` points to it. *Data diri* is the other common heading.
- **The starting dashboard's button is "Sesuaikan"** for "Make it yours" (`page.dashboard.makeItYours`, `page.dashboard.theDashboardA4aStartsYou`), and what it makes is "Dasbor saya", listed under "Milik saya" (`page.dashboard.yourDashboard2`, `page.dashboard.yours`), with "saya" as Google Drive's "Drive Saya". A copy is "Salinan {name}" (`page.dashboard.yourCopy`).
- **The portal's summary field is labelled "Ada yang bisa kami bantu?"** (`page.portal.whatDoYouNeed`), a service desk's question, where English asks "What do you need?"; the public form's is "Perihal" (`page.help.whatItSAbout`). Right for the field they label?
- **A role in a sentence**: "Anda adalah anggota dan dapat membaca serta mengubah isu." (`page.profile.youRe` with `page.profile.roleMember` and its siblings), and the admin's list "pelihat dapat membaca, anggota dapat membaca dan mengubah isu, administrator dapat mengubah semuanya" (`page.admin.aViewerReads` and its siblings).
- **Optional is "(opsional)"** where English says "if you want one" (`issues.commandBar.aCommentIfYouWant`, `away.daysAway.aNoteIfYouWant`, `plan.baselines.aNoteIfYouWant`, `rules.ruleForm.andACommentIfIt`, `page.timesheet.workTypeIfAny`).
- **A rule that does nothing or tells nobody**: "tidak ada tindakan" (`rules.words.doNothing`) and "beri tahu “…” (tanpa penerima)" (`rules.words.tellNobody`), no longer orders not to act. A rule's example message asks with "mohon": "Ada bug kritis masuk, mohon segera diperiksa." (`rules.ruleForm.aCriticalBugCameIn`).
- **A board without a project**: "Papan kanban untuk proyek yang belum ditentukan, …" (`page.board.forInColumnsBy`, `page.board.noProject`).
- **Typography in problems**: “…” quotes now, except around JSON a script sends (`problem.notifications.sayWhich`, `problem.ci.rangeNeedsRepository`, `problem.fields.notOwned`, `problem.fields.valueInUseBy`); a parser's unexpected token is "“)” tidak seharusnya ada di sini." (`problem.query.unexpected` and its siblings); times in prose take a point, "Senin 09.00–17.00" (`problem.helpdesk.hoursNeedDay`, `problem.helpdesk.hoursBackwards`), while a parser's examples keep the colon it reads (`problem.values.notADateTime`).
- **A comment's label** is "Komentar sebagai Siti Rahayu" (`issues.issueHistory.aComment` with `issues.issueHistory.as`), without English's comma; with a requester it reads "Balasan untuk Ada sebagai Siti Rahayu" (`issues.issueHistory.aReplyTo`). Clear enough without the comma?
- **The work log's columns** are "Tanggal", "Orang", "Waktu", "Keterangan" (`issues.workLog.day`, `.who`, `.time`, `.what`), and time spent is "Waktu terpakai" (`issues.workLog.timeSpent`, `issues.fieldPanel.spentTime`, `issues.issueHistory.spentTime`), where Microsoft says *Waktu yang dihabiskan*.
- **Watchers' counts**: "Dipantau 3 orang" (`issues.watching.peopleWatchIt`, `issues.watching.n1PersonWatchesIt`), and "Pemantau mendapat notifikasi perubahan dan komentar" (`issues.watching.theyHearAboutItsChanges`) where English says "hear about". Is *notifikasi* too technical beside *kabar*?

Edited for natural phrasing, second round:

A third read, again a model's, read whole, message by message, the parts the first edit had only swept: integrations, webhooks, agents and tokens, apps, imports, builds, version control, chat and its bot, workflow's actions and state machines, whiteboards, roles, groups, provisioning and two-factor, a project's people, plan settings, fields and triage, the reports, and the problems of each. What it chose that a native speaker should check:

- **A delivery is "pengiriman"** everywhere, as the terms table always said, no longer "kiriman", which reads as a social post: "Pengiriman terbaru", " · pengiriman terakhir 3 menit yang lalu", "Dijeda: pengiriman tetap dijawab dan dicatat, tetapi tidak dibaca." (`page.integrations.*`, `page.webhooks.*`, `problem.vcs.noAddressNeeded`). Developers may simply say "delivery".
- **The copy button** says "Disalin: token." to a screen reader (`common.copyButton.copied`) while the button itself reads "Disalin" (`common.copyButton.copied2`). The button no longer looks for its own word at the line's start, so "Token disalin." would work as well; the line keeps "Disalin:" first because a copied thing's name begins in lower case ("token disalin."). Is "Disalin: kode pemulihan." natural where a screen reader says it?
- **"The commits a4a saw pushed"** is "commit dari push yang diterima a4a" (`page.integrations.a4aForgetsTheAppS`, `page.integrations.theTokenIsGoneA`, `page.integrations.withoutItABuildHolds`, `page.integrations.optionalWithATokenThat`). Clear to someone who hasn't read the English?
- **Who subscribed a chat channel** is "pembuat langganan", and the column that names them "Penanggung jawab" (`chat.chat.whoVouchesForIt`, `problem.chat.stop.subscriberGone`, `problem.chat.stop.subscriberCantSee`, `problem.chat.stop.membersOnly`, `problem.chat.subscriptionNotYours`), since "pelanggan" is the help desk's customer. Does "Penanggung jawab" say that the channel sees what that person may?
- **The bot** says "Yang saya kabarkan: isu baru, komentar." for English's "I hear of" (`server.chat.kinds`), "Saya belum mengenali Anda di a4a" (`server.chat.whoAreYou`, `server.chat.linkFirst`), and acts "atas nama Ada" (`server.chat.linkedSlack`, `server.chat.linkedTeams`, `server.chat.help`). Should a bot say "Saya" at all, or speak of itself as "bot a4a"?
- **Forget** is "Lupakan" on a button, Android's word for a Wi-Fi network (`page.integrations.forgetTheApp`, `vcs.people.forgetIt`), and "menghapus kunci" in a sentence (`page.integrations.a4aForgetsTheAppS`, `page.integrations.a4aNoLongerReadsAsThe`).
- **Typed input in problems** is asked for with "Masukkan" or "Isi" where English says "Give", and a missing value is "wajib diisi" (`problem.vcs.nameNeeded`, `problem.vcs.bitbucketAddressNeeded`, `problem.whiteboards.nameNeeded`, `problem.roles.needsName`, `server.chat.issue.summaryNeeded`, `problem.imports.source.notAnAddress` and its siblings).
- **Read-only** is "hanya-baca" (`page.agents.searchAndReadIssuesProjects`, `page.integrations.underPermissionsAndEvents`, `roles.rolesSection.aRoleIsASet`), where Microsoft's Indonesian says "baca-saja".
- **A person's place in a project**: "Anda berperan sebagai anggota di sini, seperti semua orang di proyek terbuka, jadi dapat membaca, mengomentari, dan mengubah isu proyek." (`projects.peopleAndAccess.youAreRoleHere` with `youReadCommentOnAnd` and its siblings), a lead "karena memimpin proyek ini" (`projects.peopleAndAccess.asItsLead`), and a role picker "{who} berperan minimal anggota, yang boleh …" (`roles.words.isAtLeastRoleWhoMay`). A role's phrases name the project, "membaca isu proyek, mengomentarinya" (`roles.words.readItsIssues` and its siblings).
- **A group's people** are its "anggota" ("Anggota", "Tambahkan anggota", "Asal anggota": `page.group.peopleInIt`, `page.group.putSomeoneInIt`, `groups.groupsSection.whereItsPeopleComeFrom`), beside the built-in role "Anggota": "Semua anggota QA kini berperan minimal anggota." (`groups.projectGroups.everyoneIsAtLeastRole`). Confusing?
- **Reports**: tables go "per hari", "per minggu" (`reports.burndown.dayByDay`, `reports.cumulativeFlow.issuesInEachStateDay`, `reports.timeReport.eachPersonWeekByWeek`); a sprint on schedule is "Sesuai rencana" (`reports.burndown.onTrack`); each report's figures open under "Tabel angka" (`reports.burndown.theFigures` and its siblings); the created-and-resolved line reads "3 lebih banyak daripada awal periode", "sama dengan awal periode" (`reports.createdResolved.atTheStart` with `moreThan`, `fewerThan`, `asManyAs`); cycle time is "lama pengerjaan", "85% selesai dalam" (`reports.distribution.*`).
- **A report's link** to its issues is "Buka isu ini", "Buka 5 isu ini" (`reports.moreReports.open`): it said "Terbuka", the state, for English's verb.
- **An import's steps**: "Ambil isu", "Petakan", "Periksa", "Impor", "Lihat hasilnya" (`page.import.bringTheIssues`, `page.import.readWhatItDid`), a file's source "Deteksi otomatis" (`page.import.whicheverWroteItA4aReads`), and the mapping's columns "Di BACK menjadi", "Dasar pemetaan", with "Dikenali dari judul kolom", "Dipilih manual", "Belum dipilih" (`imports.mappingTable.*`).
- **Slack's secrets are "Disimpan terenkripsi"** for English's "Kept sealed" (`page.chat.underBasicInformationA4aChecks`, `page.chat.underOauthPermissionsInThe`).
- **A paused build source's builds are "ditolak dengan sopan"** (`builds.builds.isPausedBuildsItS`), English's "refused politely": does it say that a4a answers the CI without an error?
- **GitHub's own words**: a token is "fine-grained" or "classic" with "cakupan repo" (`imports.fromApi.aFineGrainedTokenWith`, `problem.imports.source.tokenRefused`), and its steps say "lalu klik Add webhook", "pada bagian Events" (`page.integrations.inTheRepositoryOnGithub` and its siblings), with GitHub's English buttons as GitHub shows them.

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey** is *kunci sandi*, as Google's Indonesian says it (`identity.passkeys.*`, `page.profile.passkeys`, `server.passkeys.*`), beside *kata sandi* for a password: "Masuk dengan kata sandi, lalu tambahkan kunci sandi untuk alamat ini." (`problem.passkeys.elsewhere`). Do the two read apart at a glance, or would teams rather read "passkey"?
- **Signing in with one** is "Masuk dengan kunci sandi" (`app.auth.signInWithAPasskey`); beside the code after a password, "Use a passkey instead" is "Atau gunakan kunci sandi" (`app.auth.usePasskeyInstead`), shorter than "…sebagai gantinya". Natural on a button?
- **Signing out everywhere** is the button "Keluar dari semua sesi" (`page.notMe.signMeOut`, `server.passkeys.signOutEverywhere`), and in prose a4a "mengakhiri semua sesi akun ini" (`page.notMe.ifNotYou`, `server.passkeys.notYou`), so that a sentence says "Anda" once. Is "akun ini" stiff in an email to the account's own person?
- **A passkey that signs nobody in** "tidak dapat dipakai (siapa pun) untuk masuk" (`identity.passkeys.mayBeCopied`, `identity.passkeys.removed`, `page.admin.passkeysOff`, `server.passkeys.copied`), and a copied one's badge is "Dihentikan" (`identity.passkeys.stopped`). Is there a shorter way, and does "Dihentikan" say that a4a stopped it?
- **Vouch for** is *menjamin*: a provider "menjamin email mereka, apa pun alamatnya", "hanya menjamin alamat di {list}" (`helpdesk.portalSignIn.throughAny`, `throughSome`, `domainsHelp`, `page.portal.ssoDomain`), kept apart from *memverifikasi*, the provider's own check of an address (`page.portal.ssoUnverified`). Is *menjamin* what an administrator would read here?
- **The provider's form keeps OpenID Connect's English**: "Issuer", "Client ID", "Client secret", "Redirect URI", "dokumen discovery" (`helpdesk.portalSignIn.*`, `problem.portalSignIn.issuerNotUrl` and its siblings), as the catalog keeps "secret". Providers' Indonesian consoles say *ID klien*, *rahasia klien*, *URI pengalihan*: which would an administrator look for?
- **An identity provider for requesters** is "penyedia identitas untuk pemohon" (`helpdesk.portalSignIn.providers`), which a desk *menawarkan* ("ditawarkan oleh 2 layanan bantuan": `helpdesk.portalSignIn.providerAbout`, `problem.portalSignIn.providerInUse`), since *menyediakan* would sit badly beside *penyedia*.
- **One provider, two prepositions**: the portal's button is "Masuk dengan {name}" (`page.portal.signInThrough`), as Indonesian buttons say "Masuk dengan Google", while the desk's choices, a group's and the ledger say "lewat {name}" (`helpdesk.portalSignIn.through`, `helpdesk.groups.throughAlone`, `activity.ledgerEntry.signInThrough`). One throughout?
- **Setting a password** is *membuat*: "Buat kata sandi" (`page.portal.choosePassword`, `server.portalPassword.choose`), "Buat atau atur ulang kata sandi" (`page.portal.setOrResetPassword`), and the form's button "Simpan kata sandi" (`page.portal.setThePassword`). Is "Buat atau atur ulang kata sandi" too long beside "Kirim tautan masuk" and "Masuk" on a phone?
- **The ledger's line** reads "mengubah cara pemohon BACK masuk ke portal: dengan tautan dari email dan dengan kata sandi" (`activity.ledgerEntry.portalSignInChanged` with `signInByLink`, `signInByPassword`, `signInThrough`), under the badge "mengubah cara masuk" (`activity.ledgerEntry.changesHowRequestersSignIn`). Natural?
- **A guest's pages** are what a project has "terbuka untuk tamu", read "sebagai tamu": the section over its plan, reports, boards and whiteboards is headed "Juga terbuka di {name}" (`page.guestPages.alsoOpenIn`), and a whiteboard "open live" is "terbuka dengan pembaruan langsung" (`problem.whiteboards.guestStreams`). Clear?

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `attachments.attachmentList.stopAttaching` “Hentikan unggahan {name}”; `notifications.pushSettings.stopPushNotificationsTo` “Hapus {label}{v} dari notifikasi push”; `page.admin.askForAPasskeyOf` “Wajibkan kunci sandi lagi untuk {name}”. Do they read naturally?
- **A lane's own order** is "Setiap lajur memiliki urutan sendiri" (`page.board.laneOrder`, `page.board.laneOrderOn`, `page.board.laneOrderTurnedOn`), and a card's move in its issue's history "menempatkannya di atas BACK-31 di Platform board" (`boards.history.moved`), since "memindahkannya ke atas" can read as "moved it up"; a board the reader no longer sees is "salah satu papan". Natural?
- **Check runs** keep GitHub's words, "check run" and the permission "Checks: Read and write" (`page.integrations.checksOn` and its siblings, `problem.vcs.checks.needsApp`, `problem.vcs.githubApp.cantWriteChecks`), and on GitHub a pull request "menyebut" its issues, an id that names none "tidak merujuk ke isu mana pun" (`server.checks.*`). Would developers rather read *pemeriksaan*?
- **The email's Cc** stays "Cc", apart from a4a's *tembusan*: a new request's Cc is "ditahan sampai dikonfirmasi pemohon" (`helpdesk.ccSettings.confirm`, `activity.ledgerEntry.requestCcsChanged`), its people "ada di Cc email Anda" (`server.helpdesk.heldForYou`, `page.portal.heldNote`), and the acknowledgement that asks is the *email tanda terima* (`helpdesk.ccSettings.confirm`). Do the two read apart, and is *tanda terima* a service desk's word?
- **Dropping a held Cc** is "Abaikan", "{email} diabaikan dan tidak dikirimi apa pun" (`page.portal.dropHeld`, `page.portal.heldDropped`, `page.portal.confirm.dropped`, `problem.requestCcs.confirmLinkExpired`), beside "Tambahkan" (`page.portal.copyHeld`). Is *abaikan* right for a person left out?
- **Relaying** is everyone on a request "saling menerima balasan" while the desk "meneruskan balasan" (`helpdesk.ccSettings.relay`, `page.project.copiedOnRequestsNote`, `activity.ledgerEntry.requestCcsChanged`, `server.helpdesk.relay.*`, `page.unsubscribe.what`): what English calls "words" and "what others write" is *balasan*, the portal's word, and the email quotes them under "{name} menulis:". Is the switch, "Izinkan semua orang dalam permintaan saling menerima balasan", clear?
- **A desk's rules for CCs** are "pengaturan tembusan" (`activity.ledgerEntry.changesHowRequestsCopy`, `page.webhooks.requestCcRulesChange`, `page.webhooks.label.projectRequestCcsChanged`), not *aturan*, which is a4a's rules; the card is headed "Penerima tembusan" (`page.project.copiedOnRequests`).
- **Asking for passkeys** is *wajibkan*: "Wajibkan kunci sandi saat masuk", with "Tidak bagi siapa pun", "Bagi semua orang yang masuk dengan kata sandi" and "Bagi administrator" (`page.admin.requireAPasskey`, `page.admin.requireOfNobody` and its siblings, `page.admin.askForAPasskey`); **letting someone off** is *kecualikan*, "dikecualikan dari kunci sandi" (`page.admin.letOff` and its siblings, `problem.passkeys.lastAdmin`). *Minta* and *bebaskan* were the others.
- **Only some authenticators**: an authenticator is *autentikator*, as in "aplikasi autentikator"; its maker the *produsen*; attestation the maker's *jaminan*, as providers *menjamin* in wave 5 (`page.admin.attestationPrivacy`, `problem.passkeys.unattested`, `problem.passkeys.unknownMaker`); and one FIDO reports compromised "tidak lagi aman" (`problem.passkeys.untrustedMaker`). Would an administrator look for *atestasi*?
- **Passkeys alone**: "Hanya kunci sandi" in the people table (`page.admin.passkeysAlone`), "Masuk hanya dengan kunci sandi" on the profile (`identity.passkeys.passkeysAlone`), and the setup link "tautan untuk menambahkan kunci sandi", which "kedaluwarsa dalam 3 hari" (`page.admin.linkRunsOut`, `page.passkeySetup.until`, `server.passkeySetup.*`). A passkey provider is a *penyedia kunci sandi* (`identity.passkeys.keepASpare`, `problem.passkeys.spareFirst`, `server.passkeySetup.leadFirst`), where Google names its own *Pengelola Sandi*.
- **Forgejo's and Gitea's "Applications"** stays as their English settings name it (`builds.builds.forgeKeepsToken`, `builds.builds.tokenTooWide`), though their Indonesian says *Aplikasi*.

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **Status commit** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): katalog memakai "commit" tanpa diterjemahkan. GitLab berbahasa Indonesia juga menyebut "status commit". Cukup alami?
- `page.group.requirePasskeys` adalah "Wajibkan kunci sandi bagi anggota grup ini", dan `page.project.requirePasskeys` "…bagi semua yang dapat melihat proyek ini". "bagi" atau "untuk" yang lebih cocok pada label?
- `page.group.requirePasskeysHelp` diawali "Saat masuk dengan kata sandi a4a sendiri" — subjeknya "anggotanya" muncul setelahnya. Apakah urutannya terbaca jelas?
- `builds.builds.reportCheck` adalah "Laporkan hasil tiap run ke GitHub". Kata "run" dibiarkan dalam bahasa Inggris seperti katalog Builds biasa. Konsisten?
- `page.integrations.statusesNeedToken` memakai titik dua sebelum "Gitea dan Forgejo juga memerlukan alamat /api/v1." Apakah kalimat majemuk ini terbaca ringan pada layar kecil?


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` adalah “Masuk ke pencarian yang Anda ikuti”. Apakah “masuk ke” cukup jelas untuk hasil pencarian, atau “kini sesuai dengan” lebih tepat?

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` mengikuti halaman tamu yang lain. `issuesMatching` adalah “Isu yang cocok dengan” — atau “sesuai hasil pencarian”?

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` mengikuti nama alat yang ada. `writing.draftedWithTheAssistant` adalah “Asisten menyusun kata-kata ini.” — atau “menulis”?

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “Menggambar”, `page.whiteboard.picture` = “Gambar”, `whiteboards.kind.ink` = “sebuah gambar”): apakah alami?

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = “Homeserver” — dipertahankan, atau “server Matrix”?

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (lembar waktu): `page.timesheet.submit` = “Kirim minggunya” dan `page.timesheet.sendBack` = “Kirim balik” — apakah alami?

Messages added in wave 16 (the script library's page):

- Wave 16 (pustaka skrip): `page.rules.library` = “Pustaka skrip” dan `page.rules.libraryCode` = “Kode bersama” — apakah alami?

Messages added with the configurable approval rule:

- Persetujuan yang dapat diatur: `projects.workTypes.approvalEvery` = “Manajernya, di antara manajer setiap proyek yang pekan itu memuat pekerjaan” — apakah alami meski panjang?

Messages added in wave 18 (the HR calendar):

- Wave 18 (kalender SDM): `page.admin.hrCalendar` = “Kalender SDM” dan penolakan = “Hari-hari ini datang dari kalender SDM...” — apakah alami?

Messages added with the timesheet's personal view:

- Tampilan pribadi: `page.timesheet.bauOrAnythingYouKeep` = “BAU, atau apa pun yang kamu catat” dan penolakan = “...Ubah satu per satu.” — apakah alami?

Messages added with the queued scripts:

- Antrean: `rules.ruleForm.runFromTheQueue` = “Jalankan dari antrean: ia boleh memakan waktu, dan bertindak atas yang dilihatnya saat aturannya terpicu” — apakah alami meski panjang?

With the posts that change in place:

- Kiriman berubah di tempatnya – tanpa kata baru. Pertanyaan: perlukah saluran menandai bahwa kiriman diedit, atau cukup isinya diganti diam-diam?

Messages added with the load grid's team:

- Beban: `plan.resources.nothingYet` = “Belum ada” di samping orang tanpa pekerjaan terencana — apakah kata singkatnya pas?

Messages added with Teams' link unfurling:

- Membentangkan: `server.chat.issue.isShared` = “membagikan tiketnya” — apakah kata kerjanya pas di kartu?

With the requester's own language:

- Bahasa peminta: email kini mengikuti bahasa peramban (disimpan pada peminta). Tanpa kata baru. Pertanyaan: perlukah halaman portal menampilkan pemilih bahasa, atau peramban cukup?

Messages added with SAML for requesters:

- SAML untuk peminta: `problem.portal.providers.samlNeedsBoth` = “Penyedia SAML butuh URL SSO dan sertifikat penandatangannya.” — apakah alami?
## Thai

Thai was written in one pass by a writer who isn't a native speaker, as the others were; nobody who reads Thai daily has checked it. The Thai section of [translating.md](translating.md#thai) gives the reasons for each choice below.

Terms:

- **An issue is อิชชู**, the word Thai teams say for Jira's and YouTrack's issues, in the Royal Institute's spelling. ทิกเก็ต (French's "ticket") reads as a support ticket, ปัญหา (Redmine's) makes "create issue" สร้างปัญหา and clashes with a4a's problems, and งาน is taken by work logged. Would a team rather read "Issue" in Latin letters, as many Thai developers write it?
- **A project is โปรเจกต์**, as teams say it; โครงการ is the formal word, and Microsoft's.
- **A request is คำขอ**, and **a requester ผู้ร้องขอ**. คำขอ is also an HTTP request in the API's problems (`problem.attachments.noBody`, `problem.tooLarge`): is that confusing?
- **Resolve is ปิด** ("close"), resolved ปิดแล้ว, since แก้ไข is every Thai app's Edit. ปิด also closes a pull request and a dialog.
- **Subscribe is สมัครรับ** and **watch ติดตาม**, though YouTube's Thai says ติดตาม for subscribe.
- **The inbox is กล่องจดหมาย**, Gmail's word, for an inbox of notifications.
- **Days away are วันที่ไม่อยู่**, not วันลา (leave), since an absence may be a conference; is it natural?
- **A login is ชื่อผู้ใช้** (a username); **undo is เลิกทำ**, Microsoft's; **dismissing a suggestion is ปฏิเสธ**, Google Docs' word for rejecting a suggestion (it was ละเว้น, "abstain from", which stays where English means "ignore").
- **Loanwords in Thai letters**: คอมมิต, แบรนช์, เมิร์จ, บิลด์, เว็บฮุก, สปรินต์, แบ็กล็อก, เฮลป์เดสก์, and the long พูลรีเควสต์. Thai developers often write these in Latin letters instead.
- **The navigation's groups**: งาน (Work), ตัดสินใจ (Decide), สร้าง (Build), กำกับดูแล (Oversee).
- **Classifiers**: รายการ counts issues, requests and most things (“อิชชู 4 รายการ”); bots are “บอต # ตัว”; a count of zero says “อิชชู 0 รายการ” rather than ไม่มีอิชชู.

Typography and phrasing:

- **No full stop**: sentences, a problem and its fix included, are separated by a space. Do the longer problems read as two sentences, or run on?
- **Questions end in ไหม?** (“ลบ {name} ไหม?”). Thai software also writes หรือไม่, or no question mark.
- **Gregorian years, unmarked**: “17 พ.ย. 2026”, with no ค.ศ. A Thai reader who expects the Buddhist era sees 2026; should a4a mark the era, or offer the Buddhist one by choice?
- **Lists**: a4a departs from Intl's Thai list where an item is Latin: “Anna Schmidt และ Vera Viewer” for Intl's “Anna SchmidtและVera Viewer”, and a comma between Latin names where Intl puts a bare space. Is that how a Thai writer would set it?
- **Units** take Intl's short width (“1.5 ชม.”, “0 นาที”) for the space before the unit.
- **A space on each side of a value**, as names and ids need. Where a value is itself Thai (a piece the page translates, like the sign-in form's name) the space reads as a pause mid-phrase; the sign-in page's were found in its shots and fixed. Others are left where the value may be Thai or Latin: the copy button's “คัดลอก {what} แล้ว” says “คัดลอก โทเค็น แล้ว” as well as “คัดลอก URL แล้ว”, and a recipient or a `{whenWords}` may be either. A role now says which it is (`{named, select, …}`): a built-in one joins as a word, “คุณเป็นสมาชิกในโปรเจกต์นี้”, and one people named is set off, “คุณเป็น Auditor ในโปรเจกต์นี้”. Should a4a join the rest by script, as `listParts` does for lists?
- **The chat bot speaks without a pronoun** (“ยังไม่รู้ว่าคุณเป็นใครใน a4a”), as Thai drops it; does it read as a bot or as a person?
- **Requesters are named “คุณ {name}”**, with a space since a name may be Latin, and no เรียน: “คุณ {name} เราได้รับคำขอของคุณแล้ว”.
- **The passive ถูก** is avoided in events (มีการ…), but stays where it is neutral: ถูกระงับ (banned), ถูกกล่าวถึง (mentioned).
- **Free text moved to the end**, after ข้อผิดพลาด:, เหตุผล: or คำตอบ: (`problem.apps.catalogUnreadable`, `problem.workflow.ruleRefusesInItsWords`, `problem.imports.source.answeredSaying`). Natural?
- **The font**: IBM Plex Sans Thai is loopless. For long text some readers find a looped face (Plex Sans Thai Looped) easier; Ocean bundles the loopless one only.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard is ไวต์บอร์ด** (`app.shell.whiteboards`, `page.whiteboards.title` and every message that names one), in the Royal Institute's spelling, as the catalog spells เว็บไซต์ and สปรินต์. Shops and teams mostly write ไวท์บอร์ด: which should a4a use?
- **A whiteboard's note is โน้ต**, a sticky note (`page.whiteboard.addNote`, `whiteboards.kind.note`, `whiteboards.noteDialog.*`), while an absence's, an internal or a dashboard's note stays หมายเหตุ, a remark. Japanese has two words too (付箋, メモ). Is โน้ต right for something a team makes issues of?
- **The other pieces**: การ์ด (as on a board), ข้อความ for a text block, ส่วน for a section (Google Forms' word; `page.whiteboard.group` is รวมเป็นส่วน), ลูกศร, and องค์ประกอบ for an element, counted “องค์ประกอบ 3 รายการ” (`page.whiteboard.said.*`, `whiteboards.canvas.label`). The canvas is แคนวาส and the outline เค้าร่าง, Word's and Google Docs' word (`page.whiteboard.canvas`, `page.whiteboard.outline`). Would เฟรม read better for a section?
- **The toolbar** keeps to a word or two: connect is เชื่อม, as a chat account is (`page.whiteboard.connect`), make issues is สร้างอิชชู (`page.whiteboard.convert`, `whiteboards.convertDialog.title`), and redo is ทำซ้ำ, Microsoft's, which can also read as "repeat" (`page.whiteboard.redo`).
- **A note's tones** are badges (`whiteboards.tone.*`): ธรรมดา, ไอเดีย, ตกลงแล้ว, คำถาม, ปัญหา, พักไว้. Is พักไว้ clear for "parked"?
- `whiteboards.convertDialog.preview` is ตรวจก่อน, where the catalog says ตรวจสอบ, so that three buttons fit a phone's dialog beside “สร้างอิชชู # รายการ”.
- `plan.resources.cellAway` is ไม่อยู่, the catalog's word for away, but two words, which a narrow cell may break between; `plan.resources.cellOff` is หยุด.
- **Writing help is ช่วยเขียน** (`writing.help`, `writing.forTheWholeText`), a verb, as Gmail's Thai says ช่วยฉันเขียน. "Friendlier" is เป็นมิตรขึ้น (`writing.action`, `writing.suggestion.title`); เป็นกันเองขึ้น is the alternative.
- **Summary keeps its two words**: an issue's summary, its title, is หัวเรื่อง (`page.issue.suggestASummary`, `page.issue.aClearerSummary`, `page.issue.summaryWord`), and what the assistant writes of a thread is สรุป (`page.articles.summarise`, `writing.summaryOfTheSelection`). Clear side by side on an issue's page?
- **ClickUp's List is ลิสต์** (`imports.fromApi.whichTasksAList`, `imports.fromApi.theListSAddressIn`, `problem.imports.source.clickupNoList`, `problem.imports.source.notAClickupList`), a loanword in Thai letters, as Thai teams say Jira's words, while a list of tasks is รายการงาน; Asana's and ClickUp's tasks are งาน. ClickUp shows "List" in English: would Latin letters be clearer?
- **A Slack thread is เธรด** (`server.chat.issue.thread`, `page.issue.source.replies`), and Slack's message shortcut is ทางลัดบนข้อความ beside its English Callback ID (`page.chat.issuesFromMessagesNeed`).
- `issues.watching.wroteTheMessage` is “เป็นผู้เขียนข้อความต้นทาง”: ต้นทาง may read as technical.
- **A count of none stays a count** where English says "no issues": “สร้างอิชชู 0 รายการ และลิงก์ 2 รายการ” (`activity.ledgerEntry.whiteboardConverted`, `page.whiteboard.said.converted`).

Edited for natural phrasing:

A second editor, also a model and not a native speaker, read the catalog on its pages rather than beside its English (sign-in, the frame, the profile, issues, boards, the inbox and its emails, the help desk, activity, query and command problems, projects, dashboards, articles, new issues, the timesheet, files, writing help, the assistant, sprint planning, rules and reports whole; the rest by pattern) and changed 811 messages that read as a translation. These are the choices that edit made and couldn't settle:

- **Colons**: where English joins a statement to its reason or consequence with a colon, Thai now says เพราะ or จึง, or pauses with a space (about 180 messages, e.g. `workflow.actions.itSOffNobodyIs` “ปิดอยู่ จึงไม่มีใครเห็นปุ่มนี้”, `problem.emails.takenBy`, `problem.fields.cantBePrivate`). A colon stays before a list, a value, code, or “ว่างไว้: …”. Do the longer เพราะ sentences read as one thought, or run on?
- **"In words"** (plain language for the assistant) is เป็นประโยค, not the calque เป็นคำพูด: “ถามเป็นประโยค” (`issues.languageField.askInWords`, `issues.queryBar.askInWords`), “บอกสิ่งที่ต้องทำเป็นประโยค” (`issues.commandBar.sayWhatToDoIn`); the button that hands them over is “ให้ผู้ช่วยอ่าน” (`issues.commandBar.readMyWords`), and the history's “asked in words” is “สั่งด้วยข้อความ” (`issues.issueHistory.askedInWords`). Would Thai teams say ภาษาพูด, or ภาษาธรรมชาติ?
- **The team is ทีมงาน where customers read it** (`page.portal.*`, `page.help.*`, `page.track.*`, `server.helpdesk.*`), ทีม on the team's own pages (`helpdesk.*`). Is the split natural, or should one word serve both?
- **Someone a4a can't name** is “ผู้ใช้ไม่ทราบชื่อ”, shown in bold as a name (`issues.issueHistory.someone`, `page.issue.someone`, `activity.ledgerEntry.someone`, `server.notify.someone`, `page.guestPages.someone`, `page.articles.someone`, `vcs.issueCode.someone`), where it was ใครบางคน.
- **A notification names "this issue"**: “{who} มอบหมายอิชชูนี้ให้คุณ” (`server.notify.title.assigned`, `server.notify.title.reportedAndAssigned`), “รายงานอิชชูนี้” (`server.notify.verb.reported`, `issues.issueHistory.reportedIt`). An email's lead (`server.mail.lead`) then reads “Ada มอบหมายอิชชูนี้ให้คุณ (BACK-12: …)”: is อิชชูนี้ redundant beside the id?
- **Acting on its own**: an automation or an app is “โดยอัตโนมัติ” (`ui.who.onItsOwn`, `issues.issueHistory.onItsOwn`, `activity.ledgerEntry.onItsOwn`, `issues.issueHistory.anAppOnItsOwn`), the assistant “ลงมือเอง”, as its Acts mode is ลงมือ (`assistant.toolRun.assistantOnItsOwn`, `assistant.toolRun.onItsOwnAsYou`).
- **The profile's role line** is one sentence with ซึ่ง: “คุณเป็นผู้ดูแลระบบ ซึ่งเปลี่ยนแปลงได้ทุกอย่าง” (`page.profile.youRe` with `page.profile.roleAdmin`, `page.profile.roleMember`, `page.profile.roleViewer`). Natural, or better as two?
- **The profile's first section** is ข้อมูลส่วนตัว, not คุณ (`page.profile.you`), and the email settings point to it by that name (`notifications.emailSettings.youHaveNoEmailAddress`). It holds name, email, time zone and language: is ข้อมูลส่วนตัว too narrow?
- **A status word after a value takes แล้ว**: “bug เพิ่มแล้ว”, “นำออกแล้ว” (`ui.changes.added`, `ui.changes.removed`, `common.changeLines.*`).
- **Not found and unknown**: an unknown issue, project, user, tag, group or build is ไม่พบ, as the terms table says for not found (`problem.query.unknownProject`, `problem.command.unknownIssue` and siblings); an unknown field, value or command stays ไม่รู้จัก, as Thai tools say a word isn't recognised. Is the line drawn in the right place?
- **The editor's Visual mode** is จัดรูปแบบ (`editor.richField.visual`), where it was ภาพ ("picture"). Which word do Thai teams know from their editors?
- **Copies**: a shared dashboard's copy is named “สำเนาของ {name}”, as Google Drive names copies (`page.dashboard.yourCopy`), made with “ทำสำเนา” (`page.dashboard.copyIt`); the default dashboard's button is “สร้างแดชบอร์ดของฉัน” (`page.dashboard.makeItYours`).
- **Time zones in parentheses**: “เขตเวลาของเซิร์ฟเวอร์ (Europe/Berlin)” and “ใช้เขตเวลาของเบราว์เซอร์ (Asia/Bangkok)” (`page.profile.theServerS`, `page.profile.useYourBrowserS`), where English has a comma.
- **Waiting states**: “Waiting on someone” is “รอผู้อื่น” (`page.fields.waitingOnSomeone`, `reports.cumulativeFlow.waitingOnSomeone`).

Edited for natural phrasing, second round:

A third editor, also a model, read the parts the second hadn't read whole (integrations, webhooks, agents, apps, imports, builds, version control, chat, administration, roles, groups, identity, whiteboards, workflow, fields, days away, app consent, projects and the plan, with their problems) and changed 578 messages. These are its choices that a native speaker should settle:

- **The chat bot names itself a4a**, as its handle reads, where it said บอต of itself: “a4a ไม่ได้อยู่ใน {channel} เชิญด้วย /invite @a4a”, “จากนั้น a4a จะทำงานในนามของคุณ” (`server.chat.issue.notInChannel`, `server.chat.issue.onlyChannels`, `server.chat.linkFirst`, `server.chat.linkedSlack`, `server.chat.linkedTeams`, `server.chat.whoAreYou`); its help is “คำสั่งที่ใช้ได้” (`server.chat.help`, `server.chat.unknown`). Does a4a read as the bot speaking, or would “บอต a4a” be clearer?
- **On and paused**: an integration, a webhook and a build source that takes what's sent are “ใช้งานอยู่” beside “หยุดชั่วคราว” (`page.integrations.takesDeliveries`, `page.webhooks.sends`, `builds.builds.takesBuilds`), where the badges said รับการส่ง, ส่ง and รับบิลด์. English's verb is gone: is that what Thai admin pages say?
- **“Nobody can bring it back” is “กู้คืนไม่ได้”** (`page.whiteboard.deleteAbout`, `page.fields.itsValuesGoWithIt`, `page.fields.nobodyCanBringItBack`, `page.import.theirCommentsLinksAndLogged`, `apps.appsSection.itsPartsGoCounted`, `roles.rolesSection.nobodyHasItInAny`), where it was ไม่มีใครนำกลับมาได้.
- **A machine's moves are its transitions**, การเปลี่ยนสถานะ (`workflow.machines.changeSMoves` “แก้ไขการเปลี่ยนสถานะของ {field}”, `workflow.machines.sMovesAreSaved`, `workflow.machines.nowGoesByItsMoves`, `workflow.machines.whenChangesThenItMust`), and the issue's bar of them is “เปลี่ยนสถานะ” (`workflow.workflowBar.moveItOn`), where they were การย้าย. Does “การเปลี่ยนสถานะของ State” read as a field's transitions?
- **Holiday, as a reason for days away, is ลาพักร้อน** (`away.words.holiday`), HR's word for annual leave, where it was วันหยุด, a day off or a public holiday. Too formal for a team's calendar?
- **Labels are nouns, not English's questions**: “อิชชูที่จะนำเข้า: JQL” (`imports.fromApi.whichIssuesAJql` and siblings), “ใช้สำหรับ” (`roles.rolesSection.whatItSFor`, `groups.groupsSection.whatItSFor`), a token's columns “ขอบเขต” and “โปรเจกต์” (`page.agents.may`, `page.agents.where`, `agents.agentAccounts.may`, `agents.oAuthApps.where`), and a webhook's “When”: “เวลา” over its deliveries (`page.webhooks.when`), as an integration's says, and “ส่งเมื่อ” over the events (`page.webhooks.sendsWhen`).
- **Thai values joined as words**: where a piece's value is always Thai, it joins with no space: “ได้รับแจ้งเรื่อง{what}” (`chat.chat.hearsOf`), “ค้นหา{where}” (`page.integrations.looksForItsSecretBegins`), “อ่าน{r}” (`apps.appsSection.reading`, a part of a4a by its Thai name), “{v}การสมัครรับ” (`chat.chat.sSubscriptionTo`). Where a value was Thai words or project keys by turns, the message now selects on which, each case whole: “ทำงานในทุกโปรเจกต์” and “ทำงานใน BACK และ WEB” (`apps.appsSection.runsIn`), “· ฟิลด์: Fixed in build” and “· ยังไม่มีฟิลด์บิลด์” (`builds.builds.buildsOfFromInto`); and a widget's place is a case of its own (`apps.appsSection.widgetAt`: ““Panel” ใต้หัวเรื่องของอิชชู”).
- **Your role in a project** says its consequence with จึง: “คุณเป็นสมาชิกในโปรเจกต์นี้ ในฐานะสมาชิกของ Eng จึงอ่าน แสดงความคิดเห็น และเปลี่ยนอิชชูได้” (`projects.peopleAndAccess.youAreRoleHere`, `projects.peopleAndAccess.youAreRoleHereYouMay`, with `projects.peopleAndAccess.youReadCommentOnAnd` and its siblings). Does the sentence hold together?
- **Lines of facts** in the import list and on a whiteboard's card are separated by “ · ” where English has commas (`page.import.fromIssues`, `page.import.fromRows`, `page.whiteboards.row`), since bare spaces ran a count into a clock time.
- **The mapping table's “Created” and “Updated”** are two messages each now: a column maps to สร้างเมื่อ and อัปเดตเมื่อ (`imports.mappingTable.whenCreated`, `whenUpdated`), beside ปิดเมื่อ (`resolved`), and the tally after an import counts สร้างแล้ว and อัปเดตแล้ว (`imports.mappingTable.created`, `updated`), beside จะสร้าง and จะอัปเดต.
- **“Send a test” is “ส่งทดสอบ”**, and its outcome “ส่งทดสอบถึงแล้ว”, “ส่งทดสอบไม่สำเร็จ” (`page.integrations.sendATest`, `page.webhooks.sendATest`, `page.webhooks.theTestArrived`, `page.integrations.theTestDidnTGo`), where it was การทดสอบ.
- **A baseline's default name** is “แผน ณ {when}” (`plan.baselines.planOf`), where it was แผนของ, and the what-if is the table's จำลองสถานการณ์ on its button and heading (`plan.timeline.whatIf`), where it was ถ้าหาก….

Messages added in wave 5 (passkeys, the portal's sign-in, guests):

- **A passkey is พาสคีย์**, as Google's, Apple's and Microsoft's Thai write it (`identity.passkeys.*`, `app.auth.signInWithAPasskey`, `server.passkeys.*`), counted “พาสคีย์ 2 รายการ” (`page.admin.withPasskeys`, `problem.passkeys.tooMany`, `server.passkeys.removedByAdmin`). Is รายการ the classifier a reader expects for keys?
- **A copied passkey “อาจถูกคัดลอก”**, with ถูก, since being copied befalls it (`identity.passkeys.mayBeCopied`, `page.notMe.copied`, `problem.passkeys.copied`, `server.passkeys.copied`). Its badge is “ระงับแล้ว”, suspended, for English's "Stopped" (`identity.passkeys.stopped`), and a synced one's “ซิงค์แล้ว” (`identity.passkeys.synced`). Do the badges read as the passkey's state?
- **Signing out everywhere is “ออกจากระบบทุกเซสชัน”** (`page.notMe.signMeOut`, `server.passkeys.signOutEverywhere`, `page.notMe.ifNotYou`, `server.passkeys.notYou`), as the profile's “ออกจากระบบทุกเซสชันแล้ว” says it; Google's Thai says ออกจากระบบในอุปกรณ์ทั้งหมด. "This wasn't me" is “ไม่ใช่ฉัน” (`server.passkeys.thisWasntMe`). Plain enough for someone a mail has alarmed?
- **A provider's fields keep its own names in Latin letters**: Issuer, Client ID, Client secret, Redirect URI (`helpdesk.portalSignIn.issuer`, `helpdesk.portalSignIn.clientId`, `helpdesk.portalSignIn.clientSecret`, `helpdesk.portalSignIn.redirectUri`, `problem.portalSignIn.issuerNotUrl` and its siblings), as `page.integrations.appId` keeps GitHub's App ID, and since "issuer" in Thai letters would read as อิชชู. Google's and Microsoft's Thai consoles say รหัสไคลเอ็นต์ and URI การเปลี่ยนเส้นทาง: should a4a?
- **An identity provider for requesters** is “ผู้ให้บริการข้อมูลประจำตัวสำหรับผู้ร้องขอ” (`helpdesk.portalSignIn.providers`), counted with ราย (`problem.portalSignIn.tooManyProviders`). A desk that offers or takes a way “เปิดให้ใช้” it (`helpdesk.portalSignIn.providerAbout`, `helpdesk.groups.asTheDeskTakes`, `problem.portal.passwordsOff`), and a provider vouching for an address “รับรอง” it (`helpdesk.portalSignIn.throughAny`, `page.portal.ssoDomain`). Desks count themselves, “เปิดให้ใช้ใน 2 เฮลป์เดสก์”: would แห่ง read better?
- **The portal's button for a provider is “เข้าสู่ระบบด้วย {name}”**, as the team's sign-in page says it (`page.portal.signInThrough`), while a desk's settings and the ledger say “ผ่าน {name}” (`helpdesk.portalSignIn.through`, `activity.ledgerEntry.signInThrough`).
- **"My password"**: the portal's account page says “เปลี่ยนรหัสผ่านของฉัน”, beside its “เปลี่ยนชื่อของฉัน” (`page.portal.changePassword`), but the sign-in form's link is “ตั้งหรือรีเซ็ตรหัสผ่าน”, without ของฉัน, to stay short (`page.portal.setOrResetPassword`).
- `helpdesk.portalSignIn.passwordHelp` names the form's proof of work by its setting, การตรวจสอบว่าผู้ส่งเป็นคน (`helpdesk.helpdeskSettings.makeSureAPersonSent`).
- **A guest's pages**: a guest project's other pages are under “ส่วนอื่นของ {name} ที่เปิดให้ดู” (`page.guestPages.alsoOpenIn`), and a whiteboard open live is “เปิดดูแบบเรียลไทม์” (`problem.whiteboards.guestStreams`).
- The ledger's badge is “เปลี่ยนวิธีเข้าสู่ระบบ”, without whose, to stay a badge (`activity.ledgerEntry.changesHowRequestersSignIn`); `page.notMe.what` sets its time off with “ · ”, “พาสคีย์ “iCloud Keychain” ในบัญชี a4a anna · 3 ชั่วโมงที่ผ่านมา”, as lines of facts do above.

Messages added in wave 6 (lanes, checks on pull requests, CCs, passkeys in depth, the portal's passkeys):

- **“Just now” is ไม่กี่วินาทีที่แล้ว** (`ui.badges.justNow`, was เมื่อสักครู่), worded as a relative time so it takes the particle one does: “เพิ่มเมื่อ{when}” can't say “เมื่อเมื่อสักครู่”. Natural, for under 45 seconds?
- **Names a screen reader hears now keep the words their control shows**, whole and in order (WCAG 2.5.3, which `check:words` now checks): `helpdesk.groups.removeMember` “นำออกจากกลุ่ม: {email}”; `notifications.pushSettings.stopPushNotificationsTo` “นำออกจากการแจ้งเตือนแบบพุช: {label}{v}”; `page.admin.removePasskeysOf` “นำพาสคีย์ออกจากบัญชีของ {name}”. Do they read naturally?
- **A lane's own order** is “แต่ละแถวมีลำดับของตัวเอง”, a lane being แถว as the board already says, beside “ลำดับของบอร์ด” (`page.board.laneOrder`, `page.board.laneOrderHelp`, `page.board.laneOrderTurnedOff`). A card's move in its issue's history is “ย้ายไปไว้เหนือ BACK-31 ใน Platform board”, and a board the reader can't see “ในบอร์ดหนึ่ง” (`boards.history.moved`). Is แถว still clear for a swimlane once lanes have orders of their own, or would เลน read better?
- **A check run keeps GitHub's name in Latin letters**, “check run ชื่อ “a4a””, as the catalog keeps GitHub App and its permissions' names (`page.integrations.checksOn`, `page.integrations.checksLegend`, `problem.vcs.checks.needsApp`, `problem.vcs.githubApp.cantWriteChecks`, `server.checks.summary.rule`). It fails as Thai developers say a check does, “ไม่ผ่าน” (`page.integrations.checksResolved`); a check names issues, ระบุ, and an id naming none is “รหัสที่ไม่ตรงกับอิชชูใด” (`server.checks.title.*`, `server.checks.summary.*`). Would a team rather read เช็ก, or การตรวจสอบ? (เช็กชื่อ is also a roll call.)
- **An email's Cc keeps its Latin name**, set apart from a4a's copy, สำเนา: “ผู้ที่อยู่ใน Cc ของคำขอใหม่” (`helpdesk.ccSettings.confirm`, `helpdesk.ccSettings.trusts`, `activity.ledgerEntry.requestCcsChanged`, `page.project.copiedOnRequestsNote`, `page.portal.heldNote`, `page.portal.confirm.lead`, `helpdesk.requestCcs.heldNote`, `server.helpdesk.heldForYou`), since "your email copied these people" said with ส่งสำเนา would clash with "they hear nothing until you copy them". Gmail's Thai names the field สำเนา, Outlook's สำเนาถึง: would either be plainer to a requester?
- **A held CC waits for confirmation, รอการยืนยัน**: “รอคุณยืนยัน”, “รอ {requester} ยืนยัน” (`page.portal.heldTitle`, `helpdesk.requestCcs.held`), and the desk's switch “รอให้ผู้ร้องขอยืนยันผู้ที่อยู่ใน Cc ของคำขอใหม่ก่อนส่งสำเนา” (`helpdesk.ccSettings.confirm`). Dropping one is “ไม่ส่งสำเนา” (`page.portal.dropHeld`, `page.portal.heldDropped`, `page.portal.confirm.dropped`). Would the catalog's พักไว้ ("set aside") say "held" better?
- **Relaying is ส่งต่อ**, Gmail's word for forwarding, and hearing each other “ได้รับข้อความของกันและกัน” (`helpdesk.ccSettings.relay`, `server.helpdesk.relay.*`, `page.unsubscribe.what`); the ledger's case without it is “ส่งออกเฉพาะข้อความของทีม” (`activity.ledgerEntry.requestCcsChanged`). Does ส่งต่อ read as the desk passing words on, rather than someone forwarding a mail?
- **An authenticator is ตัวยืนยันตัวตน**, after the catalog's แอปยืนยันตัวตน, as ตัวจัดการ is a handler, and it's counted by model, รุ่น: “เฉพาะตัวยืนยันตัวตนบางรุ่น”, “เลือกแล้ว 3 รุ่น” (`page.admin.onlySomeAuthenticators`, `page.admin.takeOnlySome`, `page.admin.authenticatorsChosen`, `identity.passkeys.onlyThese`, `problem.passkeys.notListed`). A maker vouching is รับรอง, as a provider vouches for an email, and FIDO's metadata ข้อมูลเมตา (`page.admin.attestationPrivacy`, `page.admin.metadata*`, `problem.passkeys.unattested`). Microsoft's Thai says ตัวรับรองความถูกต้อง: which would an administrator know?
- **A security key is คีย์ความปลอดภัย**, Google's Thai, and a passkey provider ผู้ให้บริการพาสคีย์ (`app.auth.passkeysAreRequiredOfYou`, `identity.passkeys.keepASpare`, `problem.passkeys.spareFirst`, `server.passkeySetup.leadFirst`).
- **Passkeys alone is พาสคีย์เท่านั้น**: “เข้าสู่ระบบด้วยพาสคีย์เท่านั้น” on the profile, “พาสคีย์เท่านั้น” in the people table (`identity.passkeys.passkeysAlone`, `page.admin.passkeysAlone`, `page.admin.passkeysAloneChoice`). "Nobody can phish one" is “ไม่มีใครเดาหรือหลอกขโมยไปได้” (`identity.passkeys.passkeysAloneAbout`): would ฟิชชิง be plainer?
- **The setup link is “ลิงก์เพิ่มพาสคีย์”**, as the portal's is “ลิงก์ตั้งรหัสผ่าน” (`page.admin.linkRunsOut`, `page.admin.sendALinkTo`, `server.passkeySetup.subjectAgain`, `problem.passkeys.setupHasPassword`). A time still to come joins with no space, “จะหมดอายุในอีก 3 วัน” (`page.admin.linkRunsOut`, `page.passkeySetup.until`), since Intl's “ในอีก …” always begins in Thai.
- **Requiring passkeys**: the legend “ขอพาสคีย์เมื่อเข้าสู่ระบบ” and choices that go on from it, “ไม่ขอจากใคร”, “จากทุกคนที่เข้าสู่ระบบด้วยรหัสผ่าน”, “จากผู้ดูแลระบบ” (`page.admin.requireAPasskey`, `page.admin.requireOfNobody`, `page.admin.requireOfEveryone`, `page.admin.requireOfAdmins`), as English's "Of administrators" does; sentences say กำหนดให้ต้องใช้พาสคีย์, as the catalog says of two-factor (`identity.passkeys.requiredOfYou`, `problem.passkeys.requiredNotCode`). Do choices beginning with จาก read right as radio buttons?
- **Letting someone off is ยกเว้น** (`page.admin.letOff`, `page.admin.letOffFor`, `page.admin.letOffPasskeys` “ได้รับยกเว้นพาสคีย์”), and taking it back “ขอพาสคีย์”, as English's "Ask for a passkey" (`page.admin.askForAPasskey`), rather than the shorter pair's เลิกยกเว้น. Which would an administrator expect beside ยกเว้น?
- **A requester's passkey is พาสคีย์เฮลป์เดสก์**, and "your help desk sign-in" “การเข้าสู่ระบบเฮลป์เดสก์ของคุณ” (`helpdesk.portalPasskeys.notMeAdded`, `helpdesk.portalPasskeys.notMeCopied`, `server.portalPasskeys.subject`, `problem.portalPasskeys.teamPasskey`). The mailbox that proves a requester is “อีเมลของคุณ”, since กล่องจดหมาย is a4a's inbox (`helpdesk.portalPasskeys.confirmWhy`).
- **The portal's notes after "added …, last used …" are whole sentences**, with their subject: “พาสคีย์นี้อาจถูกคัดลอก จึงไม่มีใครใช้เข้าสู่ระบบได้”, “พาสคีย์นี้สร้างไว้สำหรับ {host} จึงใช้เข้าสู่ระบบที่นี่ไม่ได้” (`helpdesk.portalPasskeys.mayBeCopied`, `helpdesk.portalPasskeys.elsewhere`), where the team's, after a badge, stay fragments.
- **A GitHub App's installations** carry the badges “องค์กร”, “ผู้ใช้”, “ไม่มีแล้ว” for gone and “ถูกระงับ” for suspended (`page.integrations.accountOrganization`, `page.integrations.accountUser`, `page.integrations.installationGone`, `page.integrations.installationSuspended`). Is ไม่มีแล้ว clear, or should it say ถอนการติดตั้งแล้ว? Forgejo's and Gitea's “Applications” stays in Latin letters, as their settings show it (`builds.builds.forgeKeepsToken`, `builds.builds.tokenTooWide`).

Messages added in wave 7 (passkeys required of a group or a project, a changed relying party, a build's own check run, commit statuses on GitLab's and Forgejo's pull requests):

- **สถานะคอมมิต** (`page.integrations.statusesLegend`, `statusesOn`, `problem.vcs.checks.needsToken`): คำนี้ใช้ทั้ง GitHub และ GitLab ภาษาไทย อ่านสอดคล้องกับ "check run" ที่คงภาษาอังกฤษไหม
- `page.group.requirePasskeys` คือ "กำหนดให้คนในกลุ่มนี้ต้องใช้พาสคีย์" และ `page.project.requirePasskeys` คือ "กำหนดให้ทุกคนที่เห็นโปรเจกต์นี้ได้ต้องใช้พาสคีย์" ยาวพอสำหรับป้ายกำกับหรือไม่ ตัดเป็น "ต้องใช้พาสคีย์" อย่างเดียวได้ไหม
- `page.group.requirePasskeysHelp` ว่า "บัญชี single sign-on และไดเรกทอรียังเป็นของผู้ให้บริการ" คำ "ไดเรกทอรี" (directory account) ชัดเจนไหม
- `builds.builds.reportCheck` คือ "รายงานผลของแต่ละการรันไปยัง GitHub" ใช้ "การรัน" ตามที่หน้า Builds ใช้อยู่ สอดคล้องไหม
- `page.integrations.statusesAudience` ว่า "สถานะจึงระบุอิชชูด้วยรหัสเท่านั้น" ตรงข้ามกับ check run ที่มีลิงก์ อ่านเข้าใจไหม


Messages added in wave 8 (a Forgejo run's commits read from its compare; what time alone brings into a search):

- `server.notify.title.cameIn` คือ “เข้ามาในการค้นหาที่คุณติดตาม” “เข้ามาใน” อ่านเป็นการกระทำของใครหรือไม่ หรือควรเป็น “ตรงกับการค้นหาที่คุณติดตามแล้ว”

Messages added in wave 9 (a guest's article page, and a report's count opening its issues):

- `page.guestPages.noSuchArticle` ตามถ้อยคำของหน้าแขกอื่น `issuesMatching` คือ “อิชชูที่ตรงกับ” — หรือ “ที่ตรงเงื่อนไข” จะดีกว่าไหม

Messages added in wave 10 (a requester's editor, the link tool, streamed drafts and the drafted mark):

- `editor.visualEditor.link` ตามชื่อเครื่องมือที่มีอยู่ `writing.draftedWithTheAssistant` คือ “ผู้ช่วยร่างข้อความเหล่านี้” — ควรมีจุดท้ายประโยคตามหลักหรือไม่

Messages added in wave 11 (a person's own whiteboard, drawings and pictures):

- Wave 11 (`page.whiteboard.draw` = “วาด”, `page.whiteboard.picture` = “รูปภาพ”, `whiteboards.kind.ink` = “เส้นที่วาด”): ดูเป็นธรรมชาติไหม

Messages added in wave 13 (Matrix chat):

- Wave 13 (Matrix): `page.chat.matrixHomeserver` = “โฮมเซิร์ฟเวอร์” — เหมาะสมหรือควรใช้คำทับศัพท์

Messages added in wave 14 (a sprint's team, and timesheets submitted and approved):

- Wave 14 (ใบบันทึกเวลา): `page.timesheet.submit` = “ส่งสัปดาห์” และ `page.timesheet.sendBack` = “ส่งกลับ” — ธรรมชาติหรือไม่

Messages added in wave 16 (the script library's page):

- Wave 16 (ไลบรารีสคริปต์): `page.rules.library` = “ไลบรารีสคริปต์” และ `page.rules.libraryCode` = “โค้ดที่ใช้ร่วมกัน” — ธรรมชาติหรือไม่

Messages added with the configurable approval rule:

- การอนุมัติที่ตั้งค่าได้: `projects.workTypes.approvalEvery` = “ผู้จัดการของมัน ในกลุ่มผู้จัดการของทุกโปรเจกต์ที่สัปดาห์นั้นมีงาน” — ยาวแต่เป็นธรรมชาติไหม

Messages added in wave 18 (the HR calendar):

- Wave 18 (ปฏิทิน HR): `page.admin.hrCalendar` = “ปฏิทิน HR” และข้อความปฏิเสธ = “วันเหล่านี้มาจากปฏิทิน HR...” — ธรรมชาติหรือไม่

Messages added with the timesheet's personal view:

- มุมมองส่วนตัว: `page.timesheet.bauOrAnythingYouKeep` = “BAU หรืออะไรก็ตามที่คุณบันทึก” และข้อปฏิเสธ = “...เปลี่ยนทีละรายการ” — ธรรมชาติหรือไม่

Messages added with the queued scripts:

- คิว: `rules.ruleForm.runFromTheQueue` = “รันจากคิว: ใช้เวลาได้ และทำงานกับสิ่งที่เห็นตอนกฎทำงาน” — ยาวแต่เป็นธรรมชาติหรือไม่

With the posts that change in place:

- โพสต์เปลี่ยนที่เดิม – ไม่มีถ้อยคำใหม่ คำถาม: ควรให้ช่องเห็นว่าแก้ไขแล้ว หรือแทนที่เนื้อหาเงียบๆ ก็พอ

Messages added with the load grid's team:

- ภาระ: `plan.resources.nothingYet` = “ยังไม่มี” ข้างคนที่ยังไม่มีงานที่วางแผน — คำสั้นๆ เหมาะสมไหม

Messages added with Teams' link unfurling:

- การขยาย: `server.chat.issue.isShared` = “แชร์ตั๋วแล้ว” — คำกริยาบนการ์ดเหมาะสมไหม

With the requester's own language:

- ภาษาของผู้ร้อง: อีเมลตามภาษาของเบราว์เซอร์แล้ว (เก็บไว้ที่ผู้ร้อง) ไม่มีคำใหม่ คำถาม: หน้าพอร์ทัลควรมีตัวเลือกภาษาหรือไม่ หรือเบราว์เซอร์ก็พอ

Messages added with SAML for requesters:

- SAML สำหรับผู้ร้อง: `problem.portal.providers.samlNeedsBoth` = “ผู้ให้บริการ SAML ต้องมี URL SSO และใบรับรองการลงนาม” — เป็นธรรมชาติไหม
## What a catalog can't say yet

These need the code to change, not a catalog:

- **French can't elide before a name**: "de {name}" prints "de Ada", not "d’Ada", since the name is a value.
- **Spanish's "y" before an "i" sound**: `problem.command.valueOfFields` joins two field names with "y", which should be "e" when the second starts with an "i" sound. Field names are data. Intl's lists already say "e" there ("Priority e Importancia"); this message writes its "y" itself.
- **A field's or state's gender**: a message that agrees with `{field}`, `{state}` or `{close}` assumes one.
- **Notes kept before a4a kept their words**: a commit's command note, a rule's run, a build's note and why a chat subscription, channel or workspace stopped, written before migrations `0028_build_notes` and `0029_kept_notes`, stay in the English they were kept in. New ones are said in each reader's language.
- **Lists inside the server's problems**: the server joins what a problem lists with ", ": fields, values, roles, boards, sprints, projects, logins, a GitHub App's installations (`problem.issues.noSuchField`, `problem.values.unknownValue`, `problem.access.unknownRole`, `problem.vcs.githubApp.whichInstallation` and their like). Japanese and Chinese read 「acme (123), anna (456)」 where they would write 「、」. An issue's history shows a change to a multi-value field or to its tags joined the same way, as the server keeps the change (`packages/server/src/services/issues.ts`, and `presentValues` in `packages/server/src/services/values.ts`).
- **Whether a value is Chinese**: Chinese spaces a value written in Latin letters or digits and not one written in Chinese, and a catalog can't tell which a value is, so it spaces names, ids and numbers. A person or a project named in Chinese gets spaces it doesn't need: 「以 王芳 身份」.
- **Korean's particles after a Latin word**: a4a chooses a particle after Hangul and digits (`koreanParticles` in `packages/shared/src/i18n.ts`), but can't hear how a Latin name, state or key ends, so there Korean keeps both ways (을(를), 이(가)). A value passed with whether it ends in a consonant would let Korean choose the one it needs.
- **Portuguese's contractions with a value**: a product's or a desk's name takes an article in Portuguese ("do GitHub", "no centro de apoio de X"). The catalog writes the article into the message, so it assumes a masculine product (identity providers, trackers, chat platforms) and leaves the desk's name without one, so each message says "ao", "no" or "do" before it (`server.helpdesk.deskOf`, `server.portal.deskOf`).
