const errors: Record<string, string> = {
  SANDBOX_TOKEN_REJECTED: 'Песочница отклонила токен. Проверьте, что токен действителен и даёт доступ к песочнице.',
  SANDBOX_UNREACHABLE: 'Не удалось связаться с песочницей. Попробуйте позже.',
  SANDBOX_TOKEN_UNREADABLE: 'Не удалось прочитать сохранённый токен. Проверьте ключ сервера или введите токен заново.',
  SANDBOX_ACCOUNT_UNAVAILABLE: 'Счёт недоступен или больше не выбран. Обновите список счетов.',
  SANDBOX_OPERATION_REJECTED: 'Песочница отклонила операцию. Проверьте состояние счёта в песочнице.',
  SANDBOX_BUSY: 'Другое изменение ещё выполняется. Попробуйте позже.',
  SANDBOX_ACCOUNT_NOT_FLAT: 'Нельзя сменить счёт или торговые настройки, пока на текущем счёте есть позиции или активные заявки.',
  SANDBOX_ACCOUNT_FLAT_UNVERIFIED: 'Не удалось подтвердить, что на текущем счёте нет позиций и активных заявок. Проверьте счёт в песочнице.',
  SANDBOX_NOT_CONFIGURED: 'Сначала подключите песочницу.',
  SANDBOX_CREATION_UNCERTAIN: 'Создание счёта не подтверждено. Обновите список счетов перед повторной попыткой.',
  SANDBOX_FUNDING_UNCERTAIN: 'Пополнение не подтверждено. Проверьте баланс в песочнице перед повторной попыткой.',
  FUTURE_SELECTION_EXPIRED: 'Повторите поиск фьючерса, затем сохраните стратегию.',
  FUTURE_UNAVAILABLE: 'Этот фьючерс больше недоступен для торговли через API. Выберите другой контракт.',
  ROBOT_SETTINGS_REQUIRED: 'Сначала сохраните настройки стратегии.',
  ROBOT_BUSY: 'Остановите робота и дождитесь завершения текущей операции.',
  ROBOT_POSITION_NOT_FLAT: 'На выбранном инструменте есть открытая позиция. Для первого входа нужна нулевая позиция.',
  ROBOT_POSITION_CHANGED: 'Позиция изменилась до отправки заявки. Проверьте счёт в песочнице.',
  ROBOT_POSITION_UNVERIFIED: 'Не удалось подтвердить позицию по выбранному инструменту.',
  ROBOT_ACTIVE_ORDERS: 'На выбранном счёте есть активные заявки.',
  ROBOT_ORDER_UNRESOLVED: 'Заявка или целевая позиция не подтверждена. Проверьте журнал и счёт в песочнице.',
  ROBOT_FEED_LOST: 'Поток котировок потерян. Торговля приостановлена.',
  ROBOT_TRADE_FAILED: 'Не удалось обработать торговый сигнал. Проверьте журнал.',
  ROBOT_CLOSE_FAILED: 'Не удалось подтвердить ручное закрытие. Проверьте журнал и счёт в песочнице.',
  ROBOT_SELECTION_CHANGED: 'Счёт или инструмент изменился. Проверьте текущие настройки перед закрытием.',
  INVALID_REQUEST: 'Проверьте введённые данные.',
};

export function sandboxMessageFor(code: string) {
  return Object.hasOwn(errors, code) ? errors[code] : 'Не удалось выполнить запрос. Попробуйте позже.';
}

export function sandboxErrorMessage(error: unknown) {
  const data = typeof error === 'object' && error && 'data' in error ? error.data : null;
  return sandboxMessageFor(typeof data === 'object' && data && 'code' in data && typeof data.code === 'string' ? data.code : '');
}
