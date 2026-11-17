# Questions for native speakers

Each catalog was translated, then read again whole by a reviewer who hadn't written it, working from English, the code and [translating.md](translating.md). That reviewer was a model, not a native speaker. The second reads changed 1,371 messages: 502 in German, 316 in Spanish, 299 in French and 254 in Japanese. The same reviewers then translated the 909 messages added since (the server's problems, `problem.*`, and the messages that replaced English the catalogs couldn't say), and those have had no second read.

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
- `imports.mappingTable.importedWithoutIt`: "Imported without it" is "Teilweise importiert".
- `helpdesk.sla.atRiskBefore2`: "At risk before" is "Vorwarnzeit".
- `page.dashboard.aQueryIWrite` is "Eigene Abfrage", and `page.reports.datesIChoose` is "Eigener Zeitraum".
- `assistant.talk.aConversationWithAssistant`: "Eine Unterhaltung mit assistant" keeps the agent's name as it is. If German reads it as a word, it's "mit dem Assistenten".
- `page.profile.yourBrowsersLanguage` and its siblings `theServerS` and `useYourBrowserS`: "Die Ihres Browsers: {name}". `e2e/german.spec.ts` looks for these words, so change the spec with them.
- **The query parser's "Unexpected …"** is "Unerwartet: „x“". A compiler would say "Unerwartetes Zeichen „x“".
- **"Status" as a plural** ("Mögliche Status", "zwischen zwei Status") is correct, but some readers take it for a singular.
- `problem.rule.writeScript`: "Schreiben Sie in JavaScript, was es tut." "es" is the script; "was sie tut" would be the rule.
- `problem.agents.stop.issueGone` and `otherEndGone`: "ist nicht mehr da". "existiert nicht mehr" is more formal.
- `loadingLine.deskMail`: "Die Post des Helpdesks wird geladen…". "Die E-Mails des Helpdesks" may be plainer.
- `problem.ai.error`, `problem.apps.packageProblem` and `problem.attachments.tooLarge` add a lead-in that English doesn't have ("Beim KI-Dienst ist ein Fehler aufgetreten: {error}"), since what follows is another service's English. Keep them?

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

## Japanese

Terms:

- **The navigation's groups**: `app.shell.oversee` is 監督. It holds Activity, Agents and tokens, Webhooks, Integrations, Chat and Administration, and 監督 may read as a supervisor; 運用 is the alternative. `app.shell.build` is 構築, for Projects, Rules, Fields and Import. Is it natural?
- **Earned value** is アーンドバリュー in headings and 出来高 for amounts (`plan.costs.earned`).
- **Field types**: enum is 選択リスト, string is 1行テキスト, and owned is 担当者付きリスト (`problem.fields.onlyEnumBecomesOwned`, `problem.ci.notABuildField`).
- **A work item** is 作業記録. The import pages say 作業項目 for other trackers' work items.
- **A second factor** is 2つ目の要素 (`problem.twoFactor.noPassword`).

Phrasing:

- `issues.visibleTo.nobodyElse` is 関係者のみ. Does 関係者 fit the people who always see an issue: its reporter and assignee, the project's managers, administrators?
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

## What a catalog can't say yet

These need the code to change, not a catalog:

- **French can't elide before a name**: "de {name}" prints "de Ada", not "d’Ada", since the name is a value.
- **Spanish's "y" before an "i" sound**: `problem.command.valueOfFields` joins two field names with "y", which should be "e" when the second starts with an "i" sound. Field names are data.
- **A field's or state's gender**: a message that agrees with `{field}`, `{state}` or `{close}` assumes one.
- **Notes kept before a4a kept their words**: a commit's command note, a rule's run, a build's note and a chat subscription's end, written before migrations 0028 and 0029, stay in the English they were kept in. New ones are said in each reader's language.
