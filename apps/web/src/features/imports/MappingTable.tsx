/**
 * Ocean's MappingTable (components/MappingTable): each column of the file, a few of its values, and
 * what it becomes here, marked where a4a found it from the header; and each value of a mapped
 * column (a state, a priority, a person, a sprint) and what it becomes.
 */
import type { Import, ImportProblem, ImportValueMap, ProjectField } from '@a4a/shared';
import { Badge, Chip } from '../../components/Badges';
import { plural } from '../plan/format';
import { t, tr } from '../../i18n';

const FIXED: [string, string][] = [
  ['ignore', t('imports.mappingTable.leaveItOut')],
  ['key', t('imports.mappingTable.itsKeyThereTheImport')],
  ['external-id', t('imports.mappingTable.itsNumericIdThere')],
  ['summary', t('imports.mappingTable.summary')],
  ['description', t('imports.mappingTable.description')],
  ['parent', t('imports.mappingTable.parentByKeyOrId')],
  ['created', t('imports.mappingTable.created')],
  ['updated', t('imports.mappingTable.updated')],
  ['resolved', t('imports.mappingTable.resolved')],
  ['reporter', t('imports.mappingTable.reporter')],
  ['tags', t('imports.mappingTable.tags')],
  ['comment', t('imports.mappingTable.aComment')],
  ['spent', t('imports.mappingTable.timeSpent')],
  ['sprint', t('imports.mappingTable.sprint')],
];

export function targetWords(target: string): string {
  const fixed = FIXED.find(([t]) => t === target);
  if (fixed) return fixed[1];
  if (target.startsWith('field:')) return target.slice(6);
  if (target.startsWith('link:')) return t('imports.mappingTable.aLink', { slice: target.slice(5) });
  return target;
}

/** Where an import's issues come from, in words: the file, or the tracker its API is. */
export const whereFrom = (imp: Import) => (imp.origin ? (imp.origin.kind === 'youtrack' ? 'YouTrack' : t('imports.mappingTable.jira')) : t('imports.mappingTable.theFile'));

