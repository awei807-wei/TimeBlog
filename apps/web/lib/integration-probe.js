/**
 * Run a side-effect-free endpoint probe without submitting the surrounding UI.
 * Only the endpoint is passed to the probe; draft secrets remain in the browser.
 *
 * @param {{
 *   event: { preventDefault: () => void },
 *   endpoint: string,
 *   probe: (endpoint: string) => Promise<{ status: string, message: string }>,
 *   onState: (state: { phase: 'testing'|'success'|'error', message: string }) => void,
 * }} options
 */
export async function runEndpointProbe({ event, endpoint, probe, onState }) {
  event.preventDefault();
  const target = endpoint.trim();
  if (!target) {
    onState({ phase: 'error', message: '请先填写要测试的 Endpoint。' });
    return null;
  }

  onState({ phase: 'testing', message: '正在测试当前输入的 Endpoint…' });
  try {
    const result = await probe(target);
    onState({ phase: 'success', message: result.message });
    return result;
  } catch (cause) {
    onState({ phase: 'error', message: cause instanceof Error ? cause.message : '图床探测失败' });
    return null;
  }
}
