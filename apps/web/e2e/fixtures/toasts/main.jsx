// The toast host on a page of its own, for toasts.spec.ts: its timings and keys under a clock the test
// moves. Plain JSX, so the e2e typecheck leaves it to Vite, which serves it with the component it imports.
import '@sreent/ocean/tokens.css';
import '@sreent/ocean/components.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '../../../src/components/Toasts';
import { startI18n } from '../../../src/i18n';

const LONG = 'Moved twenty five issues of the payments project to the next sprint, as their estimates said they would not fit in this one at all.';

function Page() {
  const toasts = useToast();
  const [undone, setUndone] = useState(0);
  const [saved, setSaved] = useState(0);
  const [status, setStatus] = useState('');
  const save = () => {
    const n = saved + 1;
    setSaved(n);
    toasts.show({ words: `Saved ${n}.` });
  };
  const move = () => toasts.show({ words: 'Moved BACK-12 to 3 March.', undo: () => setUndone((n) => n + 1) });
  const cancel = () => {
    setStatus('Cancelled T-1.');
    toasts.show({ words: 'Cancelled T-1.', undo: () => setStatus('T-1 goes on, as it was.'), saidOnPage: true });
  };
  return (
    <main className="stack">
      <h1>Toasts</h1>
      <button type="button" onClick={move}>
        Move it
      </button>
      <button type="button" onClick={save}>
        Save it
      </button>
      <button type="button" onClick={() => toasts.show({ words: LONG })}>
        Say a lot
      </button>
      <button type="button" onClick={cancel}>
        Cancel T-1
      </button>
      <p className="note" role="status">
        {status}
      </p>
      <p>Undone {undone} times</p>
    </main>
  );
}

void startI18n('en').then(() =>
  createRoot(document.getElementById('root')).render(
    <ToastProvider>
      <Page />
    </ToastProvider>,
  ),
);
