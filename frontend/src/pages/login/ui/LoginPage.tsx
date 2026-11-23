import { useState, type FormEvent } from 'react';
import { hasStatus, sessionApi } from '@/shared/api';
import {
  Alert,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
} from '@/shared/ui';

export function LoginPage() {
  const [password, setPassword] = useState('');
  const [login, { isLoading, error }] = sessionApi.useLoginMutation();
  const invalidPassword = hasStatus(error, 401);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if ((await login(password)).data) setPassword('');
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <Badge variant="secondary" className="justify-self-start">
          Панель владельца
        </Badge>
        <CardTitle>
          <h1>Вход в fazan-trading</h1>
        </CardTitle>
        <CardDescription>Введите пароль, чтобы открыть панель управления.</CardDescription>
      </CardHeader>
      <CardContent>
        <form id="owner-login" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={invalidPassword || undefined}>
              <FieldLabel htmlFor="password">Пароль</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={256}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={invalidPassword || undefined}
                aria-describedby={invalidPassword ? 'password-error' : undefined}
              />
              {invalidPassword && <FieldError id="password-error">Неверный пароль.</FieldError>}
            </Field>
            {error && !invalidPassword && (
              <Alert variant="destructive">
                <AlertTitle>
                  {hasStatus(error, 429)
                    ? 'Слишком много попыток. Подождите минуту.'
                    : 'Не удалось войти. Попробуйте ещё раз.'}
                </AlertTitle>
              </Alert>
            )}
          </FieldGroup>
        </form>
      </CardContent>
      <CardFooter>
        <Button type="submit" form="owner-login" disabled={isLoading} className="w-full">
          {isLoading && <Spinner aria-hidden="true" data-icon="inline-start" />}
          {isLoading ? 'Входим…' : 'Войти'}
        </Button>
      </CardFooter>
    </Card>
  );
}
