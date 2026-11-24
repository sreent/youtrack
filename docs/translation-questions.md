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

Messages added with a desk's own provider:

- Der eigene Provider eines Desks: `problem.portal.providers.onlyAdmins` = „Nur Administratoren verwalten die Provider des Servers. Die eigenen verwaltet der Manager eines Desks.“ — klingt die Trennung natürlich?

With the group's members hearing of its requests:

- Die Mitglieder hören von den Anfragen ihrer Gruppe (keine neuen Wörter); eine Frage: soll die Kopie an die Mitglieder im Betreff oder Text als „über deine Gruppe“ erkennbar sein?

With the customers' directory:

- Das Kundenverzeichnis (keine neuen Wörter); eine Frage: soll die Namensliste im Formular nur die Namen zeigen, oder auch die Domains als Hinweis daneben?

Messages added with the several groups:

- Mehrere Gruppen pro Requester: `problem.helpdesk.severalGroups` = „Der Requester ist hier in mehreren Kundengruppen. Nennen Sie, für welche diese Anfrage ist.“ — klingt die Aufforderung natürlich?
## Spanish

One Spanish for Spain and Latin America, as [translating.md](translating.md) says.

Its open questions were settled by a model editor's pass on 18 November 2026: 89 settled, 5 left for a native speaker.

Phrasing:

- `reports.burndown.added` is both a column of the burndown's table, an amount ("Agregado", as "Quitado" and "Terminado" are), and the kind of one issue's change in its list, where "Agregada" would agree with the issue as "Sacada", "Resuelta" and "Reabierta" now do. It needs a message for each use; meanwhile it says the column's "Agregado".

With the posts that change in place:

- Las publicaciones cambian en su sitio – sin palabras nuevas; una pregunta: ¿debería verse en el canal que se editó, o basta con el contenido reemplazado en silencio?

With the requester's own language:

- El idioma del solicitante: los correos siguen ahora el del navegador (guardado en el solicitante). Sin palabras nuevas; una pregunta: ¿la página del portal debería mostrar un selector de idioma, o basta el navegador?

With the group's members hearing of its requests:

- Los miembros se enteran de las solicitudes de su grupo (sin palabras nuevas); una pregunta: ¿debería la copia decir “de tu grupo” en el asunto o el texto?

With the customers' directory:

- El directorio de clientes (sin palabras nuevas); una pregunta: ¿la lista del formulario debe mostrar solo los nombres, o también los dominios como pista al lado?

## French

Its open questions were settled by a model editor's pass on 18 November 2026: 91 settled, 0 left for a native speaker.

Five wait on the code or the product, not on a native speaker's ear:

