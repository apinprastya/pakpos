/** Last path segment, for both "/" and "\\" separators. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
