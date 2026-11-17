import type { ArticleDetail } from '@a4a/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { put } from '../../api/client';
import { UserWho } from '../../components/Who';
import { errorText, Said } from '../common/bits';
import { audience, limitOf, LimitPicker, type Limit } from '../issues/VisibleTo';
import { articleKeys } from './api';
import { listNodes, t, tr } from '../../i18n';

/**
 * Who sees an article, on its page (D51): limited itself, or under limited articles, whose limits
 * it takes too. Whoever may change the article may limit it, or lift its own limit; one it sits
 * under is changed on that article's page. The same idea, and the same picker, as an issue's.
 */
export function ArticleVisibleTo({ a, canWrite }: { a: ArticleDetail; canWrite: boolean }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Limit | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const key = a.project.key;
  const always = t('articles.visibleTo.always', { key });
  const save = useMutation({
    mutationFn: (visibleTo: Limit | null) => put<ArticleDetail>(`/articles/${a.id}/visibility`, { visibleTo }),
    onSuccess: (next) => {
      qc.setQueryData(articleKeys.one(a.id), next);
      void qc.invalidateQueries({ queryKey: articleKeys.all });
      setEditing(null);
      setSaid({
        text: next.visibleTo
          ? t('articles.visibleTo.limitedNow', { audience: audience(next.visibleTo) })
          : t('articles.visibleTo.openNow', { above: next.limitedAbove.length ? 'yes' : 'no', key }),
      });
    },
    onError: (e) => setSaid({ text: errorText(e), bad: true }),
  });
  const v = a.visibleTo;
  const above = a.limitedAbove;
  return (
    <section className="card stack" aria-labelledby="article-visible-title">
      <h2 id="article-visible-title">{t('articles.visibleTo.visibleTo')}</h2>
      {v ? (
        <>
          <ul className="plain">
            {v.users.map((u) => (
              <li key={u.id}>
                <UserWho user={u} small />
              </li>
            ))}
            {v.groups.map((g) => (
              <li key={g.id}>{g.name}</li>
            ))}
          </ul>
          <p className="note">{v.users.length || v.groups.length ? t('articles.visibleTo.andNoOneElseBut', { always }) : t('articles.visibleTo.onlyThoseWhoAlwaysSee', { always })}</p>
        </>
      ) : above.length ? null : (
        <p className="note">{t('articles.visibleTo.everyoneWhoSees', { key })}</p>
      )}
      {above.length ? (
        <p className="note">
          {tr('articles.visibleTo.under', {
            n: above.length,
            articles: listNodes(
              above.map((x) => (
                <Link key={x.id} to={`/articles/${x.id}`}>
                  {x.title}
                </Link>
              )),
            ),
          })}
        </p>
      ) : null}
      {editing ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(editing);
          }}
        >
          <LimitPicker value={editing} onChange={setEditing} legend={t('articles.visibleTo.whoElseSeesIt')} always={always} />
          <div className="cluster">
            <button type="submit" className="primary" disabled={save.isPending}>
              {save.isPending ? t('articles.visibleTo.saving') : t('articles.visibleTo.limitItToThem')}
            </button>
            <button type="button" onClick={() => setEditing(null)}>{t('articles.visibleTo.cancel')}</button>
          </div>
        </form>
      ) : canWrite ? (
        <div className="cluster">
          <button type="button" onClick={() => setEditing(limitOf(v) ?? { users: [], groups: [] })}>
            {v ? t('articles.visibleTo.changeWho') : t('articles.visibleTo.limitWhoSeesIt')}
          </button>
          {v ? (
            <button type="button" onClick={() => save.mutate(null)} disabled={save.isPending}>{t('articles.visibleTo.letEveryoneSeeIt')}</button>
          ) : null}
        </div>
      ) : null}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
    </section>
  );
}
