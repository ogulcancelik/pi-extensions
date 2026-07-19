export type GateLevel = "guarded" | "convention";

export interface Gate {
  pattern: RegExp;
  level: GateLevel;
  group: string;
  label: string;
  message?: string;
  suggest?: (command: string) => string;
}

export function findGates(command: string, rules: readonly Gate[]): Gate[] {
  return rules.filter((gate) => {
    gate.pattern.lastIndex = 0;
    return gate.pattern.test(command);
  });
}

export function findGate(command: string, rules: readonly Gate[]): Gate | undefined {
  return findGates(command, rules)[0];
}
