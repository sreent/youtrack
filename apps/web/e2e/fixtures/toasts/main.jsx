// The toast host on a page of its own, for toasts.spec.ts: nothing in a4a shows a toast yet. Plain JSX,
// so the e2e typecheck leaves it to Vite, which serves it with the component it imports.
import '@sreent/ocean/tokens.css';
import '@sreent/ocean/components.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '../../../src/components/Toasts';
import { startI18n } from '../../../src/i18n';

function Page() {
  const toasts = useToast();
  const [undone, setUndone] = useState(0);
  const [saved, setSaved] = useState(0);
  const save = () => {
    const n = saved + 1;
    setSaved(n);
    toasts.show({ words: `Saved ${n}.` });
  };
  const move = () => toasts.show({ words: 'Moved BACK-12 to 3 March.', action: { label: 'Undo', run: () => setUndone((n) => n + 1) } });
  return (
    <main className="stack">
      <h1>Toasts</h1>
      <button type="button" onClick={move}>
        Move it
      </button>
      <button type="button" onClick={save}>
        Save it
      </button>
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
