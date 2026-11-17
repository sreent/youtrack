# Questions for native speakers

Each catalog was translated, then read again whole by a reviewer who hadn't written it, working from English, the code and [translating.md](translating.md). That reviewer was a model, not a native speaker. The second reads changed 1,371 messages: 502 in German, 316 in Spanish, 299 in French and 254 in Japanese. The same reviewers then translated the 909 messages added since (the server's problems, `problem.*`, and the messages that replaced English the catalogs couldn't say), and those have had no second read. The last 103 (what the server words for a page: a rule's preview and runs, a commit's note, why a chat subscription stopped) were written in every language by the developers who added them, then read by the reviewers.

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
- **A commit's author** is "Autor" (`vcs.why.noEmail`, `sharedEmail`, `sharedLogin`, `twoPeople`), as git says. "die Person, die ihn verfasst hat" doesn't assume a gender, but it's long inside these pieces.
- **Telling people**: a rule's preview and its runs say "informieren" (`rules.preview.shown`, `rules.run.told`, `toldNobody`), and a rule's sentence says "benachrichtigen". One word throughout?
- `workflow.scriptRun.posts`: "Es würde einen Kommentar schreiben". "posten" and "anlegen" are the alternatives.

From the read of wave 4's messages (D50 to D55):

- `server.access.issueYouCantSee` and `articleYouCantSee` ("ein Vorgang, den Sie nicht sehen können") stand in for an id inside someone's text, so their case can't be known: the nominative reads wrong after "Siehe" or a preposition.
- **Reading as a GitHub App**: "nicht mehr als App lesen" (`stopReadingAsTheApp` and its siblings) can read as "no more than". "Lesen als App beenden" is the alternative. "installiert auf dem Repository" may be better as "im Repository".
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
- **The issue list's count line** puts the count last ("Incidencias en el proyecto BACK, sin resolver: 4"), since the explanation's pieces are plural and wouldn't agree after "1 incidencia". It reads differently from English's "4 issues …".
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
- `problem.vcs.githubApp.answered` and its siblings: "{host} respondió {status}". "respondió con {status}" reads more naturally.
- "leer como GitHub App", in about 15 messages: "como" in the sense of "in the capacity of".
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
- **The issue list's count line** shows two colons when its explanation starts with one: 「5件の課題：プロジェクト：BACK、未解決」. Brackets would read 「5件の課題（プロジェクト：BACK、未解決）」.
- `rules.preview.actsScheduled`: does について against に対して carry English's "for each of them" (issues it reaches) against "on each of them"?
- `rules.preview.outside` and `rules.run.leftOutside`: "leaves it alone" is 実行されません and 実行しませんでした. 手を付けません is more colloquial.
- `problem.rule.wouldDoNothing` and `wouldRefuse` end on the quoted refusal (「…：「{refusal}」」) with no 。, since the refusal brings its own punctuation. Acceptable?
- `builds.note.*` have no 。, as English has no full stop, since they sit as notes beside a status.

From the read of wave 4's messages (D50 to D55):

- `articles.visibleTo.limitedNow` and its issue twin: `{audience}` can be 「関係者のみ」, which gives 「…関係者のみに限定しました。関係者は常に…」. This is the 関係者 question above, now for articles too.
- `articles.articleTree.limited` is 限定公開. Does it read as "limited to some people", or as YouTube's "unlisted"? 閲覧制限 is the alternative.
- 「GitHub Appとして読み取る」 (`page.integrations.readAsAGithubApp` and its family): would 「GitHub Appとしてアクセス」 read more naturally?
- 「異動や退職」 for a person who leaves (`page.integrations.aGithubIntegrationCanRead`, `aPersonSTokenStopsWorking`).
- The board's drop text puts the state between the column and の (「Done（Fixedとして）のBACK-19の上に移動」), which may read awkwardly to a screen reader user.

From the read of D56's and D57's messages (customer groups, and CCs on requests):

- `helpdesk.requestCcs.nobody` and `page.portal.nobodyCopied`, "CCはいません。…", treat CC as people. 「CCに追加された人はいません。」 is more explicit, but repeats in the longer message.
- `issues.issueHistory.publicSomeoneCopiedWroteIt`, 「公開：CCの人が記入」, is conversational; CC先 or CCに追加された人 are the alternatives.
- **Kept from the group** (`helpdesk.requestCard.keepFromGroup`, `page.portal.keepPrivate`, `keepFromMyGroup`, `ui.changes.keptFromGroup`) is built on 「{group}に非公開」. 「{group}には非公開にする」 may flow better.
- **SLA time**: 計算 (as the catalog says 営業時間で計算) or 計測, as support tools often say?
- `helpdesk.groups.cantBeGiven`, 「現在は割り当てられません」: 「割り当て不可」 is shorter, but the catalog never uses 不可.
- `page.unsubscribe.what`'s `cc` case, 「CCとして受け取っている、このリクエストに関するメール。」: the comma between the two modifiers may read stiffly.
- `helpdesk.groups.sharingNone`, 「各自が自分のリクエストだけを見る」, where its sibling options say 閲覧できる.
- `server.helpdesk.copiedOnIt`: a company writing to a customer might say 「CCに追加された方（チームからの返信もお送りします）：」.

## Thai

Thai was written in one pass by a writer who isn't a native speaker, as the others were; nobody who reads Thai daily has checked it. docs/translating.md's Thai section gives the reasons for each choice below.

