export interface Clock {
  id: string;
  now(): number;
}

export interface Observation {
  id: string;
  sensorId: string;
  mediaType: string;
  path: string;
  timing: { clock: string; requestedAtMs: number; receivedAtMs: number };
  sourceSequence?: number;
}

export interface ExecutionResult {
  id: string;
  status: "completed" | "interrupted" | "failed";
  exitCode: number;
  stdout: string;
  stderr: string;
  timing: { clock: string; requestedAtMs: number; receivedAtMs: number };
}

export interface Sensor {
  id: string;
  mediaTypes: readonly string[];
  help(): string;
  read(argv: readonly string[], signal: AbortSignal): Promise<Observation[]>;
}

export interface Controller {
  id: string;
  help(): string;
  acquire(epoch: string): Promise<void>;
  execute(argv: readonly string[], context: { epoch: string; signal: AbortSignal }): Promise<ExecutionResult>;
  release(epoch: string): Promise<void>;
}

export interface Capabilities {
  sensors: Sensor[];
  controllers: Controller[];
}

export interface ObservationRequest {
  sensorId: string;
  argv: string[];
}
