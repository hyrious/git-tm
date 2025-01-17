
let raf = 0, tasks: (() => void)[] = [];

function flush() {
  raf = 0;
  const working = tasks;
  tasks = [];
  for (const task of working) {
    task();
  }
}

export function scheduleInNextFrame(task: () => void) {
  tasks.push(task);
  raf ||= requestAnimationFrame(flush);
}
