// Runs once when the Next.js server starts: start the background job worker.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorker } = await import("./lib/queue");
    startWorker();
  }
}
