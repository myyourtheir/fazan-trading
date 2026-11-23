import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { hasStatus } from '@/shared/api';
import {
  Alert,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  NativeSelect,
  NativeSelectOption,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/shared/ui';
import { strategyApi } from '@/entities/strategy';
import { sandboxErrorMessage } from '@/entities/sandbox';
import { StrategyForm, type StrategyAccountProps } from './StrategyForm';

export function StrategySettings({
  settingsHint,
  claimDisabled,
  refreshSession,
  ...props
}: StrategyAccountProps & { settingsHint?: string; claimDisabled: boolean }) {
  const config = strategyApi.useProfilesQuery();
  const [select, selection] = strategyApi.useSelectStrategyMutation();
  const [claim, claiming] = strategyApi.useClaimLegacyMutation();
  const [claimVersion, setClaimVersion] = useState(0);
  useEffect(() => {
    if (
      hasStatus(config.error, 401) ||
      hasStatus(selection.error, 401) ||
      hasStatus(claiming.error, 401)
    )
      refreshSession();
  }, [config.error, selection.error, claiming.error, refreshSession]);

  return (
    <Card
      role="region"
      aria-labelledby="strategy-title"
      className="min-w-0 [--card-spacing:--spacing(5)]"
    >
      <CardHeader>
        <CardTitle>
          <h2 id="strategy-title" className="flex items-center gap-2 font-semibold">
            <SlidersHorizontal aria-hidden="true" className="size-4 text-primary" /> Настройки
            стратегии
          </h2>
        </CardTitle>
        <CardDescription>
          Выберите фьючерс, таймфрейм, период EMA и размер позиции в лотах.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {settingsHint && <p className="text-sm text-muted-foreground">{settingsHint}</p>}
        {config.isLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            Загружаем настройки…
          </p>
        )}
        {config.isError && (
          <>
            <Alert variant="destructive">
              <AlertTitle>Не удалось загрузить настройки стратегии.</AlertTitle>
            </Alert>
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => void config.refetch()}
            >
              Повторить
            </Button>
          </>
        )}
        {config.data && !config.isError && (
          <>
            <label className="grid gap-2 text-sm">
              Стратегия
              <NativeSelect
                value={config.data.selected}
                disabled={!props.accountId || props.disabled || selection.isLoading}
                onChange={(event) => {
                  const kind = event.target.value;
                  if (props.accountId && (kind === 'surfing' || kind === 'improved-surfing'))
                    void select({ accountId: props.accountId, kind });
                }}
              >
                <NativeSelectOption value="surfing">Surfing</NativeSelectOption>
                <NativeSelectOption value="improved-surfing">Улучшенный серфинг</NativeSelectOption>
              </NativeSelect>
            </label>
            {selection.error && (
              <Alert variant="destructive">
                <AlertTitle>{sandboxErrorMessage(selection.error)}</AlertTitle>
              </Alert>
            )}
            {config.data.legacyClaimAvailable && (
              <AlertDialog>
                <AlertDialogTrigger
                  disabled={claimDisabled || claiming.isLoading}
                  render={<Button variant="outline" />}
                >
                  Привязать прежние настройки Surfing
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Привязать прежние настройки?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Прежний профиль будет однократно привязан к вашей учётной записи приложения.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Отмена</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        void claim()
                          .unwrap()
                          .then(async () => {
                            await config.refetch().unwrap();
                            setClaimVersion((v) => v + 1);
                          })
                          .catch(() => {});
                      }}
                    >
                      Подтвердить привязку
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {claiming.error && (
              <Alert variant="destructive">
                <AlertTitle>{sandboxErrorMessage(claiming.error)}</AlertTitle>
              </Alert>
            )}
            <StrategyForm
              key={`${config.data.selected}:${claimVersion}`}
              kind={config.data.selected}
              config={config.data.profiles[config.data.selected]}
              refreshSession={refreshSession}
              {...props}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
