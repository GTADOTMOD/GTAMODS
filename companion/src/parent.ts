const CHECK_EVERY_MS = 3_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // It's there, just not ours to signal.
  }
}

/** Calls onGone once that process has exited. It's how a companion the mod
 * started stops along with the game, even if the game crashes. */
export function watchParent(
  pid: number,
  onGone: () => void,
  opts: { everyMs?: number; isAlive?: (pid: number) => boolean } = {},
): () => void {
  const isAlive = opts.isAlive ?? processAlive;
  const timer = setInterval(() => {
    if (isAlive(pid)) return;
    clearInterval(timer);
    onGone();
  }, opts.everyMs ?? CHECK_EVERY_MS);
  return () => clearInterval(timer);
}
