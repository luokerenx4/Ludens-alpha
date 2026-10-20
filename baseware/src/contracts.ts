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

/** JSON Schema for named parameters or decoded JSON values; never inferred from help text. */
export type JsonSchema = Record<string, unknown>;

export interface CommandSchema {
  /** First argv token; an empty name means no command prefix. */
  name: string;
  description?: string;
  parameters: JsonSchema;
  /** In order: optional flag, then encoded value; joined emits flag=value as one token. */
  bindings: { parameter: string; flag?: string; encoding: "string" | "json"; style?: "joined" }[];
}

export interface Controller {
  id: string;
  requiresControl: boolean;
  mediaTypes?: readonly string[];
  commands?: CommandSchema[];
  /** Schema of JSON.parse(result.stdout), when the driver declares JSON output. */
  stdoutSchema?: JsonSchema;
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
