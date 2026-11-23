import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
} from '@/shared/ui';
import type { CloseSelection } from '../api/robot-api';

export type CloseTarget = CloseSelection & { ticker: string };

export function ClosePositionDialog({
  target,
  disabled,
  close,
}: {
  target: CloseTarget;
  disabled: boolean;
  close: (selection: CloseSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={disabled} render={<Button variant="destructive" />}>
        Закрыть позицию
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Закрыть позицию по {target.ticker}?</AlertDialogTitle>
          <AlertDialogDescription>
            Счёт: {target.accountId}. Робот сверит фактическую позицию и, если она открыта, отправит
            одну встречную рыночную заявку. Робот останется остановленным.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              close({ accountId: target.accountId, instrumentUid: target.instrumentUid });
            }}
          >
            Подтвердить закрытие
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
