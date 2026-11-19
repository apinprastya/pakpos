import type { TestResult } from "@/lib/model";

/** Passed and counted (non-skipped) tests. */
export function testCounts(tests: TestResult[]): { passed: number; total: number; failed: number } {
  const counted = tests.filter((t) => !t.skipped);
  const passed = counted.filter((t) => t.passed).length;
  return { passed, total: counted.length, failed: counted.length - passed };
}
