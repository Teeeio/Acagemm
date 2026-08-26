const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[?25l\u001b[2J\u001b[3J\u001b[H';
const LEAVE_ALTERNATE_SCREEN = '\u001b[?25h\u001b[?1049l';

export const createTerminalScreenSession = (output = process.stdout) => {
  let active = false;
  return {
    enter() {
      if (active || output?.isTTY !== true) return false;
      output.write(ENTER_ALTERNATE_SCREEN);
      active = true;
      return true;
    },
    leave() {
      if (!active) return false;
      output.write(LEAVE_ALTERNATE_SCREEN);
      active = false;
      return true;
    },
    get active() {
      return active;
    },
  };
};

export const terminalScreenSequences = {
  enter: ENTER_ALTERNATE_SCREEN,
  leave: LEAVE_ALTERNATE_SCREEN,
};
