import { require as tsxRequire } from "tsx/cjs/api";
// The backend is ordinary TypeScript. Load it here, outside Next/React's runtime.
tsxRequire("./worker.ts", import.meta.url);
