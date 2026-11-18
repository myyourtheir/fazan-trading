import type { JournalEntry } from '../api/journal-api';

export const brokerStatuses: Record<JournalEntry['brokerStatus'], string> = {
  filled: 'Исполнена', rejected: 'Отклонена', cancelled: 'Отменена',
  new: 'Принята', partial: 'Частично исполнена', unknown: 'Неизвестен',
};
