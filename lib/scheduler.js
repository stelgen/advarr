// Advarr — interval scheduler with jitter (±jitterMinutes), 30s tick.
export function createScheduler({ engine, configStore, logger }) {
  let timer = null;
  let nextRunAt = null;

  function scheduleNext(from = Date.now()) {
    const cfg = configStore.data;
    if (!cfg.schedule.enabled) { nextRunAt = null; return null; }
    const base = Math.max(0.1, cfg.schedule.intervalHours || 12) * 3600e3;
    const jitter = (Math.random() * 2 - 1) * Math.max(0, cfg.schedule.jitterMinutes || 0) * 60e3;
    nextRunAt = Math.max(from + 30e3, from + base + jitter);
    return nextRunAt;
  }

  async function tick() {
    const cfg = configStore.data;
    if (!cfg.schedule.enabled || nextRunAt === null) return;
    if (engine.running) return;
    if (Date.now() < nextRunAt) return;
    logger.log('scheduled run triggered');
    try {
      await engine.run();
    } catch { /* engine logs internally */ }
    scheduleNext();
  }

  function start() {
    scheduleNext();
    timer = setInterval(tick, 30e3);
    timer.unref?.();
    const cfg = configStore.data;
    if (cfg.schedule.enabled && cfg.schedule.runOnStart) {
      // fire-and-forget immediate run
      setTimeout(() => {
        engine.run().catch(() => {}).finally(() => scheduleNext());
      }, 1500).unref?.();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start, stop, scheduleNext,
    get nextRunAt() { return nextRunAt; },
    forceRunNow() { nextRunAt = Date.now(); },
  };
}
