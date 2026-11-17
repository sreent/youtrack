/**
 * A person's days away (docs/architecture.md, D36), in Ocean's Settings: a table of them, past
 * ones quieter, and the form that enters or changes one. Why someone is away shows only to them,
 * administrators and whoever entered it; anyone else sees when.
 */
import type { Absence, AbsenceKind } from '@a4a/shared';
import { useEffect, useId, useState } from 'react';
import { ErrorNote, Loading } from '../../components/States';
import { errorText, FormField, Said, Scroll } from '../common/bits';
import { Confirm } from '../common/Confirm';
import { localToday } from '../plan/dates';
import { useAbsenceChanges, useAbsences } from './api';
import { KIND_WORDS, KINDS, whenWords } from './words';
import { t, tr } from '../../i18n';

export interface Person {
  login: string;
  name: string;
}

type Part = 'day' | 'morning' | 'afternoon';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Whom a sentence is about: you, or them by name; each language says which its own way (D49). */
function whose(person: Person, you: boolean) {
  return { who: you ? 'you' : 'other', name: person.name };
}

function AbsenceForm({ person, you, editing, onDone, onCancel }: { person: Person; you: boolean; editing: Absence | null; onDone: (text: string) => void; onCancel?: () => void }) {
  const id = useId();
  const { add, change } = useAbsenceChanges();
  const today = localToday();
  const [from, setFrom] = useState(editing?.from ?? today);
  const [to, setTo] = useState(editing?.to ?? today);
  const [part, setPart] = useState<Part>(editing?.half ?? 'day');
  const [kind, setKind] = useState<AbsenceKind>(editing?.kind ?? 'holiday');
  const [note, setNote] = useState(editing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFrom(editing?.from ?? today);
    setTo(editing?.to ?? today);
    setPart(editing?.half ?? 'day');
    setKind(editing?.kind ?? 'holiday');
    setNote(editing?.note ?? '');
    setError(null);
  }, [editing, today]);

  // Why, and the note, belong to the person: someone changing days another entered sees neither, and keeps them.
  const seesWhy = !editing || editing.kind !== null;
  const oneDay = !to || to === from;
  const half = oneDay && part !== 'day' ? part : null;
  const busy = add.isPending || change.isPending;
  const w = whose(person, you);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const why = seesWhy ? { kind, note: note.trim() } : {};
      const saved = editing
        ? await change.mutateAsync({ id: editing.id, from, to: to || from, half, ...why, expectedVersion: editing.version })
        : await add.mutateAsync({ user: you ? undefined : person.login, from, to: to || from, half, kind, note: note.trim() || undefined });
      onDone(t(editing ? 'away.daysAway.changedAway' : 'away.daysAway.addedAway', { ...w, whenWords: whenWords(saved), span: oneDay ? 'day' : 'days' }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{editing ? t('away.daysAway.change', { whenWords: whenWords(editing) }) : you ? t('away.daysAway.addDaysAway') : t('away.daysAway.addDaysAwayFor', { name: person.name })}</h3>
      <div className="form-fields">
        <FormField label={t('away.daysAway.from')}>
          {(fid) => (
            <input
              id={fid}
              type="date"
              value={from}
              required
              onChange={(e) => {
                const next = e.target.value;
                // The last day moves with the first while they're the same day, or would come before it.
                if (!to || to === from || to < next) setTo(next);
                setFrom(next);
              }}
            />
          )}
        </FormField>
        <FormField label={t('away.daysAway.to')} help={t('away.daysAway.theLastDayAway')}>
          {(fid, help) => <input id={fid} aria-describedby={help} type="date" value={to} min={from || undefined} required onChange={(e) => setTo(e.target.value)} />}
        </FormField>
      </div>
      {oneDay ? (
        <fieldset className="choice-group">
          <legend>{t('away.daysAway.howMuchOfTheDay')}</legend>
          {(
            [
              ['day', t('away.daysAway.allOfIt')],
              ['morning', t('away.daysAway.theMorning')],
              ['afternoon', t('away.daysAway.theAfternoon')],
            ] as const
          ).map(([value, words]) => (
            <label key={value} className="choice">
              <input type="radio" name={`${id}-part`} value={value} checked={part === value} onChange={() => setPart(value)} />
              <span>{words}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {seesWhy ? (
        <div className="form-fields">
          <FormField label={t('away.daysAway.why')} help={you ? t('away.daysAway.onlyYouAdministratorsAndWhoever') : t('away.daysAway.onlyAdministratorsAndWhoeverEnters', { v: person.name })}>
            {(fid, help) => (
              <select id={fid} aria-describedby={help} value={kind} onChange={(e) => setKind(e.target.value as AbsenceKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_WORDS[k]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField label={t('away.daysAway.aNoteIfYouWant')}>
            {(fid) => <input id={fid} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
          </FormField>
        </div>
      ) : (
        <p className="note">{tr('away.daysAway.whyIsAwayStaysAs', { name: person.name })}</p>
      )}
      {error ? <Said text={error} tone="bad" /> : null}
      <div className="cluster">
        <button type="submit" className="primary" disabled={busy || !from}>
          {busy ? t('away.daysAway.saving') : editing ? t('away.daysAway.saveTheChange') : t('away.daysAway.addTheDaysAway')}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel}>{t('away.daysAway.cancel')}</button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Someone's days away, from a month ago on, and the form to add or change them when the caller
 * may (`canEnter`): their own, or as a manager of a project the person works in, or an administrator.
 */
export function DaysAway({ person, you, canEnter }: { person: Person; you: boolean; canEnter: boolean }) {
  const list = useAbsences(person.login);
  const { remove } = useAbsenceChanges();
  const [editing, setEditing] = useState<Absence | null>(null);
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const today = localToday();
  const w = whose(person, you);
  useEffect(() => {
    setEditing(null);
    setSaid(null);
  }, [person.login]);

  if (list.isLoading) return <Loading what="loadingLine.daysAway" values={w} />;
  if (list.error) return <ErrorNote error={list.error} />;
  const rows = list.data ?? [];

  return (
    <div className="stack">
      {rows.length ? (
        <Scroll label={t('away.daysAway.whoseDaysAwayTitle', w)}>
          <table className="figures middle">
            <thead>
              <tr>
                <th scope="col">{t('away.daysAway.when')}</th>
                <th scope="col">{t('away.daysAway.why')}</th>
                <th scope="col" className="fit">
                  <span className="hidden">{t('away.daysAway.whatYouCanDo')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className={a.to < today ? 'dimmed' : undefined}>
                  <th scope="row" className="row-head">
                    <span className="item-name">{capital(whenWords(a))}</span>
                    {a.createdBy && a.createdBy.login !== person.login ? <span className="item-about">{tr('away.daysAway.enteredBy', { name: a.createdBy.name })}</span> : null}
                  </th>
                  <td>
                    {a.kind ? KIND_WORDS[a.kind] : <span className="muted">{t('away.daysAway.notShownToYou')}</span>}
                    {a.note ? <span className="item-about">{a.note}</span> : null}
                  </td>
                  <td className="fit">
                    {a.canChange ? (
                      <div className="cluster">
                        <button type="button" className="small" aria-label={t('away.daysAway.change', { whenWords: whenWords(a) })} onClick={() => setEditing(a)}>{t('away.daysAway.change2')}</button>
                        <Confirm
                          small
                          label={t('away.daysAway.remove')}
                          name={t('away.daysAway.remove3', { whenWords: whenWords(a) })}
                          title={t('away.daysAway.remove2', { whenWords: whenWords(a) })}
                          about={you ? (a.from === a.to ? t('away.daysAway.plansCountOnYouThatDay') : t('away.daysAway.plansCountOnYouThatTime')) : (a.from === a.to ? t('away.daysAway.plansCountOnThemThatDay', { name: person.name }) : t('away.daysAway.plansCountOnThemThatTime', { name: person.name }))}
                          confirm={t('away.daysAway.removeIt')}
                          disabled={remove.isPending}
                          onConfirm={() =>
                            remove.mutate(a.id, {
                              onSuccess: () => {
                                if (editing?.id === a.id) setEditing(null);
                                setSaid({ text: t('away.daysAway.removedWhoNoLongerAway', { ...w, whenWords: whenWords(a) }) });
                              },
                              onError: (e) => setSaid({ text: errorText(e), bad: true }),
                            })
                          }
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      ) : (
        <p className="note">{tr('away.daysAway.fromAMonthAgoOn', { v: you ? t('away.daysAway.youHaveNoDaysAway') : t('away.daysAway.hasNoDaysAwayEntered', { name: person.name }) })}</p>
      )}
      <Said text={said?.text} tone={said?.bad ? 'bad' : undefined} />
      {canEnter ? (
        <AbsenceForm
          person={person}
          you={you}
          editing={editing}
          onCancel={editing ? () => setEditing(null) : undefined}
          onDone={(text) => {
            setEditing(null);
            setSaid({ text });
          }}
        />
      ) : null}
    </div>
  );
}
