import { useId, useState } from 'react';
import { Button, Field, FieldGroup, FieldLabel, Input } from '@/shared/ui';

export function FuturesSearchForm({
  initialTicker,
  disabled,
  isFetching,
  search,
}: {
  initialTicker: string;
  disabled: boolean;
  isFetching: boolean;
  search: (term: string) => void;
}) {
  const [input, setInput] = useState(initialTicker);
  const inputId = useId();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const term = input.trim();
        if (!disabled && term) search(term);
      }}
    >
      <FieldGroup className="min-w-0 flex-[1_1_12rem]">
        <Field>
          <FieldLabel htmlFor={inputId}>Поиск фьючерса</FieldLabel>
          <Input
            id={inputId}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Тикер или название"
            maxLength={128}
            required
            disabled={disabled}
          />
        </Field>
      </FieldGroup>
      <Button type="submit" variant="outline" disabled={disabled || !input.trim() || isFetching}>
        Найти
      </Button>
    </form>
  );
}
