// The Thread's event stream: calls `onChange` with { rev, presence } on every change, and falls back
// to polling while the stream is down (the browser reconnects it by itself).
export function follow(token, onChange) {
  let source = null;
  let fallback = null;
  const startFallback = () => {
    if (fallback) return;
    fallback = setInterval(() => onChange(null), 4000);
  };
  const stopFallback = () => {
    clearInterval(fallback);
    fallback = null;
  };
  source = new EventSource(`/api/c/${token}/events`);
  source.addEventListener("changed", (event) => {
    stopFallback();
    try {
      onChange(JSON.parse(event.data));
    } catch {
      onChange(null);
    }
  });
  source.addEventListener("error", startFallback);
  return () => {
    source.close();
    stopFallback();
  };
}
