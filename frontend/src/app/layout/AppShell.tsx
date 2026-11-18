import { useLayoutEffect } from 'react';
import { Button } from '@/shared/ui';
import { toggleTheme, useAppDispatch, useAppSelector } from '../model/store';
import { SessionGate } from './SessionGate';

export function AppShell() {
  const dark = useAppSelector(state => state.ui.dark);
  const dispatch = useAppDispatch();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-card px-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 py-3">
          <span className="text-lg font-extrabold">Сёрфинг</span>
          <Button variant="outline" onClick={() => dispatch(toggleTheme())}>
            {dark ? 'Светлая тема' : 'Тёмная тема'}
          </Button>
        </div>
      </header>
      <main className="grid justify-items-center px-4 py-6 sm:py-10">
        <SessionGate />
      </main>
    </div>
  );
}
