import { Badge, Button, Spinner } from '@/shared/ui';

export function DashboardHeader({ logout, isLoggingOut }: { logout: () => void; isLoggingOut: boolean }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Песочница</Badge>
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Панель робота</h1>
        <p className="text-sm text-muted-foreground">Настройте подключение и выберите виртуальный счёт.</p>
      </div>
      <Button variant="outline" onClick={logout} disabled={isLoggingOut}>
        {isLoggingOut && <Spinner aria-hidden="true" data-icon="inline-start" />}
        Выйти
      </Button>
    </div>
  );
}
