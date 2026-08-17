function getNextFundingSettlement(now = new Date()) {
    const utc = new Date(now.getTime());
    const hours = [0, 8, 16];
    for (const hour of hours) {
      const candidate = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), hour, 0, 0, 0));
      if (candidate > utc) {
        return candidate;
      }
    }
    return new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate() + 1, 0, 0, 0));
  }

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  }

  function startCountdown(element) {
    if (!element) {
      console.warn("Countdown element not found"); // 优化: DOM 防御性检查
      return null;
    }

    const tick = () => {
      const next = getNextFundingSettlement();
      element.textContent = formatCountdown(next.getTime() - Date.now());
      element.title = `UTC ${next.toISOString().slice(11, 16)}`;
    };

    tick();
    return window.setInterval(tick, 1000);
  }

export const Countdown = {
  getNextFundingSettlement,
  formatCountdown,
  startCountdown,
};
