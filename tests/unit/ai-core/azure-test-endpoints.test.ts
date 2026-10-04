/** Optional provider adapters preserve Microsoft's Azure v1 and deployment routes, including trailing slashes. */
import { describe, expect, it } from 'vitest';

const { providerEndpoint } = require('../../fixtures/lm-provider-extension/live-provider-adapter.js') as {
  providerEndpoint: (endpoint: string, provider: string, model: string) => string;
};

describe('Azure test endpoints', () => {
  it.each(['', '/', '///'])('normalizes trailing slash variant %j before classifying routes', suffix => {
    const base = 'https://synthetic.openai.azure.com';
    expect(providerEndpoint(`${base}/openai/v1${suffix}?custom=kept`, 'azure', 'deployment'))
      .toBe(`${base}/openai/v1/chat/completions?custom=kept`);
    expect(providerEndpoint(`${base}/openai/v1/chat/completions${suffix}?custom=kept`, 'azure', 'deployment'))
      .toBe(`${base}/openai/v1/chat/completions?custom=kept`);
    expect(providerEndpoint(`${base}${suffix}`, 'azure', 'deployment'))
      .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=2024-10-21`);
    expect(providerEndpoint(`${base}/openai/deployments/deployment${suffix}?api-version=custom`, 'azure', 'deployment'))
      .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=custom`);
    expect(providerEndpoint(`${base}/openai/deployments/deployment/chat/completions${suffix}?api-version=custom`, 'azure', 'deployment'))
      .toBe(`${base}/openai/deployments/deployment/chat/completions?api-version=custom`);
    expect(providerEndpoint(`https://synthetic.example/v1${suffix}`, 'openai-compatible', 'model'))
      .toBe('https://synthetic.example/v1/chat/completions');
  });
  it.each(['not a URL', 'file:///openai/v1/'])('rejects unsupported endpoint %s', endpoint => {
    expect(() => providerEndpoint(endpoint, 'azure', 'deployment')).toThrow();
  });
});
