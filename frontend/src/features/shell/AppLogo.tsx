import { useId } from "react";
import { cn } from "@/lib/utils";

/** Perforation holes (build/appicon.svg): ten along each edge plus the four corners. */
const EDGE = Array.from({ length: 10 }, (_, i) => 152 + i * 80);
const PERFORATION = [
  ...EDGE.flatMap((a) => [
    [a, 112],
    [a, 912],
    [112, a],
    [912, a],
  ]),
  [112, 112],
  [112, 912],
  [912, 112],
  [912, 912],
];
const WAVES = [262, 316, 370];

/**
 * The app icon (build/appicon.svg) drawn inline: a cobalt perforated postage
 * stamp with a "P" and a postmark. Keep the two in step.
 */
export function AppLogo({ className }: { className?: string }) {
  const id = useId();
  const mask = `${id}-perforation`;
  const face = `${id}-face`;
  return (
    <svg viewBox="82 82 860 860" aria-hidden focusable="false" className={cn("size-8", className)}>
      <defs>
        <mask id={mask}>
          <rect width="1024" height="1024" fill="white" />
          {PERFORATION.map(([cx, cy]) => (
            <circle key={`${cx},${cy}`} cx={cx} cy={cy} r="30" fill="black" />
          ))}
        </mask>
        <clipPath id={face}>
          <rect x="180" y="180" width="664" height="664" rx="8" />
        </clipPath>
      </defs>
      <rect x="112" y="112" width="800" height="800" className="fill-logo-stamp" mask={`url(#${mask})`} />
      <rect x="180" y="180" width="664" height="664" rx="8" className="fill-logo-paper" />
      <g clipPath={`url(#${face})`}>
        <rect x="282" y="340" width="96" height="424" rx="10" className="fill-logo-stamp" />
        <path
          className="fill-logo-stamp"
          fillRule="evenodd"
          d="M330 340 H470 A150 150 0 0 1 470 640 H330 Z M378 424 H462 A66 66 0 0 1 462 556 H378 Z"
        />
        <g opacity="0.72" fill="none" className="stroke-logo-ink">
          <circle cx="600" cy="316" r="96" strokeWidth="16" />
          <circle cx="600" cy="316" r="64" strokeWidth="8" />
          {WAVES.map((y) => (
            <path
              key={y}
              d={`M712 ${y} q 33 -22 66 0 t 66 0 t 66 0`}
              strokeWidth="16"
              strokeLinecap="round"
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
