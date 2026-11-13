import { cn } from "@/lib/utils";

/** Centered sidebar message: what's missing and what to do next. */
export function EmptyState({
  icon,
  title,
  body,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center",
        className,
      )}
    >
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <p className="font-medium">{title}</p>
      {body && <p className="max-w-56 text-xs leading-relaxed text-muted-foreground">{body}</p>}
      {children && <div className="mt-2 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}
