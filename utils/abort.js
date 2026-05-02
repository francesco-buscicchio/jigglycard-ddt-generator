class AbortTaskError extends Error {
  constructor(message = "Operazione annullata.") {
    super(message);
    this.name = "AbortTaskError";
    this.code = "ABORT_TASK";
  }
}

function createAbortError(message) {
  return new AbortTaskError(message);
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.name === "AbortTaskError" ||
    error?.code === "ABORT_ERR" ||
    error?.code === "ABORT_TASK"
  );
}

function resolveAbortReason(signal, fallbackMessage) {
  if (!signal?.aborted) return null;
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof signal.reason === "string" && signal.reason.trim() !== "") {
    return createAbortError(signal.reason);
  }
  return createAbortError(fallbackMessage);
}

function throwIfAborted(signal, fallbackMessage = "Operazione annullata.") {
  const abortReason = resolveAbortReason(signal, fallbackMessage);
  if (abortReason) throw abortReason;
}

function sleep(ms, signal) {
  const safeDelay = Math.max(0, Number(ms) || 0);
  if (safeDelay === 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, safeDelay);

    function onAbort() {
      cleanup();
      reject(resolveAbortReason(signal, "Operazione annullata."));
    }

    function cleanup() {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(resolveAbortReason(signal, "Operazione annullata."));
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

module.exports = {
  AbortTaskError,
  createAbortError,
  isAbortError,
  sleep,
  throwIfAborted,
};
