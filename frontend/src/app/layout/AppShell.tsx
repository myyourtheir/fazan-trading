import { useLayoutEffect } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/shared/ui';
import { toggleTheme, useAppDispatch, useAppSelector } from '../model/store';
import { ProfileMenu } from './ProfileMenu';
import { SessionGate } from './SessionGate';

export function AppShell() {
  const dark = useAppSelector(state => state.ui.dark);
  const dispatch = useAppDispatch();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  return (
    <SessionGate layout={(authenticated, content) => (
      <div className="min-h-dvh">
        <header className="border-b border-border bg-card px-4">
          <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-x-5 gap-y-3 py-3">
            {authenticated
              ? <Link to="/dashboard" className="text-lg font-extrabold hover:text-primary">Сёрфинг</Link>
              : <span className="text-lg font-extrabold">Сёрфинг</span>}
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => dispatch(toggleTheme())}>
                {dark ? 'Светлая тема' : 'Тёмная тема'}
              </Button>
              {authenticated && <ProfileMenu />}
            </div>
          </div>
        </header>
        <main className="grid justify-items-center px-4 py-6 sm:py-8">
          {content}
        </main>
      </div>
    )} />
  );
}
