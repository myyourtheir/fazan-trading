import { useEffect } from 'react';
import { strategyApi } from '@/entities/strategy';
import { hasStatus } from '@/shared/api';
import { Alert, AlertTitle, Button } from '@/shared/ui';
import { BacktestForm } from './BacktestForm';

export function BacktestPage(props: { dark: boolean; refreshSession: () => void }) {
  const { refreshSession } = props;
  const [loadProfiles, profiles] = strategyApi.useLazyProfilesQuery();
  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);
  useEffect(() => {
    if (hasStatus(profiles.error, 401)) refreshSession();
  }, [profiles.error, refreshSession]);
  if (profiles.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Не удалось загрузить сохранённые профили стратегий.</AlertTitle>
        <Button variant="outline" onClick={() => void loadProfiles()}>
          Повторить
        </Button>
      </Alert>
    );
  }
  return profiles.data && !profiles.isFetching ? (
    <BacktestForm {...props} config={profiles.data} />
  ) : (
    <p role="status">Загружаем настройки бэктеста…</p>
  );
}