Terms:

- **An issue is อิชชู**, the word Thai teams say for Jira's and YouTrack's issues, in the Royal Institute's spelling. ทิกเก็ต (French's "ticket") reads as a support ticket, ปัญหา (Redmine's) makes "create issue" สร้างปัญหา and clashes with a4a's problems, and งาน is taken by work logged. Would a team rather read "Issue" in Latin letters, as many Thai developers write it?
- **A project is โปรเจกต์**, as teams say it; โครงการ is the formal word, and Microsoft's.
- **A request is คำขอ**, and **a requester ผู้ร้องขอ**. คำขอ is also an HTTP request in the API's problems (`problem.attachments.noBody`, `problem.tooLarge`): is that confusing?
- **Resolve is ปิด** ("close"), resolved ปิดแล้ว, since แก้ไข is every Thai app's Edit. ปิด also closes a pull request and a dialog.
- **Subscribe is สมัครรับ** and **watch ติดตาม**, though YouTube's Thai says ติดตาม for subscribe.
- **The inbox is กล่องจดหมาย**, Gmail's word, for an inbox of notifications.
- **Days away are วันที่ไม่อยู่**, not วันลา (leave), since an absence may be a conference; is it natural?
- **A login is ชื่อผู้ใช้** (a username); **undo is เลิกทำ**, Microsoft's; **dismissing a suggestion is ละเว้น**.
- **Loanwords in Thai letters**: คอมมิต, แบรนช์, เมิร์จ, บิลด์, เว็บฮุก, สปรินต์, แบ็กล็อก, เฮลป์เดสก์, and the long พูลรีเควสต์. Thai developers often write these in Latin letters instead.
- **The navigation's groups**: งาน (Work), แผนงาน (Plan), สร้าง (Build), กำกับดูแล (Oversee), ตัดสินใจ (Decide).
- **Classifiers**: รายการ counts issues, requests and most things (“อิชชู 4 รายการ”); bots are “บอต # ตัว”; a count of zero says “อิชชู 0 รายการ” rather than ไม่มีอิชชู.

Typography and phrasing:

- **No full stop**: sentences, a problem and its fix included, are separated by a space. Do the longer problems read as two sentences, or run on?
- **Questions end in ไหม?** (“ลบ {name} ไหม?”). Thai software also writes หรือไม่, or no question mark.
- **Gregorian years, unmarked**: “17 พ.ย. 2026”, with no ค.ศ. A Thai reader who expects the Buddhist era sees 2026; should a4a mark the era, or offer the Buddhist one by choice?
- **Lists**: a4a departs from Intl's Thai list where an item is Latin: “Anna Schmidt และ Vera Viewer” for Intl's “Anna SchmidtและVera Viewer”, and a comma between Latin names where Intl puts a bare space. Is that how a Thai writer would set it?
- **Units** take Intl's short width (“1.5 ชม.”, “0 นาที”) for the space before the unit.
- **A space on each side of a value**, as names and ids need. Where a value is itself Thai (a piece the page translates, like the sign-in form's name) the space reads as a pause mid-phrase; the sign-in page's were found in its shots and fixed. Others are left where the value may be Thai or Latin: the copy button's “คัดลอก {what} แล้ว” says “คัดลอก โทเค็น แล้ว” as well as “คัดลอก URL แล้ว”, and a role, a recipient or a `{whenWords}` may be either. Should a4a join such values by script, as `listParts` does for lists?
- **The chat bot speaks without a pronoun** (“ยังไม่รู้ว่าคุณเป็นใครใน a4a”), as Thai drops it; does it read as a bot or as a person?
- **Requesters are named “คุณ {name}”**, with a space since a name may be Latin, and no เรียน: “คุณ {name} เราได้รับคำขอของคุณแล้ว”.
- **The passive ถูก** is avoided in events (มีการ…), but stays where it is neutral: ถูกระงับ (banned), ถูกกล่าวถึง (mentioned).
- **Free text moved to the end**, after ข้อผิดพลาด:, เหตุผล: or คำตอบ: (`problem.apps.catalogUnreadable`, `problem.workflow.ruleRefusesInItsWords`, `problem.imports.source.answeredSaying`). Natural?
- **The font**: IBM Plex Sans Thai is loopless. For long text some readers find a looped face (Plex Sans Thai Looped) easier; Ocean bundles the loopless one only.

## What a catalog can't say yet

These need the code to change, not a catalog:

- **French can't elide before a name**: "de {name}" prints "de Ada", not "d’Ada", since the name is a value.
- **Spanish's "y" before an "i" sound**: `problem.command.valueOfFields` joins two field names with "y", which should be "e" when the second starts with an "i" sound. Field names are data.
- **A field's or state's gender**: a message that agrees with `{field}`, `{state}` or `{close}` assumes one.
- **A rule run's changes** (`rules.run.changed`, `alsoChanged`) are fields and values the server joins with English punctuation: "State: Open → Fixed; Priority: — → High".
- **Notes kept before a4a kept their words**: a commit's command note, a rule's run, a build's note and a chat subscription's end, written before migrations 0028 and 0029, stay in the English they were kept in. New ones are said in each reader's language.
- **Lists inside a GitHub App's problems**: the server joins installations and names with ", " (「acme (123), anna (456)」), where Japanese would use 「、」.
