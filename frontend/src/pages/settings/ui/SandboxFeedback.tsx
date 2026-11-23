import { Alert, AlertTitle } from '@/shared/ui';

export type SandboxNotice = { kind: 'error' | 'success'; text: string };

export function SandboxFeedback({ notice }: { notice?: SandboxNotice }) {
  if (!notice) return null;
  return notice.kind === 'error' ? (
    <Alert variant="destructive">
      <AlertTitle>{notice.text}</AlertTitle>
    </Alert>
  ) : (
    <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary">
      {notice.text}
    </p>
  );
}
