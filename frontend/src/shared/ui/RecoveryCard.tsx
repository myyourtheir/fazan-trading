import { Alert, AlertTitle } from './alert';
import { Button } from './button';
import { Card, CardContent, CardFooter } from './card';

export function RecoveryCard({
  message,
  action,
  onRetry,
}: {
  message: string;
  action: string;
  onRetry: () => void;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardContent>
        <Alert variant="destructive">
          <AlertTitle>{message}</AlertTitle>
        </Alert>
      </CardContent>
      <CardFooter>
        <Button onClick={onRetry}>{action}</Button>
      </CardFooter>
    </Card>
  );
}
