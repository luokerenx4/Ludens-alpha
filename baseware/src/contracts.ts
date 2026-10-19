export interface Clock {
  id: string;
  now(): number;
}

export interface Observation {
  id: string;
  controllerId: string;
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
  observations?: Observation[];
}

export interface Controller {
  id: string;
  requiresControl: boolean;
  mediaTypes?: readonly string[];
  help(): string;
  acquire?(epoch: string): Promise<void>;
  execute(argv: readonly string[], context: { epoch?: string; signal: AbortSignal }): Promise<ExecutionResult>;
  release?(epoch: string): Promise<void>;
}

export interface Capabilities {
  controllers: Controller[];
}

export interface ControllerRequest {
  controllerId: string;
  argv: string[];
}
