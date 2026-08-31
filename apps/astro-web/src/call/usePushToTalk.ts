import { useCallback, useEffect, useState, type PointerEventHandler } from 'react';

const PTT_PREF_KEY = 'astro.ptt.enabled';

function readPref(): boolean {
  try {
    return localStorage.getItem(PTT_PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PTT_PREF_KEY, on ? 'true' : 'false');
  } catch {
    /* Safari private mode and similar — preference just won't persist */
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function usePushToTalk({
  active,
  setTransmitting,
}: {
  active: boolean;
  setTransmitting: (on: boolean) => void;
}): {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  held: boolean;
  holdHandlers: {
    onPointerDown: PointerEventHandler<HTMLButtonElement>;
    onPointerUp: PointerEventHandler<HTMLButtonElement>;
    onPointerCancel: PointerEventHandler<HTMLButtonElement>;
    onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
    onContextMenu: PointerEventHandler<HTMLButtonElement>;
  };
} {
  const [enabled, setEnabledState] = useState(readPref);
  const [held, setHeld] = useState(false);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    writePref(on);
  }, []);

  useEffect(() => {
    // Transmit unless PTT is actively gating us. Written as one expression on purpose: every
    // path out of PTT — toggled off, call ended, component unmounted — has to land on a live
    // mic, and separate effects per transition is how one of them gets missed.
    setTransmitting(!active || !enabled || held);
  }, [active, enabled, held, setTransmitting]);

  useEffect(() => {
    if (!active || !enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isEditableTarget(e.target)) return;
      e.preventDefault();
      setHeld(true);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      setHeld(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [active, enabled]);

  useEffect(() => {
    if (!active || !enabled) return;

    const release = () => setHeld(false);
    const onVisibilityChange = () => {
      if (document.hidden) release();
    };

    window.addEventListener('blur', release);
    window.addEventListener('pagehide', release);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('blur', release);
      window.removeEventListener('pagehide', release);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, enabled]);

  const onPointerDown: PointerEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setHeld(true);
  };

  const onPointerUp: PointerEventHandler<HTMLButtonElement> = () => {
    setHeld(false);
  };

  const onPointerCancel: PointerEventHandler<HTMLButtonElement> = () => {
    setHeld(false);
  };

  const onLostPointerCapture: PointerEventHandler<HTMLButtonElement> = () => {
    setHeld(false);
  };

  const onContextMenu: PointerEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
  };

  return {
    enabled,
    setEnabled,
    held,
    holdHandlers: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onLostPointerCapture,
      onContextMenu,
    },
  };
}