- `helpdesk.portalSignIn.throughSome`: "que des adresses de {list}", where {list} is bare domains ("de acme.com et acme.fr"). "de" before a value that begins with a vowel is the elision the translator is being taught (below, under What a catalog can't say yet); the message keeps "de" for it.
- **Posts that change in place** (no words of their own): should a channel see that a post was edited, or is its content replaced silently enough?
- **The requester's own language** (no words of their own): emails follow the browser's language, kept on the requester. Should the portal offer a choice of language, or is the browser's enough?
- **A group's members hearing of its requests** (no words of their own): should the copy say "de votre groupe" in its subject or its text? That would take a message of its own.
- **The customers' directory** (no words of their own): should the form's list show names alone, or each one's domains beside it?

## Japanese

Its open questions were settled by a model editor's pass on 18 November 2026: 87 settled, 2 left for a native speaker.

Both wait on the code as much as on an ear:

- **A group member's copy** (`server.helpdesk.cc.whyAnswer`, `whyLink`): a customer group's members now get its new requests' emails as CCs, so each says only 「{requester}様から{desk}へのリクエストのCCに入っているため、このメールをお送りしています。」. A Japanese customer who never asked to be copied expects to be told why: 「{group}のメンバーとして…」. That needs the server to say the copy is the group's, with the group's name; meanwhile it reads as any CC's, which is true of how a4a sends it.
- **The customers' directory** on a group's form lists names alone. Japanese companies' names are long and their group companies' alike (「〇〇システム株式会社」, 「〇〇システムズ株式会社」), so the domain beside each name would tell them apart. That needs the page to show it; meanwhile there are no words to change.

## Portuguese

`pt.json` was written for Brazil in one pass by a model working from English, then edited by a model for natural Brazilian phrasing. It is now Portugal's Portuguese: a third pass, by a model again and not a native speaker, converted every message to Portuguese as Portugal's software writes it (Microsoft's and Google's interfaces in Portugal the model), read part by part in the order people see them: sign-in and the frame, issues, boards, the inbox and its emails, the help desk, the problems, then the rest. No one from Portugal has read it. These are the choices a native speaker should settle.

Its open questions were settled by a model editor's pass on 18 November 2026: 73 settled, 1 left for a native speaker.

Left for a native speaker:

- **Quotation marks** are «…», with “…” inside, as Portugal's print and the EU's Portuguese style write them, while Microsoft's Portuguese style guide quotes a word on screen with “…”, as Apple's and Google's interfaces in Portugal mostly do. Both are Portugal's. Meanwhile the catalog keeps «…» (some 260 messages, `ui.quoted` among them): it is Portugal's own mark, and it keeps a quoted name apart from the straight quotes of a command someone types. Which do Portuguese readers expect on a page?

Needs the code to change:

- **The reader handed in as a name** still says *Você* in the portal's thread and in a query's "me" (`page.portal.you` in `page.portal.asked` and `page.portal.messageHead`, `page.track.you`, `page.track.youAsked`, `server.query.you`): one value stands as a verb's subject ("<t0>Você</t0> escreveu"), after a preposition ("atribuídos a você, anna") and alone ("Reporter: você"), where Portugal's Portuguese says no pronoun, *si* and *eu*. "Eu" can't stand in for it ("Eu escreveu"), so *Você*, the one form that fits every place, stays until the code says whether a value is the reader (a select, `{who, select, you {…} other {…}}`) and each place takes its own form. The suggestion card, whose sentences the catalog could turn, says "Aplicada por si." already.

## Korean

Korean was translated in one pass, from English, the code and [translating.md](translating.md), by a model working alone, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Its messages were checked by machine for what a catalog must keep (every placeholder, tag, select case and `#`, Korean's one plural category) and read in a browser through the sign-in page, the issues, an issue, the inbox and the profile.

Its open questions were settled by a model editor's pass on 18 November 2026: 105 settled, 3 left for a native speaker.

- **What a requester reads** (the help form, the portal, a request's page, the desk's emails) asks with “-어 주세요”, and the emails take the honorific for the reader's own acts (“본인이 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다”), where the team's pages ask with “-세요”. A company whose support writes 해요체 may want that for its customers; the catalog says “-어 주세요” meanwhile, as Korean support mostly writes it.
- **Needs code**: a rule run's whom-it-told list reads “Anna Schmidt, Ben Okafor 및 다른 3명에게 알렸습니다” (`rules.run.toldOthers`), since the server joins “3 others” into the list as its last item. Korean says “Anna Schmidt, Ben Okafor 외 3명에게”, with no 및, which needs the others said beside the list rather than in it.
- **Needs code**: the browser breaks Korean between any two syllables (CSS `word-break: normal`), so a word can split across lines (“선택하/세요”). Korean typesetting breaks at spaces: Ocean's `:lang(ko)` wants `word-break: keep-all` with `overflow-wrap: anywhere`, so a long unspaced word still fits a phone.

## Simplified Chinese

The whole catalog was translated in one pass by a model, working from English, the code, [translating.md](translating.md) and the other catalogs, then edited twice by models for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it. Everything below is open.

Its open questions were settled by a model editor's pass on 18 November 2026: 103 settled, 3 left for a native speaker.

Phrasing:

- **Spaces around values**: the catalog spaces a placeholder as the Latin name, id or number it usually holds (「由 {name} 添加」), so a person named in Chinese reads 「以 王芳 身份」. See below.
- **Intl's lists beside a Latin word**: Intl joins a list with 和, 或 and 、 and no space, 「通知了 Anna Schmidt和Vera Viewer。」, 「邮件链接登录、密码登录和Okta 登录」, where the catalog spaces a Latin word everywhere else. Chinese spaces 和 and 或 beside one, so `listParts` would need to do for Chinese what it does for Thai: a code change. Meanwhile the lists read as Intl writes them. Intl's dates, durations and relative times keep their own spacing, as Chinese software prints them.
- **Traditional Chinese readers**: a browser asking for zh-TW, zh-HK or zh-Hant gets this catalog, since a4a matches a language by its first part, and Chrome lists a bare zh after zh-TW. Readers in Taiwan and Hong Kong read software in Traditional characters or in English, and many take Simplified for the wrong language, so until a4a has a Traditional catalog, `matchLocale` should pass them to their next language, the bare zh after a Traditional tag included: a code change. Meanwhile they get Simplified.

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

Messages added with a desk's own provider:

- Nhà cung cấp riêng của một bàn: `problem.portal.providers.onlyAdmins` = “Chỉ quản trị viên quản lý các nhà cung cấp của máy chủ. Nhà cung cấp riêng do người quản lý của bàn đó quản lý.” — tách bạch vậy có tự nhiên không?

With the group's members hearing of its requests:

- Thành viên được nghe về các yêu cầu của nhóm (không có từ mới). Câu hỏi: bản sao có nên ghi “từ nhóm của bạn” trong chủ đề hoặc nội dung không?

With the customers' directory:

- Danh bạ khách hàng (không có từ mới). Câu hỏi: danh sách trong biểu mẫu chỉ nên hiện tên, hay cả miền làm gợi ý bên cạnh?

Messages added with the several groups:

- Nhiều nhóm mỗi người yêu cầu: `problem.helpdesk.severalGroups` = “Người yêu cầu thuộc nhiều nhóm khách hàng ở đây. Hãy nói yêu cầu này dành cho nhóm nào.” — tự nhiên chứ?
## Indonesian

Indonesian was translated in one pass, by a model working from English, the code and [translating.md](translating.md). A second and a third read, by models again, edited it for natural phrasing (the lists under "Edited for natural phrasing"); no native speaker has read it yet.

Its open questions were settled by a model editor's pass on 18 November 2026: 110 settled, 1 left for a native speaker.

- **The help desk's emails** are a company's voice to its customers, which a desk may want warmer or more formal: meanwhile they greet as Indonesia's online services write, "Halo {name}, permintaan Anda sudah kami terima." (`server.helpdesk.received`), and say *Anda*, with no *Yth.* or *Bapak/Ibu* (`server.helpdesk.*`, `server.portal.*`), since a4a knows neither who reads them nor how formal the company is.

## Thai

Thai was written in one pass by a writer who isn't a native speaker, as the others were; nobody who reads Thai daily has checked it. The Thai section of [translating.md](translating.md#thai) gives the reasons for each choice below.

Its open questions were settled by a model editor's pass on 18 November 2026: 111 settled, 1 left for a native speaker.

Typography and phrasing:

- **A space on each side of a value whose script a4a can't know.** A name, an id or a Latin word takes one, and a piece the page translates joins as a word, but a few values are either: the copy button's piece (`common.copyButton.copied`, `common.copyButton.couldnTCopySelectIt`), so “คัดลอก {what} แล้ว” reads “คัดลอก URL แล้ว” and also “คัดลอก โทเค็น แล้ว”, and a requester's name after คุณ (`server.helpdesk.received`), “คุณ Ada” and also “คุณ สมชาย”. Meanwhile the catalog spaces them, which is right for a Latin value and only a pause for a Thai one. Joining them by script, as `listParts` does for lists, needs the code to say which a value is.

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
