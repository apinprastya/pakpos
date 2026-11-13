import { modKeyLabel } from "@/lib/platform";

export function ResponsePane() {
  return (
    <section aria-label="Response" className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center border-b px-3 text-sm font-semibold">Response</header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted-foreground">Enter a URL and send the request to see the response here.</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>{modKeyLabel()}</Kbd>
          <Kbd>Enter</Kbd>
          <span className="ml-1">sends from the URL bar</span>
        </p>
      </div>
    </section>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-b-2 bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}
