declare module "@veloxdevworks/flowgraph-tui" {
  export interface LaunchTuiOptions {
    graphPath?: string;
    cwd?: string;
  }
  export function launchTui(opts?: LaunchTuiOptions): Promise<void>;
}
