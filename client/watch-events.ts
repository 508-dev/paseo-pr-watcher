const listeners = new Set<() => void>();

export function watchChanged() {
  for (const listener of listeners) listener();
}

export function onWatchChanged(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
