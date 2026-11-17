import readline from "node:readline";

export function prompt(question: string): Promise<string> {
  return ask(question, false);
}

/** Reads a line without echoing it (for passwords and secret keys). */
export function promptHidden(question: string): Promise<string> {
  return ask(question, true);
}

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    let muted = false;
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    out._writeToOutput = (s: string) => {
      if (!muted) process.stdout.write(s);
      else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    // The question has been written by now; mute what the user types.
    muted = hidden;
  });
}
