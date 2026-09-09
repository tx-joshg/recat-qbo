import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// Cold imports transpile the complete server graph; each assertion below tests
// the separate simulated schema-validator deadline, not that setup duration.
describe('Recat MCP authored schema startup validation', () => {
  it('allows fresh module startup when static conversion spans hundreds of milliseconds', async () => {
    let simulatedNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 100;
      return simulatedNow;
    });
    vi.resetModules();

    await expect(import('./readTools.js')).resolves.toHaveProperty(
      'createRecatMcpServer',
    );
  }, 20_000);

  it('still fails closed when static conversion exceeds its startup budget', async () => {
    let simulatedNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      simulatedNow += 6_000;
      return simulatedNow;
    });
    vi.resetModules();

    await expect(import('./readTools.js')).rejects.toMatchObject({
      code: 'VALIDATION_TIME',
    });
  });
});
