export type IntegrationProbeState = {
  phase: 'idle' | 'testing' | 'success' | 'error';
  message: string;
};

export function runEndpointProbe(options: {
  event: { preventDefault: () => void };
  endpoint: string;
  probe: (endpoint: string) => Promise<{ status: string; message: string }>;
  onState: (state: Exclude<IntegrationProbeState, { phase: 'idle' }>) => void;
}): Promise<{ status: string; message: string } | null>;
