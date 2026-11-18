const errors: Record<string, string> = {
  SANDBOX_TOKEN_REJECTED: 'Песочница отклонила токен. Проверьте, что токен действителен и даёт доступ к песочнице.',
  SANDBOX_UNREACHABLE: 'Не удалось связаться с песочницей. Попробуйте позже.',
  SANDBOX_TOKEN_UNREADABLE: 'Не удалось прочитать сохранённый токен. Проверьте ключ сервера или введите токен заново.',
  SANDBOX_ACCOUNT_UNAVAILABLE: 'Счёт недоступен или больше не выбран. Обновите список счетов.',
  SANDBOX_OPERATION_REJECTED: 'Песочница отклонила операцию. Проверьте состояние счёта в песочнице.',
  SANDBOX_BUSY: 'Другое изменение ещё выполняется. Попробуйте позже.',
  SANDBOX_NOT_CONFIGURED: 'Сначала подключите песочницу.',
  SANDBOX_CREATION_UNCERTAIN: 'Создание счёта не подтверждено. Обновите список счетов перед повторной попыткой.',
  SANDBOX_FUNDING_UNCERTAIN: 'Пополнение не подтверждено. Проверьте баланс в песочнице перед повторной попыткой.',
  FUTURE_UNAVAILABLE: 'Этот фьючерс больше недоступен для торговли через API. Выберите другой контракт.',
  INVALID_REQUEST: 'Проверьте введённые данные.',
};

export function sandboxMessageFor(code: string) {
  return Object.hasOwn(errors, code) ? errors[code] : 'Не удалось выполнить запрос. Попробуйте позже.';
}

export function sandboxErrorMessage(error: unknown) {
  const data = typeof error === 'object' && error && 'data' in error ? error.data : null;
  return sandboxMessageFor(typeof data === 'object' && data && 'code' in data && typeof data.code === 'string' ? data.code : '');
}
