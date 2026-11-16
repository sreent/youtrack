import { useId } from 'react';

/** Ocean's form field: the label's words above its field, tied to it by id. */
export function FormField({ label, children }: { label: React.ReactNode; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
