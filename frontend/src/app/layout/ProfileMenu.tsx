import { Link } from '@tanstack/react-router';
import { CircleUserRound, LogOut, Settings } from 'lucide-react';
import { sessionApi } from '@/shared/api';
import {
  Alert, AlertTitle, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/shared/ui';

export function ProfileMenu() {
  const [logout, { isLoading, error }] = sessionApi.useLogoutMutation();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Профиль" disabled={isLoading} />}>
          <CircleUserRound aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link to="/settings" />}>
            <Settings aria-hidden="true" /> Настройки
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void logout()}>
            <LogOut aria-hidden="true" /> Выйти
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && <Alert variant="destructive" className="fixed right-4 bottom-4 z-50 w-auto max-w-[calc(100%-2rem)]">
        <AlertTitle>Не удалось завершить сессию. Попробуйте ещё раз.</AlertTitle>
      </Alert>}
    </>
  );
}
