/**
 * Ocean's MappingTable (components/MappingTable): each column of the file, a few of its values, and
 * what it becomes here, marked where a4a found it from the header; and each value of a mapped
 * column (a state, a priority, a person, a sprint) and what it becomes.
 */
import type { Import, ImportProblem, ImportValueMap, ProjectField } from '@a4a/shared';
import { Badge, Chip } from '../../components/Badges';
import { plural } from '../plan/format';

const FIXED: [string, string][] = [
  ['ignore', 'Leave it out'],
  ['key', "Its key there (the import's way to find it again)"],
  ['external-id', 'Its numeric id there'],
  ['summary', 'Summary'],
  ['description', 'Description'],
  ['parent', 'Parent, by key or id'],
  ['created', 'Created'],
  ['updated', 'Updated'],
  ['resolved', 'Resolved'],
  ['reporter', 'Reporter'],
  ['tags', 'Tags'],
  ['comment', 'A comment'],
  ['spent', 'Time spent'],
  ['sprint', 'Sprint'],
];

export function targetWords(target: string): string {
  const fixed = FIXED.find(([t]) => t === target);
  if (fixed) return fixed[1];
  if (target.startsWith('field:')) return target.slice(6);
  if (target.startsWith('link:')) return `A link: ${target.slice(5)}`;
  return target;
}

export function ColumnsTable({ imp, fields, phrases, onTarget, disabled }: { imp: Import; fields: ProjectField[]; phrases: string[]; onTarget: (index: number, target: string) => void; disabled?: boolean }) {
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label="The file's columns">
      <table className="figures mapping">
        <caption className="hidden">Each column of the file, and what it becomes in {imp.project.key}</caption>
        <thead>
          <tr>
            <th scope="col">Column in the file</th>
            <th scope="col">Becomes in {imp.project.key}</th>
            <th scope="col">How</th>
          </tr>
        </thead>
        <tbody>
          {imp.columns.map((c) => (
            <tr key={c.index}>
              <th scope="row">
                <span className="mapping-name">{c.name || `Column ${c.index + 1}`}</span>
                <span className="mapping-samples">{c.filled ? `${c.samples.join(' · ')}${c.filled > c.samples.length ? ` · ${plural(c.filled, 'row')} with a value` : ''}` : 'Empty in every row'}</span>
              </th>
              <td>
                <select aria-label={`What "${c.name}" becomes`} value={c.target} disabled={disabled} onChange={(e) => onTarget(c.index, e.target.value)}>
                  {FIXED.map(([t, words]) => (
                    <option key={t} value={t}>
                      {words}
                    </option>
                  ))}
                  <optgroup label="A field of the project">
                    {fields.map((f) => (
                      <option key={f.fieldId} value={`field:${f.name}`}>
                        {f.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="A link, to the issue with this key">
                    {phrases.map((p) => (
                      <option key={p} value={`link:${p}`}>
                        {p}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </td>
              <td>{c.found ? <Chip>Found from its header</Chip> : c.target === 'ignore' ? <span className="muted">Left out</span> : <span className="muted">Chosen</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ValuesTable({ map, onValue, disabled }: { map: ImportValueMap; onValue: (value: string, to: string | null) => void; disabled?: boolean }) {
  return (
    <div className="figures-scroll" tabIndex={0} role="group" aria-label={`${map.label}: its values`}>
      <table className="figures mapping">
        <caption className="hidden">Each {map.label} in the file, and what it becomes</caption>
        <thead>
          <tr>
            <th scope="col">In the file</th>
            <th scope="col">Becomes</th>
            <th scope="col">How</th>
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
                <select aria-label={`What "${i.value}" becomes`} value={i.to ?? ''} disabled={disabled} onChange={(e) => onValue(i.value, e.target.value || null)}>
                  <option value="">{map.empty}</option>
                  {map.choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>{i.found ? <Chip>Found by name</Chip> : i.to === null ? <Badge tone="warn">Nothing here yet</Badge> : <span className="muted">Chosen</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {map.more ? <p className="note">And {plural(map.more, 'more value')}, matched by name where they can be.</p> : null}
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
            <th scope="col">Row</th>
            <th scope="col">Key</th>
            <th scope="col">What</th>
          </tr>
        </thead>
        <tbody>
          {problems.map((p, i) => (
            <tr key={`${p.row}-${i}`}>
              <td>{p.row}</td>
              <td className="mono">{p.key ?? ''}</td>
              <td>
                {p.severity === 'error' ? <Badge tone="bad">Not imported</Badge> : <Badge tone="warn">Imported without it</Badge>} {p.message}
                {p.column ? <span className="problem-hint">In {p.column}</span> : null}
                {p.hint ? <span className="problem-hint">{p.hint}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tally({ counts, label, planned }: { counts: { created: number; updated: number; unchanged: number; skipped: number; failed: number; comments: number; links: number; linksMissing: number }; label: string; planned?: boolean }) {
  const items: [string, number][] = [
    [planned ? 'To create' : 'Created', counts.created],
    [planned ? 'To update' : 'Updated', counts.updated],
    ['Unchanged', counts.unchanged],
    ['Skipped', counts.skipped],
    [planned ? 'Would fail' : 'Not imported', counts.failed],
    ['Comments', counts.comments],
    ['Links and parents', counts.links],
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
