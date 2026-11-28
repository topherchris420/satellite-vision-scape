import { useEffect, useRef, useState } from "react";

export function SafeCityExit({
  href,
  label,
  save,
}: {
  href: string;
  label: string;
  save: () => Promise<boolean>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const exit = useRef<HTMLButtonElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirm) stay.current?.focus();
  }, [confirm]);

  async function tryExit() {
    setBusy(true);
    const saved = await save().catch(() => false);
    if (!active.current) return;
    setBusy(false);
    if (saved) window.location.assign(href);
    else setConfirm(true);
  }

  return (
    <>
      <button ref={exit} className="city-back" disabled={busy} onClick={tryExit}>
        {label}
      </button>
      {confirm && (
        <div className="city-exit-choice" role="group" aria-label="Unsaved checkpoint">
          <p role="status">Your latest checkpoint may not be saved.</p>
          <div className="city-choices">
            <button
              ref={stay}
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                exit.current?.focus();
              }}
            >
              Stay here
            </button>
            <button disabled={busy} onClick={tryExit}>
              Retry save and leave
            </button>
            <button disabled={busy} onClick={() => window.location.assign(href)}>
              Leave without saving
            </button>
          </div>
        </div>
      )}
    </>
  );
}
