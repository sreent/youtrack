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

## Brazilian Portuguese

`pt.json` was written in one pass, all 5,467 messages, by a model working from English, the code and the section in [translating.md](translating.md), with German's, French's and Japanese's catalogs beside it. Nobody has read it a second time, and no native speaker has read it at all.

Terms:

- **Issue is *item***, as Jira's Brazilian Portuguese says it ("Criar item", "Tipo de item"). *Tarefa* would collide with the Task type, *chamado* and *tíquete* read as a support desk's, and *issue* is what many Brazilian teams say, in English. Is *item* what readers expect in a tracker that isn't Jira?
- **Zero takes the singular**: CLDR's and gettext's pt_BR rule put 0 in `one`, so a count says "0 item", "0 dia de atraso", as the norm says "zero hora". Everyday writing often says "0 itens". The issue list's count line puts the count last ("Itens no projeto SPR, não resolvidos: 4", as Spanish and French do), so it never chooses; elsewhere, should the catalog add `=0` branches?
- **The help desk is the *central de atendimento***: plain to the customers who read its emails, but long in a heading. *Help desk*, *atendimento* or *suporte* are the alternatives; Jira Service Management's Brazilian Portuguese says *projeto de serviço* and *central de ajuda*.
- **Subscribe is *assinar*** (Jira's "Assinaturas"), where GitHub and YouTube say *inscrever-se*; and **watch is *acompanhar***, where Jira says *observar*.
- **An issue's summary is its *título***, not Jira's *Resumo*, since the assistant writes a *resumo* of an issue and the daily digest is a *resumo diário*.
- **Reporter**: *relatar*, "Relatado por", "quem relatou". Jira's field is *Relator*; many teams say *reportar*.
- **Roles**: *administrador*, *gerente*, *membro*, *leitor*, *convidado*, and a sentence says "tem o papel membro", never "é membro". *Leitor* and *convidado* are masculine words for anyone; "Somente leitura" and "Acesso de convidado" would be neutral, as French chose.
- **Sign in is *entrar*, and a person's handle is their *login***, so "Entre com seu login" and "Login do a4a" sit side by side.
- **Link is *vínculo* and *vincular*** (Jira's), for issues and for chat accounts alike; **merge is *mesclar*** (GitHub's and Microsoft's Brazilian Portuguese), where developers often say *fazer merge*; **secret is *segredo***; **an app is *app***, masculine, not *aplicativo*.
- **Earned value uses the abbreviations of the PMBOK Guide in Brazilian Portuguese**: VA, VP, CR, IDC, IDP, VC, VPR, ONT, ENT, EPT, VNT, formulas included ("ONT ÷ IDC"). Many Brazilian project managers say EV, PV, CPI and SPI. Is VPR right for schedule variance?
- **Timesheet is *planilha de horas***; Brazilian companies also say *apontamento de horas*, or *timesheet*.
- **An HTTP request is a *requisição***, kept apart from a help desk's *solicitação*.
- **"Your address"** in the help desk's limits (`problem.helpdesk.tooManyFromAddress` and its siblings) is *seu endereço de rede*, so a customer doesn't read it as their email address.

Phrasing:

- **A rule's sentence** (`rules.words.whenSentence`, `scheduleSentence`) reads "Quando um item é criado, se corresponder a Type: Bug, então aplicar Assignee anna." The trigger pieces are shared with the webhooks' events, so they're in the present ("um item é criado"); a person would write "Quando um item for criado, …, aplicar …". Does *então* earn its place?
- **The ledger's badges** are lower-case nouns ("exclusão de item", "registro de trabalho"), as English's are lower case.
- **Days away** (`away.daysAway.addedAway`, `changedAway`, `removedWhoNoLongerAway`, `away.words.away`): a date can be "sex., 4 de dez." or "a manhã de sex., 4 de dez.", so sentences take it after *para* or in brackets: "Ausência adicionada para a manhã de sex., 4 de dez.: …".
- **Asking an administrator**: the sign-in pages say "Peça a quem administra o a4a", neutral; the rest says "Peça a um administrador". Should one win?
- **Gender left unguessed costs length**: "a pessoa solicitante", "a pessoa responsável", "quem o relatou". Check the badges and narrow columns at 390px, and say where a shorter word would do.
- **The navigation's groups** (`app.shell.*`): Trabalho, Planejar → Plano, Decidir, Construir (Projects, Rules, Fields, Import) and Supervisionar (Activity, Agents and tokens, Webhooks, Integrations, Chat, Administration).
- **Date formats in problems** are written AAAA-MM-DD, as Brazil describes one; what a person types is still 2026-11-20, and the query language's keywords (today, tomorrow) stay English.
- **The chat bot's help** (`server.chat.help`) keeps its commands and their straight quotes in English (`subscribe "My bugs"`), so they copy as typed.
- **Imports' statuses** agree with *importação* (concluída, pronta, parada), and a rule is *ela* while a script is *ele*: "Ela roda um script".

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard is *quadro branco***, never shortened, since *quadro* alone is the agile board (`app.shell.whiteboards`, `page.whiteboards.*`). It makes the ledger's badges long: "alteração de quadro branco" (`activity.ledgerEntry.changesAWhiteboard`). Its pieces are *nota*, *texto*, *cartão* (as the board's cards), *seção* and *seta*, and an arrow's label is a *rótulo*.
- **The outline is *Estrutura*** (`page.whiteboard.outline`, `whiteboards.outline.title`), as Google Docs says "estrutura do documento", so the keys' help says "na ordem da estrutura" (`page.whiteboard.keys`). *Sumário* or *Lista* are the alternatives.
- `page.whiteboard.canvas` is "A tela", a heading only screen readers hear; *tela* is also a screen. *Área de desenho* is the alternative.
- **A note's tones** agree with *nota* (`whiteboards.tone.*`, `whiteboards.kind.note`): Simples, Ideia, Combinada, Pergunta, Problema, Em espera. *Combinada* is the Brazilian "combinado", but could read as "combined"; *Acordada* or *Decidida* are the alternatives, and *Estacionada*, from the facilitators' "estacionamento", for parked.
- **Convert to issues** is "Criar itens" on the buttons (`page.whiteboard.convert`, `whiteboards.convertDialog.title`, `whiteboards.convertDialog.go`) and *virar item* in sentences ("Cada nota vira um item", `whiteboards.convertDialog.about`, `problem.whiteboards.notANote`). *Converter em itens* is the alternative.
- **Choosing elements is *escolher*** ("2 escolhidos", `page.whiteboard.said.chosen`, `page.whiteboard.keys`), as the issue list says; on a canvas, Brazilian software mostly says *selecionar*.
- **The toolbar's buttons have no article** ("Adicionar nota", `page.whiteboard.addNote`), and the dialogs they open keep English's ("Adicionar uma nota", `whiteboards.noteDialog.addTitle`), as the catalog's buttons and headings do elsewhere. Do they read well side by side?
- `activity.ledgerEntry.whiteboardConverted` puts its counts after a colon ("criou a partir do quadro branco X: nenhum item e 2 vínculos"), since "criou nenhum item" isn't Portuguese.
- **A Slack thread is a *conversa*** (`server.chat.issue.thread`, `page.issue.source.replies`), as Slack's Brazilian Portuguese names threads, as far as the translator recalls. Many teams say "thread", and *conversa* is also what someone has with the assistant.
- `issues.watching.wroteTheMessage` is "escreveu a mensagem de origem", and the card beside it, `page.issue.source.title`, is "Origem".

## Korean

Korean was translated in one pass, from English, the code and [translating.md](translating.md), by a model working alone: no second reader has gone over it, and no native speaker has read it. Its 5,467 messages were checked by machine for what a catalog must keep (every placeholder, tag, select case and `#`, Korean's one plural category) and read in a browser through the sign-in page, the issues, an issue, the inbox and the profile.

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
- **Particles after values** are written both ways everywhere, 을(를), 이(가), 은(는), (으)로, as Korean software writes them, even where the value is a4a's own words and its ending is known: the sign-in page says "a4a 로그인 ID을(를) 사용하세요." Is the one way worth that line, or should a4a's own fixed values get their right particle? The subject's is written 이(가), not (이)가.
- **"You"** is 나 in notification titles ("Ada이(가) 나에게 할당했습니다", "나를 멘션했습니다"), as a list's filter says 나에게 할당됨; Facebook's and Slack's Korean say 회원님. Does 나 read naturally in a title addressed to the reader?
- **The ledger and an issue's history** draw the actor's name, then a verb phrase in the polite past with no particle: "**Ada** BACK-12을(를) 변경했습니다". Would the terse 개조식 ("변경함") read better in a log?
- **A rule's sentence** lists its actions as nouns joined by Korean's list ("Assignee anna 적용, “확인하세요” 댓글 작성 및 웹훅 호출."). Do verbs read better?
- **A webhook's events** are nouns ("이슈 생성"), joined into "{join} 시" with " 또는 "; the same nouns label the form's checkboxes.
- **The board's drag announcements** (`board.board.dropItTo*`) are long sentences for a screen reader: "여기에 놓으면 BACK-1을(를) Done 열(Fixed)로 옮기고 Anna에게 할당합니다".
- **"Did you mean"** in a problem is "혹시 “{guess}”인가요?"; on the issue list's query bar it is "이런 뜻인가요? {el}".
- `server.notify.title.andOthers` is "{people} 외 여러 명", which then takes 이(가): "Anna, Ben 외 여러 명이(가) 댓글을 남겼습니다".
- A rule run's whom-it-told list ends "및 다른 3명" (`rules.run.toldOthers`), since Korean's list puts 및 before the last item.

Typography and layout:

- **Line breaks**: the browser breaks Korean between any two syllables (CSS `word-break: normal`), so a word can split across lines ("선택하/세요"). Korean typesetting breaks at spaces (`word-break: keep-all`), which would be Ocean's to set for `:lang(ko)`; it isn't set, since a long unspaced word could then push past a phone's width.
- **Fonts**: the container's shots use WenQuanYi Zen Hei. Judge spacing with Noto Sans KR, Apple SD Gothic Neo or Malgun Gothic.

Messages added in wave 4 (whiteboards, writing help, issues from chat, Asana and ClickUp):

- **A whiteboard's note** is 메모 (`page.whiteboard.addNote`, `whiteboards.kind.note`), as the catalog says a dashboard's note, and short on the toolbar. Whiteboard apps' Korean says 스티커 메모 or 스티키 노트. Which do Korean teams expect?
- **Undo and redo** on a whiteboard are 실행 취소 and 다시 실행 (`page.whiteboard.undo`, `redo`, `said.undid`, `said.redid`), as editors say them; undoing an agent's change or an import stays 되돌리기. Does "이동을 실행 취소했습니다" read naturally, or is "이동을 되돌렸습니다" better?
- **The outline** is 개요 (`page.whiteboard.outline`, `whiteboards.outline.title`), as Google Docs' Korean says a document's; a section is 섹션, and an arrow's label 레이블 (`whiteboards.textDialog.label`). 아웃라인 and 라벨 are the alternatives.
- **Reading a whiteboard** is 볼 수 있다 (`page.whiteboards.about`, `noneAbout`, `projectHelp`, `page.whiteboard.readOnly`), where the access messages say a project is 읽다. One verb throughout?
- **Converting** is 이슈로 만들기 (`page.whiteboard.convert`, `whiteboards.convertDialog.title`). A preview's lines are in the present (`whiteboards.convertDialog.wouldMake` "이슈가 됩니다: …", `wouldLink` "링크됩니다: …") beside the result's past (`made` "BACK-12이(가) 되었습니다: …"). Clear as a preview?
- **Zero**: `activity.ledgerEntry.whiteboardConverted` and `page.whiteboard.said.converted` say "링크 0개" where English says "no links", since their plurals keep `other` alone. Should they keep English's `=0`?
- **A chat thread's replies** are 답글 (`page.issue.source.replies`, `server.chat.issue.withReplies`), as Slack's Korean says them, kept apart from the help desk's 답장.
- **The bot names itself** in `server.chat.issue.notInChannel` and `onlyChannels` ("a4a가 #eng에 참여하고 있지 않습니다"), where English says "I'm not in" and the bot's other lines leave the subject out, so the reader doesn't take it for themselves.
- `issues.watching.commented` and `wroteTheMessage` are 댓글 작성자 and 원본 메시지 작성자, nouns beside 보고자 and 담당자 under a watcher's name.
- `page.whiteboard.you` is "{name}(나)" in the list of who's looking (`page.whiteboard.lookingNow`, 지금 보는 사람). Natural?

## Simplified Chinese

The whole catalog was translated in one pass by a model, working from English, the code, [translating.md](translating.md) and the other catalogs, and has had no second read. Everything below is open.

Terms:

- **你 and 您**: 你 everywhere, and 您 on the help desk's pages for requesters (the form, the portal, a request's page), in their emails, and on the unsubscribe page, which team members reach from their emails too. Is 您 right there? And do problems' fixes, which have no 请 where English has no "please" (「一分钟后重试。」), read too curt?
- **问题 for issue** is Jira's. 事项 and 工作项 (Feishu's, PingCode's) or GitHub's 议题 are the alternatives; 问题 also means "problem", so no problem says it.
- **经办人 for assignee** is Jira's, and keeps 负责人 for a project's lead. Many Chinese tools say 负责人 or 处理人 for the assignee.
- **冲刺 for sprint** is Jira's. Chinese agile teams often say 迭代.
- **智能体 for agent**, as Chinese AI products say it now; 代理 reads as a proxy.
- **分诊 for triage**, borrowed from medicine as English borrowed it. 预审 or 分类 are the alternatives.
- **经理 for the manager role** reads as a job title. 管理者 sits too close to 管理员 (administrator); 项目经理 is longer.
- **休假 for days away**, sick days included. 请假 or 不在岗 are the alternatives.
- **The plan's words** are the project management ones Chinese PMP courses teach: 挣值, 成本绩效指数, 资源平衡, 浮动时间, 基线, 关键路径. What-if is 模拟, and its button 「假如……」.
- **令牌 for token**, 密钥 for a webhook's or an app's secret, 投递 for a delivery, 两步验证 for two-factor sign-in (双重身份验证 and 双因素认证 are the alternatives).
- **The navigation's groups**: 工作, 决策, 构建, 总览 (`app.shell.work`, `decide`, `build`, `oversee`). Natural?
- **Age** in the reports (`reports.moreReports.*`) is 时长; **velocity** is 速度.

Phrasing:

- **Spaces around values**: the catalog spaces a placeholder as the Latin name, id or number it usually holds (「由 {name} 创建」), so a person named in Chinese reads 「以 王芳 身份」. See below.
- **Intl's own spacing**: dates, durations and lists come from Intl unspaced (「2.5小时」, 「Anna Schmidt和Vera Viewer」) beside the catalog's 「3 个问题」. Acceptable side by side?
- **Free text moved to the end**, after 错误：, 原因： or 回复： (`problem.apps.catalogUnreadable`, `problem.workflow.ruleRefusesInItsWords`, `problem.imports.source.answeredSaying`). Does it read naturally?
- **The desk's name in quotes**: `server.helpdesk.whyAnswer`, `whyLink` and `server.portal.lead` quote it, 「向“BACK 的服务台”寻求了帮助」, so the plain 「服务台」 reads too.
- **A rule's sentence**: 「当创建问题时，如果它匹配 Type: Bug，则应用 Assignee anna。」 Conditions on linked issues say 「与它存在“{v}”关系的问题」, which is heavy (`rules.words.*Linked*`, `rules.preview.actsOn`).
- **The board's drop lines** (`board.board.dropItTo*`): 「放下以将 BACK-1 移到 Done（作为 Fixed），并……」, read by a screen reader as a card moves.
- **Examples for the assistant** are Chinese (「把这些移到 Review，并指派给 anna」, 「本周无人处理的严重 Bug」); examples of the query and command languages stay as written.
- **The issue list's count line** says 「4 个问题：项目 SPR、未解决」, joining the query's parts with 、.
- **Traditional Chinese readers**: a browser asking for zh-TW or zh-HK gets this catalog, since a4a matches a language by its first part, and most such browsers list zh as well. Is Simplified better than English for them, or should a4a match only zh, zh-CN and zh-Hans until it has a Traditional catalog?

## Vietnamese

Translated whole by one model, from English, the code and [translating.md](translating.md), with no second read yet and no native speaker.

Terms:

- **An issue is "vấn đề"**, Redmine's word, and the brief's. It is also everyday Vietnamese for "a problem", so what went wrong is always "lỗi". Would teams rather read "issue" as it is, or "công việc"?
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
- **The ledger's bylines** say "với tư cách {name}" for "as {name}", "thay cho {name}" for "for {name}", and "với danh nghĩa riêng" for "as itself". `activity.ledgerEntry.made` is "đã để {v} {v2}" ("đã để BACK chỉ hiển thị với thành viên").
- **Badges kept short for a phone**: `activity.ledgerEntry.changesWhoIsCopied` "đổi người được CC", `helpdesk.groups.cantBeGiven` "{name}: tạm không nhận yêu cầu", `helpdesk.requestCard.firstResponseDueIn` "phản hồi đầu tiên: còn {span}". Clear enough?
- **The issue list's count line** puts the count first, as English does ("4 vấn đề trong dự án SPR, chưa giải quyết"), and its sort follows a comma (`server.query.sortedBy`, ", sắp xếp theo {sorts}").
- **The parser's lines**: "Unexpected …" is "Không mong đợi “x” ở đây.", "Expected …" is "Cần … sau …", and "Unknown X" is "X không tồn tại".
- `rules.preview.actsScheduled`: does "chạy cho từng vấn đề" against "tác động lên từng vấn đề" carry English's "for each of them" against "on each of them"?
- **"Your address"** in the help desk's limits is "địa chỉ IP của bạn", since an email address sits beside it.
- **Examples**: plain words for the assistant and the chat bot are Vietnamese ("comment BACK-12 Ổn rồi", "chuyển các vấn đề này sang review và giao cho anna"), and so are example rule names ("Báo tin lỗi nghiêm trọng"); states, fields and the query and command languages stay as typed ("Won't fix", "State Fixed").
- `rules.ruleForm.everyWeekday`, "mỗi ngày làm việc", may read as the plan's working days rather than Monday to Friday.
- **"This instance"** is "Máy chủ này" as a heading (`page.admin.thisInstance`) and "a4a này" in a sentence.
- **Pronouns**: a person is "người đó" or "họ", and a thing is named again rather than "nó". Some sentences read heavy for it ("lịch sử ghi rằng cân bằng nguồn lực đã dời công việc đó").

## Indonesian

Indonesian came later than the others, in one pass, by a model working from English, the code and [translating.md](translating.md): nobody has read it again yet, native speaker or not.

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
- **The navigation's groups**: *Pekerjaan*, *Rencana*, *Keputusan*, *Penyiapan* (Build: projects, rules, fields, import) and *Pemantauan* (Oversee). *Pemantauan* sits beside *pantau*, which is "watch" for an issue's watchers.
- **A guard rule** is *aturan penjaga*, a state machine's **moves** are *langkah*, and **triage** is *triase*, the hospital's word.

Phrasing:

- **Undo** is *Batalkan*, and the history says *membatalkan perubahan* (`issues.issueHistory.undo*`, `activity.ledgerEntry.undidAnAgentSChange`), close to *Batal* for Cancel. Google's Indonesian says *Urungkan*.
- **The history and the ledger carry no tense word**: "Ada mengubah status", not "telah mengubah". Does that read as done?
- **A ledger's badges** are active phrases, as English's are (`activity.ledgerEntry.badge*`): "berkomentar", "mencatat kerja", "memanggil keluar". The last is stiff for a webhook's call.
- **A link's own words are data**: in a rule's sentence, "semua isu yang {v} cocok dengan {query}" takes a link type's English, "semua isu yang depends on cocok dengan …" (`rules.words.allLinkedMatchQuery` and its siblings).
- `rules.words.tellNobody`, "jangan beri tahu siapa pun “…”", for a rule that tells no one, reads as an order not to tell.
- `server.chat.subscribed`: "{name} membuat saluran ini berlangganan" for someone subscribing a channel.
- **The help desk's emails** say *Anda*, with no *Yth.*, *Bapak/Ibu* or greeting, as English has none (`server.helpdesk.*`, `server.portal.*`). Is that courteous enough for a company writing to its customers?
- **Your address** in the help desk's limits is *alamat IP Anda* (`problem.helpdesk.tooManyFromAddress` and its siblings), since *alamat* alone could be an email.
- `page.profile.you` is *Tentang Anda*, a heading, and `notifications.emailSettings.youHaveNoEmailAddress` points to it.
- **The issue list's count** joins a search's parts with a comma, as Intl's narrow list does in Indonesian: "4 isu di proyek SPR, belum selesai". *dan* would read more smoothly between two.
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
- **Lists inside a GitHub App's problems**: the server joins installations and names with ", " (「acme (123), anna (456)」), where Japanese and Chinese would use 「、」.
- **Whether a value is Chinese**: Chinese spaces a value written in Latin letters or digits and not one written in Chinese, and a catalog can't tell which a value is, so it spaces names, ids and numbers. A person or a project named in Chinese gets spaces it doesn't need: 「以 王芳 身份」.
- **Korean's particles after a value**: a4a can't tell how a name, a state or an id ends, so Korean writes each particle both ways (을(를), 이(가)). A value passed with whether it ends in a consonant would let Korean choose the one it needs.
- **A span of days away** is joined in code with an English " to " (`whenWords` in `apps/web/src/features/away/words.ts`), so every language reads "2 to 6 dez.". It needs a message of its own.
- **Portuguese's contractions with a value**: a product's or a desk's name takes an article in Portuguese ("do GitHub", "na central de atendimento de X"). The catalog writes the article into the message, so it assumes a masculine product (identity providers, trackers, chat platforms) and leaves the desk's name without one (`server.helpdesk.deskOf`, `server.portal.deskOf`).
- **An email's `lang`**: mail is composed with `<html lang="en">` whatever its language (`packages/server/src/mail/compose.ts`), so a screen reader reads a Portuguese email with an English voice.
- **Indonesian times**: Intl writes them with a point, "14.05", as Indonesia does, and the issue's history shows that; but a time earlier today is written by the page's code as "14:05" (`whenRead` in the web's `format.ts`), so a page can show both.
