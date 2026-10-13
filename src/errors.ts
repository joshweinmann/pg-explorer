export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT"
}
