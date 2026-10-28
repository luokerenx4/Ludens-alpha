/** Quote argv for the POSIX shell used by the copied initialization command. */
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function driverInitCommand(driver: { id: string; spec: string }): string {
  return `rsa init --driver ${shellQuote(driver.id)} --driver-package ${shellQuote(driver.spec)}`;
}
