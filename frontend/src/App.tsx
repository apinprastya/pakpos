import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell } from "@/features/shell/AppShell";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";

export default function App() {
  useResolvedTheme();
  return (
    <TooltipProvider delayDuration={400}>
      <AppShell />
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