export function ColumnsTable({ imp, fields, phrases, onTarget, disabled }: { imp: Import; fields: ProjectField[]; phrases: string[]; onTarget: (index: number, target: string) => void; disabled?: boolean }) {
  const from = whereFrom(imp);
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={imp.origin ? t('imports.mappingTable.whatCameFrom', { from: from }) : t('imports.mappingTable.theFileSColumns')}>
      <table className="figures mapping">
        <caption className="hidden">{tr('imports.mappingTable.eachOfAndWhatIt', { v: imp.origin ? 'field' : 'column', from: from, key: imp.project.key })}</caption>
        <thead>
          <tr>
            <th scope="col">{imp.origin ? t('imports.mappingTable.in', { from: from }) : t('imports.mappingTable.columnInTheFile')}</th>
            <th scope="col">{tr('imports.mappingTable.becomesIn', { key: imp.project.key })}</th>
            <th scope="col">{t('imports.mappingTable.how')}</th>
          </tr>
        </thead>
        <tbody>
          {imp.columns.map((c) => (
            <tr key={c.index}>
              <th scope="row">
                <span className="mapping-name">{c.name || t('imports.mappingTable.column', { v: c.index + 1 })}</span>
                <span className="mapping-samples">{c.filled ? `${c.samples.join(' · ')}${c.filled > c.samples.length ? t('imports.mappingTable.withAValue', { plural: plural(c.filled, 'row') }) : ''}` : t('imports.mappingTable.emptyInEveryRow')}</span>
              </th>
              <td>
                <select aria-label={t('imports.mappingTable.whatBecomes', { name: c.name })} value={c.target} disabled={disabled} onChange={(e) => onTarget(c.index, e.target.value)}>
                  {FIXED.map(([t, words]) => (
                    <option key={t} value={t}>
                      {words}
                    </option>
                  ))}
                  <optgroup label={t('imports.mappingTable.aFieldOfTheProject')}>
                    {fields.map((f) => (
                      <option key={f.fieldId} value={`field:${f.name}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t('imports.mappingTable.aLinkToTheIssue')}>
                    {phrases.map((p) => (
                      <option key={p} value={`link:${p}`}>
                        {p}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </td>
              <td>{c.found ? <Chip>{t('imports.mappingTable.foundFromItsHeader')}</Chip> : c.target === 'ignore' ? <span className="muted">{t('imports.mappingTable.leftOut')}</span> : <span className="muted">{t('imports.mappingTable.chosen')}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ValuesTable({ map, onValue, disabled, from = t('imports.mappingTable.theFile') }: { map: ImportValueMap; onValue: (value: string, to: string | null) => void; disabled?: boolean; from?: string }) {
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={t('imports.mappingTable.itsValues', { label: map.label })}>
      <table className="figures mapping">
        <caption className="hidden">{tr('imports.mappingTable.eachInAndWhatIt', { label: map.label, from: from })}</caption>
        <thead>
          <tr>
            <th scope="col">{tr('imports.mappingTable.in', { from: from })}</th>
            <th scope="col">{t('imports.mappingTable.becomes')}</th>
            <th scope="col">{t('imports.mappingTable.how')}</th>
          </tr>
        </thead>
        <tbody>
          {map.items.map((i) => (
            <tr key={i.value}>
              <th scope="row">
                <span className="mapping-name">{i.value}</span>
                <span className="mapping-count">{plural(i.count, 'row')}</span>
              </th>
              <td>
                <select aria-label={t('imports.mappingTable.whatBecomes2', { value: i.value })} value={i.to ?? ''} disabled={disabled} onChange={(e) => onValue(i.value, e.target.value || null)}>
                  <option value="">{map.empty}</option>
                  {map.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>{i.found ? <Chip>{t('imports.mappingTable.foundByName')}</Chip> : i.to === null ? <Badge tone="warn">{t('imports.mappingTable.nothingHereYet')}</Badge> : <span className="muted">{t('imports.mappingTable.chosen')}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {map.more ? <p className="note">{tr('imports.mappingTable.andMatchedByNameWhere', { plural: plural(map.more, 'more value') })}</p> : null}
    </div>
  );
}

export function ProblemsTable({ problems, caption }: { problems: ImportProblem[]; caption: string }) {
  if (!problems.length) return null;
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={caption}>
      <table className="figures problems">
        <caption className="hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t('imports.mappingTable.row')}</th>
            <th scope="col">{t('imports.mappingTable.key')}</th>
            <th scope="col">{t('imports.mappingTable.what')}</th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p, i) => (
            <tr key={`${p.row}-${i}`}>
              <td>{p.row}</td>
              <td className="mono">{p.key ?? ''}</td>
              <td>
                {p.severity === 'error' ? <Badge tone="bad">{t('imports.mappingTable.notImported')}</Badge> : <Badge tone="warn">{t('imports.mappingTable.importedWithoutIt')}</Badge>} {p.message}
                {p.column ? <span className="problem-hint">{tr('imports.mappingTable.in2', { column: p.column })}</span> : null}
                {p.hint ? <span className="problem-hint">{p.hint}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tally({
  counts,
  label,
  planned,
}: {
  counts: { created: number; updated: number; unchanged: number; skipped: number; failed: number; comments: number; work?: number; files?: number; links: number; linksMissing: number };
  label: string;
  planned?: boolean;
}) {
  const items: [string, number][] = [
    [planned ? t('imports.mappingTable.toCreate') : t('imports.mappingTable.created'), counts.created],
    [planned ? t('imports.mappingTable.toUpdate') : t('imports.mappingTable.updated'), counts.updated],
    [t('imports.mappingTable.unchanged'), counts.unchanged],
    [t('imports.mappingTable.skipped'), counts.skipped],
    [planned ? t('imports.mappingTable.wouldFail') : t('imports.mappingTable.notImported'), counts.failed],
    [t('imports.mappingTable.comments'), counts.comments],
    // An import from an API brings these one by one; a file's spent time comes as one total.
    ...(counts.work !== undefined ? ([[t('imports.mappingTable.workItems'), counts.work]] as [string, number][]) : []),
    ...(counts.files !== undefined ? ([[t('imports.mappingTable.files'), counts.files]] as [string, number][]) : []),
    [t('imports.mappingTable.linksAndParents'), counts.links],
  ];
  return (
    <dl className="import-tally" aria-label={label}>
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
